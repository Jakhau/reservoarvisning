// Grensesnitt og 3D-visning. All tung regning skjer i worker.js; her tegnes bare resultatet.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const css = navn => getComputedStyle(document.documentElement).getPropertyValue(navn).trim();
  const tall = v => (v == null || v !== v) ? '–' : Number(v).toLocaleString('nb-NO', { maximumSignificantDigits: 4 });
  const hel = v => Math.round(v).toLocaleString('nb-NO');

  const FARGEKART = {
    viridis: ['#440154', '#472d7b', '#3b528b', '#2c728e', '#21918c', '#28ae80', '#5ec962', '#addc30', '#fde725'],
    spektral: ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#ffffbf', '#fee090', '#fdae61', '#f46d43', '#d73027', '#a50026']
  };
  const MANGLER = -1e30;   // NaN kan ikke testes sikkert i GLSL; bruk en vaktverdi

  // ---------- three.js ----------
  const canvas = $('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const kamera = new THREE.PerspectiveCamera(40, 1, 1, 1e6);
  const styring = new THREE.OrbitControls(kamera, canvas);
  styring.enableDamping = true;
  styring.dampingFactor = 0.12;
  const gruppe = new THREE.Group();
  scene.add(gruppe);

  const lutData = new Uint8Array(256 * 4);
  const lut = new THREE.DataTexture(lutData, 256, 1, THREE.RGBAFormat);
  lut.magFilter = lut.minFilter = THREE.LinearFilter;

  const materiale = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    extensions: { derivatives: true },
    uniforms: {
      lut: { value: lut }, vmin: { value: 0 }, vmax: { value: 1 }, logg: { value: 0 },
      kanter: { value: 1 }, kantfarge: { value: new THREE.Color() }
    },
    vertexShader: `
      attribute float verdi;
      attribute vec2 hj;
      varying float vVerdi; varying vec2 vHj; varying vec3 vPos;
      void main() {
        vVerdi = verdi; vHj = hj;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vPos = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D lut;
      uniform float vmin, vmax, logg, kanter;
      uniform vec3 kantfarge;
      varying float vVerdi; varying vec2 vHj; varying vec3 vPos;
      void main() {
        float t = logg > 0.5
          ? (log(max(vVerdi, 1e-30)) - log(vmin)) / max(log(vmax) - log(vmin), 1e-12)
          : (vVerdi - vmin) / max(vmax - vmin, 1e-30);
        vec3 c = texture2D(lut, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb;
        if (vVerdi < -1e29) c = vec3(0.55);
        // Flatenormal fra skjermderiverte: ingen normaler å lagre, og alltid vendt mot kamera.
        vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
        c *= 0.6 + 0.4 * abs(dot(n, normalize(vec3(0.35, 0.55, 0.75))));
        vec2 d = fwidth(vHj);
        vec2 a = smoothstep(vec2(0.0), d * 1.3, min(vHj, 1.0 - vHj));
        float kant = (1.0 - min(a.x, a.y)) * kanter;
        kant *= 1.0 - smoothstep(0.12, 0.45, max(d.x, d.y));   // ton ut når cellene blir små på skjermen
        gl_FragColor = vec4(mix(c, kantfarge, kant * 0.75), 1.0);
      }`
  });

  // Lys for brønnrørene (cellene har egen skyggelegging i shaderen).
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const sol = new THREE.DirectionalLight(0xffffff, 0.55);
  sol.position.set(0.4, 1, 0.6);
  scene.add(sol);
  const bronnGruppe = new THREE.Group();   // skaleres ikke: rørene bygges med overdrivelsen innbakt
  scene.add(bronnGruppe);
  const forkastMat = new THREE.MeshBasicMaterial({
    side: THREE.DoubleSide, transparent: true, opacity: 0.6, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4
  });
  const etiketter = [];

  let mesh = null, markor = null, forkastMesh = null;
  let tegn = true;
  styring.addEventListener('change', () => { tegn = true; });

  function tema() {
    renderer.setClearColor(new THREE.Color(css('--bg3d')));
    materiale.uniforms.kantfarge.value.set(css('--cellekant'));
    if (markor) markor.material.color.set(css('--markor'));
    forkastMat.color.set(css('--forkast'));
    if (grid) byggBronner();
    tegn = true;
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', tema);

  function storrelse() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    kamera.aspect = w / h;
    // Forskyv bildet slik at modellen sentreres i den frie flaten til høyre for panelet.
    const panel = $('panel').offsetWidth;
    if (panel && w > 720) kamera.setViewOffset(w, h, -(panel + 12) / 2, 0, w, h);
    else kamera.clearViewOffset();
    kamera.updateProjectionMatrix();
    tegn = true;
  }
  window.addEventListener('resize', storrelse);

  (function lokke() {
    requestAnimationFrame(lokke);
    styring.update();
    if (tegn) { tegn = false; renderer.render(scene, kamera); plasserEtiketter(); }
  })();

  // ---------- tilstand ----------
  const worker = new Worker('src/worker.js');
  let grid = null;        // metadata og egenskaper fra workeren
  let hud = null;         // siste flatesett: { celle, antFlater, ... }
  let prop = null;        // navn på valgt egenskap
  let venter = false, ko = false, forste = false;
  let hudId = 0;

  function visFeil(tekst) {
    $('opptatt').style.display = 'none';
    $('velkommen').style.display = grid ? 'none' : 'grid';
    const el = $('feil');
    if (grid) { alert(tekst); return; }
    el.textContent = tekst; el.style.display = 'block';
  }

  worker.onerror = e => visFeil('Feil i bakgrunnstråden: ' + e.message);
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'feil') { venter = false; visFeil(m.melding); }
    else if (m.type === 'grid') nyttGrid(m);
    else if (m.type === 'hud') nyHud(m);
  };

  // ---------- lasting ----------
  async function lastFiler(filer) {
    filer = Array.from(filer);
    if (!filer.length) return;
    $('feil').style.display = 'none';
    $('opptatt').style.display = 'block';
    try {
      const data = await Promise.all(filer.map(async f => ({ navn: f.name, buf: await f.arrayBuffer() })));
      worker.postMessage({ type: 'filer', filer: data }, data.map(d => d.buf));
    } catch (err) { visFeil('Kunne ikke lese filene: ' + err.message); }
  }

  function nyttGrid(m) {
    grid = m;
    grid.lesetid = m.tid;
    $('opptatt').style.display = 'none';
    $('velkommen').style.display = 'none';
    $('panel').style.display = 'block';
    $('status').style.display = 'block';
    storrelse();
    $('celle').style.display = 'none';
    $('modellnavn').textContent = m.navn;
    $('modellnavn').title = m.navn;

    const navn = Object.keys(m.props);
    const sel = $('egenskap');
    sel.innerHTML = '';
    for (const p of navn) sel.add(new Option(p, p));
    if (!navn.length) sel.add(new Option('(ingen egenskaper – viser dybde)', ''));
    prop = navn.includes('PORO') ? 'PORO' : (navn[0] || null);
    sel.value = prop || '';

    for (const [a, n] of [['i', m.nx], ['j', m.ny], ['k', m.nz]]) {
      for (const s of [a + '0', a + '1']) { $(s).min = 1; $(s).max = n; $(s).step = 1; }
      $(a + '0').value = 1; $(a + '1').value = n;
    }
    $('fmin').value = ''; $('fmax').value = '';
    $('visGrid').checked = $('visForkast').checked = $('visBronner').checked = true;
    if (mesh) mesh.visible = true;
    bronnGruppe.visible = true;
    $('etiketter').style.display = '';
    byggForkast();
    byggBronner();
    $('radForkast').style.display = m.forkast.antFlater ? '' : 'none';
    $('tekstForkast').textContent = 'Forkastninger (' + m.forkast.navn.length + ')';
    $('radBronner').style.display = $('forklaringBronner').style.display = m.bronner.length ? '' : 'none';
    $('tekstBronner').textContent = 'Brønner (' + m.bronner.length + ')';
    oppdaterUtsnittTekst();
    velgEgenskap(true);
    forste = true;
    bestillHud();
  }

  // ---------- flater ----------
  function filter() {
    const v = id => +$(id).value - 1;
    const f = { i0: v('i0'), i1: v('i1'), j0: v('j0'), j1: v('j1'), k0: v('k0'), k1: v('k1'), propNavn: null };
    const lo = $('fmin').value, hi = $('fmax').value;
    if (prop && (lo !== '' || hi !== '')) {
      f.propNavn = prop;
      f.pmin = lo === '' ? null : +lo;
      f.pmax = hi === '' ? null : +hi;
    }
    return f;
  }

  // Bare én forespørsel om gangen; drar brukeren i en glider, er det alltid siste verdi som gjelder.
  function bestillHud() {
    if (!grid) return;
    if (venter) { ko = true; return; }
    venter = true; ko = false;
    worker.postMessage({ type: 'hud', id: ++hudId, filter: filter() });
  }

  function nyHud(m) {
    venter = false;
    hud = m;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    geo.setAttribute('hj', new THREE.BufferAttribute(m.hj, 2));
    geo.setAttribute('verdi', new THREE.BufferAttribute(new Float32Array(m.antFlater * 4), 1));
    geo.setIndex(new THREE.BufferAttribute(m.idx, 1));
    if (mesh) { mesh.geometry.dispose(); mesh.geometry = geo; }
    else { mesh = new THREE.Mesh(geo, materiale); mesh.frustumCulled = false; gruppe.add(mesh); }
    fyllVerdier();
    fjernMarkor();
    $('status').textContent = grid.nx + ' × ' + grid.ny + ' × ' + grid.nz + ' · ' +
      hel(m.antCeller) + ' av ' + hel(grid.antAktive) + ' celler · ' + hel(m.antFlater) + ' flater · ' +
      Math.round(m.tid) + ' ms';
    if (forste) { forste = false; tilpass(); }
    tegn = true;
    if (ko) bestillHud();
  }

  function fyllVerdier() {
    if (!mesh || !hud) return;
    const ut = mesh.geometry.attributes.verdi.array, celle = hud.celle;
    if (prop) {
      const a = grid.props[prop].data;
      for (let f = 0, w = 0; f < celle.length; f++) {
        let v = a[celle[f]];
        if (v !== v) v = MANGLER;
        ut[w++] = v; ut[w++] = v; ut[w++] = v; ut[w++] = v;
      }
    } else {
      // Uten egenskaper: fargelegg etter dybde (y i 3D er −dybde relativt til origo).
      const pos = mesh.geometry.attributes.position.array;
      for (let v = 0; v < ut.length; v++) ut[v] = grid.origo[2] - pos[3 * v + 1];
    }
    mesh.geometry.attributes.verdi.needsUpdate = true;
    tegn = true;
  }

  // ---------- forkastninger og brønner ----------
  function byggForkast() {
    if (forkastMesh) { gruppe.remove(forkastMesh); forkastMesh.geometry.dispose(); forkastMesh = null; }
    const f = grid.forkast;
    if (!f.antFlater) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(f.pos, 3));
    geo.setIndex(new THREE.BufferAttribute(f.idx, 1));
    forkastMesh = new THREE.Mesh(geo, forkastMat);
    forkastMesh.frustumCulled = false;
    forkastMesh.renderOrder = 2;
    gruppe.add(forkastMesh);
  }

  // Brønnene tegnes som rør. De bygges på nytt når overdrivelsen endres, slik at tverrsnittet
  // forblir rundt. Hvert rør tegnes også svakt gjennom cellene, så banen kan følges inne i modellen.
  function byggBronner() {
    for (const o of bronnGruppe.children.slice()) { bronnGruppe.remove(o); o.geometry.dispose(); o.material.dispose(); }
    $('etiketter').innerHTML = '';
    etiketter.length = 0;
    if (!grid || !grid.bronner.length) return;
    const zs = +$('zs').value, b = grid.bbox;
    const radius = 0.0013 * Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
    for (const w of grid.bronner) {
      const pkt = [];
      for (let i = 0; i < w.punkter.length; i += 3) {
        const v = new THREE.Vector3(w.punkter[i], w.punkter[i + 1] * zs, w.punkter[i + 2]);
        if (!pkt.length || pkt[pkt.length - 1].distanceToSquared(v) > 1e-6) pkt.push(v);
      }
      if (pkt.length < 2) continue;
      const kurve = new THREE.CatmullRomCurve3(pkt, false, 'catmullrom', 0);   // spenning 0 = rette strekk
      const geo = new THREE.TubeGeometry(kurve, (pkt.length - 1) * 6, radius, 8, false);
      const farge = css(w.type === 'I' ? '--inj' : '--prod');
      const ror = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: farge }));
      const gjennom = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: farge, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false }));
      gjennom.renderOrder = 5;
      bronnGruppe.add(ror, gjennom);
      const el = document.createElement('div');
      el.className = 'etikett ' + (w.type === 'I' ? 'inj' : 'prod');
      el.textContent = w.navn;
      $('etiketter').appendChild(el);
      etiketter.push({ el, pos: pkt[0] });
    }
    tegn = true;
  }

  const projisert = new THREE.Vector3();
  function plasserEtiketter() {
    if (!etiketter.length) return;
    const w = window.innerWidth, h = window.innerHeight;
    for (const e of etiketter) {
      projisert.copy(e.pos).project(kamera);
      if (projisert.z > 1 || projisert.z < -1) { e.el.style.display = 'none'; continue; }
      e.el.style.display = '';
      e.el.style.transform = 'translate(' + ((projisert.x + 1) / 2 * w).toFixed(1) + 'px,' +
        ((1 - projisert.y) / 2 * h).toFixed(1) + 'px) translate(-50%,-115%)';
    }
  }

  // ---------- egenskap og fargeskala ----------
  function velgEgenskap(nullstill) {
    prop = $('egenskap').value || null;
    const s = prop ? grid.props[prop] : { min: grid.bbox.z0, max: grid.bbox.z1, minPos: grid.bbox.z0 };
    if (nullstill) {
      $('logg').checked = !!prop && /^(PERM|TRAN|MULT)/.test(prop) && s.minPos != null && s.max / s.minPos > 50;
      // Fire gjeldende siffer holder i feltene; avrund utover så ingen celler faller utenfor skalaen.
      const rund = (v, opp) => {
        if (!v) return 0;
        const e = Math.pow(10, Math.floor(Math.log10(Math.abs(v))) - 3);
        return +((opp ? Math.ceil(v / e) : Math.floor(v / e)) * e).toPrecision(4);
      };
      $('cmin').value = rund($('logg').checked ? s.minPos : s.min, false);
      $('cmax').value = rund(s.max, true);
    }
    $('logg').disabled = s.minPos == null;
    fargeskala();
    fyllVerdier();
  }

  function fargeskala() {
    let lo = +$('cmin').value, hi = +$('cmax').value;
    const logg = $('logg').checked;
    if (logg) {
      const s = prop ? grid.props[prop] : null;
      if (!(lo > 0)) lo = s && s.minPos != null ? s.minPos : 1e-3;
      if (!(hi > lo)) hi = lo * 10;
    } else if (!(hi > lo)) hi = lo + 1e-9;
    const u = materiale.uniforms;
    u.vmin.value = lo; u.vmax.value = hi; u.logg.value = logg ? 1 : 0;
    $('legMin').textContent = tall(lo);
    $('legMax').textContent = tall(hi) + (logg ? ' (log)' : '');
    tegn = true;
  }

  function fargekart() {
    const stopp = FARGEKART[$('fargekart').value].map(h => new THREE.Color(h));
    const ctx = $('legende').querySelector('canvas').getContext('2d');
    const bilde = ctx.createImageData(256, 1);
    for (let i = 0; i < 256; i++) {
      const x = i / 255 * (stopp.length - 1), a = Math.min(stopp.length - 2, Math.floor(x));
      const c = stopp[a].clone().lerp(stopp[a + 1], x - a);
      lutData[4 * i] = c.r * 255; lutData[4 * i + 1] = c.g * 255; lutData[4 * i + 2] = c.b * 255; lutData[4 * i + 3] = 255;
    }
    bilde.data.set(lutData);
    ctx.putImageData(bilde, 0, 0);
    lut.needsUpdate = true;
    tegn = true;
  }

  // ---------- kamera ----------
  function tilpass() {
    if (!mesh) return;
    // Tilpass til det som faktisk tegnes (pilarene kan dekke et mye større område enn de aktive cellene).
    const zs = +$('zs').value;
    mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox;
    const dx = b.max.x - b.min.x, dy = (b.max.y - b.min.y) * zs, dz = b.max.z - b.min.z;
    const r = 0.5 * Math.hypot(dx, dy, dz) || 1;
    const avstand = r / Math.sin(kamera.fov * Math.PI / 360) * 0.8;
    styring.target.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2 * zs, (b.min.z + b.max.z) / 2);
    // Se på tvers av modellens lengste horisontale akse, så den fyller skjermbredden.
    const retning = dz > dx ? new THREE.Vector3(-0.8, 0.5, 0.33) : new THREE.Vector3(-0.33, 0.5, 0.8);
    kamera.position.copy(retning.normalize().multiplyScalar(avstand)).add(styring.target);
    kamera.near = r / 200; kamera.far = r * 60;
    kamera.updateProjectionMatrix();
    styring.update();
    tegn = true;
  }

  function overdrivelse() {
    const zs = +$('zs').value;
    gruppe.scale.y = zs;
    $('zsUt').textContent = zs + '×';
    if (grid) byggBronner();
    tegn = true;
  }

  // ---------- utsnitt ----------
  function oppdaterUtsnittTekst() {
    for (const a of ['i', 'j', 'k']) $(a + 'Ut').textContent = $(a + '0').value + '–' + $(a + '1').value;
  }
  for (const a of ['i', 'j', 'k']) {
    $(a + '0').addEventListener('input', () => {
      if (+$(a + '0').value > +$(a + '1').value) $(a + '1').value = $(a + '0').value;
      oppdaterUtsnittTekst(); bestillHud();
    });
    $(a + '1').addEventListener('input', () => {
      if (+$(a + '1').value < +$(a + '0').value) $(a + '0').value = $(a + '1').value;
      oppdaterUtsnittTekst(); bestillHud();
    });
  }

  // ---------- celleinfo ved klikk ----------
  const stråle = new THREE.Raycaster();
  let ned = null;
  canvas.addEventListener('pointerdown', e => { ned = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', e => {
    if (!ned || !mesh || Math.hypot(e.clientX - ned[0], e.clientY - ned[1]) > 4) return;
    const r = canvas.getBoundingClientRect();
    stråle.setFromCamera({ x: (e.clientX - r.left) / r.width * 2 - 1, y: -(e.clientY - r.top) / r.height * 2 + 1 }, kamera);
    const treff = mesh.visible ? stråle.intersectObject(mesh)[0] : null;
    if (!treff) {
      fjernMarkor();
      // Uten celletreff: se om klikket traff en forkastning (mest aktuelt når cellene er skjult).
      const tf = forkastMesh && forkastMesh.visible ? stråle.intersectObject(forkastMesh)[0] : null;
      if (!tf) { $('celle').style.display = 'none'; return; }
      const dyp = grid.origo[2] - tf.point.y / gruppe.scale.y;
      const tab = document.createElement('table');
      tab.innerHTML = '<tr><td>Forkastning</td><td></td></tr><tr><td>Dybde</td><td>' + tall(dyp) + ' m</td></tr>';
      tab.rows[0].cells[1].textContent = grid.forkast.navn[grid.forkast.eier[tf.faceIndex >> 1]];
      $('celle').replaceChildren(tab);
      $('celle').style.display = 'block';
      return;
    }
    const f = treff.faceIndex >> 1, c = hud.celle[f];
    const i = c % grid.nx, j = Math.floor(c / grid.nx) % grid.ny, k = Math.floor(c / (grid.nx * grid.ny));
    const dybde = grid.origo[2] - treff.point.y / gruppe.scale.y;
    let h = '<table><tr><td>Celle (I, J, K)</td><td>' + (i + 1) + ', ' + (j + 1) + ', ' + (k + 1) + '</td></tr>' +
      '<tr><td>Dybde</td><td>' + tall(dybde) + ' m</td></tr>';
    for (const p of Object.keys(grid.props)) h += '<tr><td>' + p + '</td><td>' + tall(grid.props[p].data[c]) + '</td></tr>';
    $('celle').innerHTML = h + '</table>';
    $('celle').style.display = 'block';
    settMarkor(f);
  });

  function fjernMarkor() {
    if (markor) { gruppe.remove(markor); markor.geometry.dispose(); markor = null; tegn = true; }
  }
  function settMarkor(f) {
    fjernMarkor();
    const pos = mesh.geometry.attributes.position.array.slice(12 * f, 12 * f + 12);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    // Fylt, halvgjennomsiktig flate: en 1 px linje forsvinner på små celler.
    markor = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: css('--markor'), side: THREE.DoubleSide, transparent: true, opacity: 0.75, depthTest: false }));
    markor.renderOrder = 10;
    gruppe.add(markor);
    tegn = true;
  }

  // ---------- hendelser ----------
  $('egenskap').addEventListener('change', () => {
    const haddeFilter = $('fmin').value !== '' || $('fmax').value !== '';
    $('fmin').value = ''; $('fmax').value = '';
    velgEgenskap(true);
    if (haddeFilter) bestillHud();
  });
  $('cmin').addEventListener('input', fargeskala);
  $('cmax').addEventListener('input', fargeskala);
  $('logg').addEventListener('change', () => velgEgenskap(false));
  $('auto').addEventListener('click', () => velgEgenskap(true));
  $('fargekart').addEventListener('change', fargekart);
  $('fmin').addEventListener('input', bestillHud);
  $('fmax').addEventListener('input', bestillHud);
  $('zs').addEventListener('input', overdrivelse);
  $('kanter').addEventListener('change', () => { materiale.uniforms.kanter.value = $('kanter').checked ? 1 : 0; tegn = true; });
  $('visGrid').addEventListener('change', () => { if (mesh) mesh.visible = $('visGrid').checked; fjernMarkor(); tegn = true; });
  $('visForkast').addEventListener('change', () => { if (forkastMesh) forkastMesh.visible = $('visForkast').checked; tegn = true; });
  $('visBronner').addEventListener('change', () => {
    bronnGruppe.visible = $('visBronner').checked;
    $('etiketter').style.display = $('visBronner').checked ? '' : 'none';
    tegn = true;
  });
  $('tilpass').addEventListener('click', tilpass);
  $('apne').addEventListener('click', () => $('fil').click());
  $('velg').addEventListener('click', () => $('fil').click());
  $('fil').addEventListener('change', e => { lastFiler(e.target.files); e.target.value = ''; });
  $('demo').addEventListener('click', () => {
    $('opptatt').style.display = 'block';
    worker.postMessage({ type: 'demo', nx: 60, ny: 80, nz: 20 });
  });

  let dra = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dra++; $('slipp').style.display = 'grid'; });
  window.addEventListener('dragleave', () => { if (--dra <= 0) { dra = 0; $('slipp').style.display = 'none'; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); dra = 0; $('slipp').style.display = 'none';
    lastFiler(e.dataTransfer.files);
  });

  tema(); storrelse(); fargekart(); overdrivelse();

  // For feilsøking og automatisk testing i nettleseren.
  window.APP = { worker, get grid() { return grid; }, get hud() { return hud; }, kamera, tilpass };
})();
