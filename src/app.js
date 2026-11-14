// Grensesnitt og 3D-visning. All tung regning skjer i worker.js; her tegnes bare resultatet.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const css = navn => getComputedStyle(document.documentElement).getPropertyValue(navn).trim();
  const tall = v => (v == null || v !== v) ? '–' : Number(v).toLocaleString('nb-NO', { maximumSignificantDigits: 4 });
  const hel = v => Math.round(v).toLocaleString('nb-NO');
  const dato = t => new Date(t).toLocaleDateString('nb-NO', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const sett = (id, v) => { $(id).value = +(+v).toPrecision(4); };

  const FARGEKART = {
    viridis: ['#440154', '#472d7b', '#3b528b', '#2c728e', '#21918c', '#28ae80', '#5ec962', '#addc30', '#fde725'],
    // Divergerende: to farger rundt et nøytralt grått midtpunkt (null endring).
    endring: ['#2166ac', '#67a9cf', '#c3d9e8', '#dcdcdc', '#f0c9b4', '#ef8a62', '#b2182b'],
    spektral: ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#ffffbf', '#fee090', '#fdae61', '#f46d43', '#d73027', '#a50026']
  };
  // Klassefarger for heltallsegenskaper (regioner, tabellnumre).
  const KLASSER = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2', '#edc948', '#ff9da7', '#9c755f', '#bab0ac', '#1b9e77', '#7570b3'];
  function fargeAv(stopp, t) {
    const x = Math.max(0, Math.min(1, t)) * (stopp.length - 1), a = Math.min(stopp.length - 2, Math.floor(x));
    return new THREE.Color(stopp[a]).lerp(new THREE.Color(stopp[a + 1]), x - a);
  }

  // ---------- three.js ----------
  const canvas = $('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const kamera = new THREE.PerspectiveCamera(40, 1, 1, 1e6);
  const styring = new THREE.OrbitControls(kamera, canvas);
  styring.enableDamping = true;
  styring.dampingFactor = 0.12;
  const gruppe = new THREE.Group();        // skaleres med vertikal overdrivelse
  const bronnGruppe = new THREE.Group();   // skaleres ikke: rørene bygges med overdrivelsen innbakt
  const hjelpGruppe = new THREE.Group();   // snittlinje under tegning
  scene.add(gruppe, bronnGruppe, hjelpGruppe);
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const sol = new THREE.DirectionalLight(0xffffff, 0.55);
  sol.position.set(0.4, 1, 0.6);
  scene.add(sol);

  const lutData = new Uint8Array(256 * 4);
  const lut = new THREE.DataTexture(lutData, 256, 1, THREE.RGBAFormat);

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
        vec3 c = texture2D(lut, vec2(clamp(t, 0.002, 0.998), 0.5)).rgb;
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

  // Plukking på GPU: flatenummeret tegnes som farge i ett piksel under pekeren. Hver firkant har
  // fire hjørner etter hverandre, så nummeret er gl_VertexID / 4. Tiden er uavhengig av modellstørrelsen.
  const plukkMal = new THREE.WebGLRenderTarget(1, 1);
  const plukkMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, blending: THREE.NoBlending,
    vertexShader: `
      flat varying vec4 vId;
      void main() {
        int id = gl_VertexID / 4 + 1;
        vId = vec4(float(id & 255), float((id >> 8) & 255), float((id >> 16) & 255), float((id >> 24) & 255)) / 255.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `flat varying vec4 vId; void main() { gl_FragColor = vId; }`
  });

  const forkastMat = new THREE.MeshBasicMaterial({
    side: THREE.DoubleSide, transparent: true, opacity: 0.6, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4
  });
  const sprangMat = forkastMat.clone();
  sprangMat.vertexColors = true; sprangMat.opacity = 0.85;
  const rammeMat = new THREE.LineBasicMaterial();
  const linjeMat = new THREE.LineBasicMaterial({ depthTest: false });

  let mesh = null, markor = null, forkastMesh = null, ramme = null, snittLinje = null;
  let forkastQuads = null;       // firkantnummer i samme rekkefølge som indeksen (for klikk)
  const etiketter = [];          // { el, pos, skaler, bronn }
  let tegn = true;
  styring.addEventListener('change', () => { tegn = true; });

  // ---------- tilstand ----------
  const worker = new Worker('src/worker.js');
  let grid = null;        // metadata fra workeren
  let hud = null;         // siste flatesett
  let prop = null;        // navn på valgt egenskap
  let stat = null;        // statistikk for valgt egenskap
  let steg = 0;           // tidssteg
  let linje = null;       // snittlinje [[x, z], …] i 3D-koordinater
  let tegner = null;      // punkter mens en snittlinje tegnes
  let diskret = false, nullstill = false, kartNokkel = '';
  let venter = false, ko = false, forste = false, hudId = 0, celleId = 0, spiller = null;
  const skjult = { bronn: new Set(), forkast: new Set() };
  const zs = () => +$('zs').value;
  const naa = () => (grid && grid.tider.length ? grid.tider[steg] : Infinity);
  const erDynamisk = () => !!grid && grid.props.some(p => p.navn === prop && p.dynamisk);
  const kartModus = () => $('modus').value.startsWith('kart');

  function tema() {
    renderer.setClearColor(new THREE.Color(css('--bg3d')));
    materiale.uniforms.kantfarge.value.set(css('--cellekant'));
    forkastMat.color.set(css('--forkast'));
    rammeMat.color.set(css('--ramme'));
    linjeMat.color.set(css('--markor'));
    if (markor) markor.material.color.set(css('--markor'));
    if (grid) { byggBronner(); if (stat) tegnHisto(); KURVEPANEL.tegn(); }
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
    if (tegn) { tegn = false; renderer.render(scene, kamera); plasserEtiketter(); dreiKompass(); }
  })();

  function visFeil(tekst) {
    $('opptatt').style.display = 'none';
    if (grid) { alert(tekst); return; }
    $('velkommen').style.display = 'grid';
    $('feil').textContent = tekst; $('feil').style.display = 'block';
  }
  worker.onerror = e => visFeil('Feil i bakgrunnstråden: ' + e.message);
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'feil') { venter = false; visFeil(m.melding); }
    else if (m.type === 'grid') nyttGrid(m);
    else if (m.type === 'hud') nyHud(m);
    else if (m.type === 'stat') nyStat(m);
    else if (m.type === 'celle') visCelle(m);
    else if (m.type === 'kurver') nyeKurver(m);
  };

  // ---------- lasting ----------
  function lastFiler(filer) {
    filer = Array.from(filer);
    if (!filer.length) return;
    sisteFiler = filer;
    $('feil').style.display = 'none';
    $('opptatt').style.display = 'block';
    worker.postMessage({ type: 'filer', filer });   // File-objektene leses i bakgrunnstråden
  }

  function nyttGrid(m) {
    stoppSpill();
    grid = m; hud = null; stat = null; linje = null; steg = 0; forste = true; kartNokkel = '';
    skjult.bronn.clear(); skjult.forkast.clear();
    avbrytTegning();
    $('opptatt').style.display = 'none';
    $('velkommen').style.display = 'none';
    $('panel').style.display = 'block';
    $('status').style.display = 'block';
    $('kompass').style.display = 'block';
    $('celle').style.display = 'none';
    $('modellnavn').textContent = m.navn; $('modellnavn').title = m.navn;
    ventSkala = ventKamera = null; visVisninger();
    fyllKurveValg();
    $('advarsel').textContent = m.advarsler.join(' ');
    $('advarsel').style.display = m.advarsler.length ? 'block' : 'none';
    storrelse();

    const sel = $('egenskap');
    sel.innerHTML = '';
    for (const p of m.props) sel.add(new Option(p.navn + (p.dynamisk ? '  (tid)' : ''), p.navn));
    const navn = m.props.map(p => p.navn);
    prop = ['PRESSURE', 'PORO'].find(n => navn.includes(n)) || navn[0];
    sel.value = prop;

    for (const [a, n] of [['i', m.nx], ['j', m.ny], ['k', m.nz]]) {
      for (const s of [a + '0', a + '1']) { $(s).min = 1; $(s).max = n; $(s).step = 1; }
      $(a + '0').value = 1; $(a + '1').value = n;
    }
    $('filtre').innerHTML = ''; nyFilterRad();
    $('endring').checked = false; fyllRefSteg(); oppdaterEndring();
    $('modus').value = 'celler'; $('snittvalg').style.display = 'none';
    $('visGrid').checked = $('visForkast').checked = $('visBronner').checked = $('visRamme').checked = true;
    $('sprang').checked = false; $('forkastModus').value = 'hel';
    bronnGruppe.visible = true;
    if (mesh) mesh.visible = true;

    $('dTid').style.display = m.tider.length > 1 ? '' : 'none';
    $('tid').max = Math.max(0, m.tider.length - 1); $('tid').value = 0;
    oppdaterTidTekst();

    const harF = m.forkast.antFlater > 0, harB = m.bronner.length > 0;
    $('radForkast').style.display = $('dForkast').style.display = harF ? '' : 'none';
    $('radBronner').style.display = $('dBronner').style.display = harB ? '' : 'none';
    $('tekstForkast').textContent = 'Forkastninger (' + m.forkast.navn.length + ')';
    $('tekstBronner').textContent = 'Brønner (' + m.bronner.length + ')';
    fyllListe('listeBronner', m.bronner.map(w => w.navn), 'bronn');
    fyllListe('listeForkast', m.forkast.navn, 'forkast');
    const sb = $('snittBronn');
    sb.innerHTML = '';
    sb.add(new Option(harB ? 'Snitt langs brønn …' : '(ingen brønner)', ''));
    m.bronner.forEach((w, i) => sb.add(new Option(w.navn, i)));
    sb.disabled = !harB;
    // Skala for sprangfarger: 98-prosentilen, så enkeltflater med ekstremt sprang ikke dominerer.
    const sp = Array.from(m.forkast.hel.sprang).filter(v => v > 0).sort((a, b) => a - b);
    grid.maksSprang = sp.length ? sp[Math.floor(0.98 * (sp.length - 1))] : 1;
    $('tekstSprang').textContent = 'Farge etter sprang (0–' + tall(grid.maksSprang) + ' m)';

    oppdaterUtsnittTekst();
    byggForkast();
    byggBronner();
    velgEgenskap(true);
    bestillHud();
  }

  function fyllListe(id, navn, slag) {
    const el = $(id);
    el.innerHTML = '';
    navn.forEach((n, i) => {
      const l = document.createElement('label'), c = document.createElement('input');
      c.type = 'checkbox'; c.checked = true; c.dataset.nr = i;
      c.addEventListener('change', () => { if (c.checked) skjult[slag].delete(i); else skjult[slag].add(i); oppdaterSlag(slag); });
      l.append(c, n); l.title = n;
      el.appendChild(l);
    });
  }
  function oppdaterSlag(slag) { if (slag === 'bronn') byggBronner(); else byggForkast(); }
  for (const knapp of document.querySelectorAll('[data-alle],[data-ingen]')) {
    knapp.addEventListener('click', () => {
      const slag = knapp.dataset.alle || knapp.dataset.ingen, vis = !!knapp.dataset.alle;
      const bokser = $(slag === 'bronn' ? 'listeBronner' : 'listeForkast').querySelectorAll('input');
      skjult[slag].clear();
      bokser.forEach((c, i) => { c.checked = vis; if (!vis) skjult[slag].add(i); });
      oppdaterSlag(slag);
    });
  }

  // ---------- flater ----------
  function filter() {
    const v = id => +$(id).value - 1;
    const f = { i0: v('i0'), i1: v('i1'), j0: v('j0'), j1: v('j1'), k0: v('k0'), k1: v('k1'), modus: 'celler', filtrer: false };
    f.filtre = filterRader();
    const m = $('modus').value;
    if (m === 'snitt' && linje) { f.modus = 'snitt'; f.linje = linje; }
    else if (m.startsWith('kart')) { f.modus = 'kart'; f.kart = m.split(':')[1]; }
    return f;
  }

  // Bare én forespørsel om gangen; drar brukeren i en glider, er det alltid siste verdi som gjelder.
  function bestillHud() {
    if (!grid) return;
    if (venter) { ko = true; return; }
    venter = true; ko = false;
    worker.postMessage({ type: 'hud', id: ++hudId, filter: filter(), prop, steg, ref: refSteg() });
  }

  function nyHud(m) {
    venter = false;
    hud = m;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    geo.setAttribute('hj', new THREE.BufferAttribute(m.hj, 2));
    geo.setAttribute('verdi', new THREE.BufferAttribute(m.verdi, 1));
    geo.setIndex(new THREE.BufferAttribute(m.idx, 1));
    if (mesh) { mesh.geometry.dispose(); mesh.geometry = geo; }
    else { mesh = new THREE.Mesh(geo, materiale); mesh.frustumCulled = false; gruppe.add(mesh); }
    fjernMarkor();
    $('status').textContent = grid.nx + ' × ' + grid.ny + ' × ' + grid.nz + ' · ' +
      hel(m.antCeller) + ' av ' + hel(grid.antAktive) + ' celler · ' + hel(m.antFlater) + ' flater · ' + Math.round(m.tid) + ' ms' +
      (grid.enhet && grid.enhet !== 'METRIC' ? ' · omregnet fra ' + grid.enhet + ' til SI' : '');
    visVolum(m.volum);
    if (m.omrade) {
      // Kartverdier har et annet verdiområde enn egenskapen selv; sett skalaen når kartet skifter.
      const nokkel = $('modus').value + '|' + prop;
      if (nokkel !== kartNokkel) { kartNokkel = nokkel; sett('cmin', m.omrade.min); sett('cmax', m.omrade.max); }
      fargeskala();
    }
    if (forste && m.antFlater) { forste = false; if (!ramme) byggRamme(); tilpass(false); }
    // En lagret visning eller lenke settes først når flatene den gjelder, er på plass.
    if (!ko) {
      if (ventSkala) { brukSkala(ventSkala); ventSkala = null; }
      if (ventKamera) { settKamera(ventKamera); ventKamera = null; }
      if (ventLenke) { const t = ventLenke; ventLenke = null; brukTilstand(t); }
    }
    tegn = true;
    if (ko) bestillHud();
  }

  function visVolum(v) {
    const mm = x => x == null ? '–' : tall(x / 1e6) + ' Mm³';
    $('volum').innerHTML =
      '<tr><td>Bulkvolum</td><td>' + mm(v.bulk) + '</td></tr>' +
      '<tr><td>Porevolum</td><td>' + mm(v.pv) + '</td></tr>' +
      '<tr><td>HCPV' + (v.swNavn ? ' (Sw fra ' + v.swNavn + ')' : '') + '</td><td>' + mm(v.hcpv) + '</td></tr>' +
      (v.olje == null ? '' : '<tr><td>– olje</td><td>' + mm(v.olje) + '</td></tr><tr><td>– gass</td><td>' + mm(v.gass) + '</td></tr>');
  }

  // ---------- egenskap, fargeskala og histogram ----------
  function velgEgenskap(ny) {
    prop = $('egenskap').value;
    nullstill = nullstill || ny;
    worker.postMessage({ type: 'stat', prop, steg, ref: refSteg() });
  }

  function nyStat(m) {
    if (m.prop !== prop || !m.stat) return;
    stat = m.stat;
    if (nullstill) {
      nullstill = false;
      $('logg').checked = /^(PERM|TRAN)/.test(prop) && stat.minPos != null && stat.max / stat.minPos > 50;
      nullstillSkala();
    }
    if (ventSkala) brukSkala(ventSkala, true);
    lagLut();
    fargeskala();
  }

  // Fire gjeldende siffer holder i feltene; avrund utover så ingen celler faller utenfor skalaen.
  function rund(v, opp) {
    if (!v) return 0;
    const e = Math.pow(10, Math.floor(Math.log10(Math.abs(v))) - 3);
    return +((opp ? Math.ceil(v / e) : Math.floor(v / e)) * e).toPrecision(4);
  }
  function nullstillSkala() {
    if (!stat) return;
    if (stat.endring) {   // symmetrisk rundt null, så grått betyr «ingen endring»
      const m = rund(Math.max(Math.abs(stat.min), Math.abs(stat.max)) || 1e-6, true);
      $('cmin').value = -m; $('cmax').value = m;
      return;
    }
    $('cmin').value = rund($('logg').checked ? stat.minPos : stat.min, false);
    $('cmax').value = rund(stat.max, true);
  }

  // Heltallsegenskaper med få klasser får én farge per klasse i stedet for en glidende skala.
  function lagLut() {
    const u = stat && !kartModus() ? stat.unike : null;
    const klasser = u ? u[u.length - 1] - u[0] + 1 : 0;
    diskret = klasser > 0 && klasser <= 256;
    const stopp = FARGEKART[$('fargekart').value];
    for (let i = 0; i < 256; i++) {
      const c = diskret ? new THREE.Color(KLASSER[Math.floor(i / 256 * klasser) % KLASSER.length]) : fargeAv(stopp, i / 255);
      lutData[4 * i] = c.r * 255; lutData[4 * i + 1] = c.g * 255; lutData[4 * i + 2] = c.b * 255; lutData[4 * i + 3] = 255;
    }
    lut.magFilter = lut.minFilter = diskret ? THREE.NearestFilter : THREE.LinearFilter;
    lut.needsUpdate = true;
    const ctx = $('legende').querySelector('canvas').getContext('2d'), bilde = ctx.createImageData(256, 1);
    bilde.data.set(lutData);
    ctx.putImageData(bilde, 0, 0);
    for (const id of ['cmin', 'cmax', 'auto', 'fargekart']) $(id).disabled = diskret;
    $('logg').disabled = diskret || kartModus() || !stat || stat.minPos == null;
    tegn = true;
  }

  function skala() {
    if (diskret) return { lo: stat.unike[0] - 0.5, hi: stat.unike[stat.unike.length - 1] + 0.5, logg: false };
    let lo = +$('cmin').value, hi = +$('cmax').value;
    const logg = $('logg').checked && !kartModus();
    if (logg) {
      if (!(lo > 0)) lo = stat && stat.minPos != null ? stat.minPos : 1e-3;
      if (!(hi > lo)) hi = lo * 10;
    } else if (!(hi > lo)) hi = lo + 1e-9;
    return { lo, hi, logg };
  }

  function fargeskala() {
    const s = skala(), u = materiale.uniforms;
    u.vmin.value = s.lo; u.vmax.value = s.hi; u.logg.value = s.logg ? 1 : 0;
    if (diskret) {
      $('legMin').textContent = stat.unike[0];
      $('legMax').textContent = stat.unike[stat.unike.length - 1] + ' (' + stat.unike.length + ' klasser)';
    } else {
      $('legMin').textContent = tall(s.lo);
      $('legMax').textContent = tall(s.hi) + (s.logg ? ' (log)' : '');
    }
    tegnHisto();
    tegn = true;
  }

  // Histogrammets x-akse er egenskapens hele verdiområde; de to strekene er grensene i fargeskalaen.
  function histoAkse() {
    const logg = $('logg').checked && stat.minPos != null;
    const lo = logg ? stat.minPos : stat.min, hi = stat.max > lo ? stat.max : lo + 1;
    return {
      logg, lo, hi,
      x: v => logg ? (Math.log(Math.max(v, lo * 1e-6)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) : (v - lo) / (hi - lo),
      v: x => logg ? Math.exp(Math.log(lo) + x * (Math.log(hi) - Math.log(lo))) : lo + x * (hi - lo)
    };
  }
  function tegnHisto() {
    const c = $('histo'), ctx = c.getContext('2d'), W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (!stat || kartModus()) { c.style.display = 'none'; return; }
    c.style.display = 'block';
    const a = histoAkse(), s = skala();
    const hist = a.logg && stat.histLog ? stat.histLog : stat.hist, N = hist.length;
    // For egenskaper som endres med tid dekker søylene verdiområdet i valgt tidssteg.
    const h0 = a.logg ? (stat.histMinPos || a.lo) : (stat.histMin != null ? stat.histMin : stat.min);
    const h1 = stat.histMax != null ? stat.histMax : stat.max;
    const maks = Math.max(1, ...hist);
    for (let b = 0; b < N; b++) {
      if (!hist[b]) continue;
      const v0 = a.logg ? h0 * Math.pow(h1 / h0, b / N) : h0 + (h1 - h0) * b / N;
      const v1 = a.logg ? h0 * Math.pow(h1 / h0, (b + 1) / N) : h0 + (h1 - h0) * (b + 1) / N;
      const x0 = a.x(v0) * W, x1 = Math.max(x0 + 1, a.x(v1) * W), hh = Math.max(1, Math.sqrt(hist[b] / maks) * (H - 2));
      const vm = (v0 + v1) / 2;
      const t = s.logg ? (Math.log(Math.max(vm, 1e-30)) - Math.log(s.lo)) / (Math.log(s.hi) - Math.log(s.lo)) : (vm - s.lo) / (s.hi - s.lo);
      const i = Math.max(0, Math.min(255, Math.round(t * 255)));
      ctx.fillStyle = 'rgb(' + lutData[4 * i] + ',' + lutData[4 * i + 1] + ',' + lutData[4 * i + 2] + ')';
      ctx.fillRect(x0, H - hh, x1 - x0 - 0.5, hh);
    }
    if (diskret) return;
    ctx.fillStyle = css('--tekst');
    for (const v of [s.lo, s.hi]) ctx.fillRect(Math.max(0, Math.min(W - 2, a.x(v) * W - 1)), 0, 2, H);
  }
  (function histoDrag() {
    const c = $('histo');
    let hvilken = null;
    const flytt = e => {
      if (!stat || diskret) return;
      const r = c.getBoundingClientRect(), a = histoAkse();
      const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), s = skala();
      if (hvilken == null) hvilken = Math.abs(x - a.x(s.lo)) <= Math.abs(x - a.x(s.hi)) ? 'cmin' : 'cmax';
      sett(hvilken, a.v(x));
      fargeskala();
    };
    c.addEventListener('pointerdown', e => { hvilken = null; c.setPointerCapture(e.pointerId); flytt(e); });
    c.addEventListener('pointermove', e => { if (c.hasPointerCapture(e.pointerId)) flytt(e); });
  })();

  // ---------- tid ----------
  function oppdaterTidTekst() {
    $('tidUt').textContent = grid && grid.tider.length ? dato(grid.tider[steg]) : '';
  }
  function settSteg(s) {
    steg = Math.max(0, Math.min(grid.tider.length - 1, s));
    $('tid').value = steg;
    oppdaterTidTekst();
    kurveTid();
    byggBronner();
    // Egenskaper og metning kan endre seg med tiden; da må både farger og volum hentes på nytt.
    if (grid.props.some(p => p.dynamisk)) {
      bestillHud();
      if (erDynamisk()) worker.postMessage({ type: 'stat', prop, steg, ref: refSteg() });
    }
  }
  // ---------- egenskapsfiltre ----------
  // Hver rad: egenskap (tomt valg = det som vises), fra og til. Alle rader må være oppfylt.
  function nyFilterRad() {
    const rad = document.createElement('div'); rad.className = 'filter';
    const s = document.createElement('select'); s.setAttribute('aria-label', 'Egenskap i filteret');
    s.add(new Option('Vist egenskap', ''));
    for (const p of grid.props) s.add(new Option(p.navn, p.navn));
    const felt = hjelp => { const i = document.createElement('input'); i.type = 'number'; i.step = 'any'; i.placeholder = hjelp; i.setAttribute('aria-label', hjelp); return i; };
    const lo = felt('fra'), hi = felt('til');
    const x = document.createElement('button'); x.textContent = '×'; x.title = 'Fjern filteret'; x.setAttribute('aria-label', 'Fjern filteret');
    x.addEventListener('click', () => { rad.remove(); if (!$('filtre').children.length) nyFilterRad(); bestillHud(); });
    for (const el of [s, lo, hi]) el.addEventListener('input', bestillHud);
    rad.append(s, lo, hi, x);
    $('filtre').appendChild(rad);
  }
  function filterRader() {
    const ut = [];
    for (const rad of $('filtre').children) {
      const [s, lo, hi] = rad.children;
      if (lo.value === '' && hi.value === '') continue;
      ut.push({ prop: s.value, pmin: lo.value === '' ? null : +lo.value, pmax: hi.value === '' ? null : +hi.value });
    }
    return ut;
  }
  // Grenser som gjaldt forrige viste egenskap, gir ikke mening for den neste.
  function tomVistFilter() {
    for (const rad of $('filtre').children) if (rad.children[0].value === '') { rad.children[1].value = ''; rad.children[2].value = ''; }
  }

  // ---------- endring mellom to tidssteg ----------
  const refSteg = () => $('endring').checked && erDynamisk() ? +$('refSteg').value : null;
  function fyllRefSteg() {
    const s = $('refSteg');
    s.innerHTML = '';
    grid.tider.forEach((t, i) => s.add(new Option(dato(t), i)));
  }
  let kartFor = null;   // fargekartet som var valgt før endringsvisningen
  function oppdaterEndring() {
    const kan = erDynamisk() && grid.tider.length > 1;
    $('radEndring').style.display = kan ? '' : 'none';
    if (!kan) $('endring').checked = false;
    const pa = $('endring').checked;
    $('refSteg').style.display = pa ? '' : 'none';
    if (pa && kartFor == null) { kartFor = $('fargekart').value; $('fargekart').value = 'endring'; }
    if (!pa && kartFor != null) { $('fargekart').value = kartFor; kartFor = null; }
  }
  function endringByttet() {
    oppdaterEndring();
    tomVistFilter();
    kartNokkel = '';
    velgEgenskap(true);
    bestillHud();
  }
  $('endring').addEventListener('change', endringByttet);
  $('refSteg').addEventListener('change', endringByttet);

  // ---------- to modeller side om side ----------
  // Hver halvdel er en egen utgave av appen i en ramme. Kamera (relativt til modellens midtpunkt)
  // og valg i panelet kopieres til den andre halvdelen når låsene er på.
  const iRamme = window.parent !== window && !!window.parent.DELT;
  let sisteFiler = null, synker = false;
  function kameraTilstand() {
    return { p: kamera.position.toArray(), t: styring.target.toArray(), zs: $('zs').value };
  }
  function settKamera(k) {
    synker = true;
    kamera.position.fromArray(k.p); styring.target.fromArray(k.t);
    if ($('zs').value !== k.zs) { $('zs').value = k.zs; overdrivelse(); }
    styring.update();
    synker = false; tegn = true;
  }
  function settValg(id, verdi, type) {
    const el = $(id);
    if (!el || el.disabled) return;
    if (el.type === 'checkbox') { if (el.checked === verdi) return; el.checked = verdi; }
    else {
      if (el.tagName === 'SELECT' && !Array.from(el.options).some(o => o.value === verdi)) return;
      if (el.value === verdi) return;
      el.value = verdi;
    }
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }
  if (iRamme) {
    document.body.classList.add('i-ramme');
    $('sammenlign').style.display = 'none';
    styring.addEventListener('change', () => { if (!synker && grid) window.parent.DELT.kamera(window, kameraTilstand()); });
    // Bare det brukeren selv gjør sendes videre (isTrusted), ellers ville halvdelene svart hverandre i ring.
    for (const type of ['input', 'change']) $('panel').addEventListener(type, e => {
      const el = e.target;
      if (!e.isTrusted || !el.id || el.type === 'file') return;
      window.parent.DELT.valg(window, el.id, el.type === 'checkbox' ? el.checked : el.value, type);
      if (el.id === 'zs') window.parent.DELT.kamera(window, kameraTilstand());
    });
  } else {
    const ruter = () => Array.from(document.querySelectorAll('#delt iframe'));
    const andre = fra => ruter().map(r => r.contentWindow).filter(w => w !== fra && w.APP && w.APP.grid);
    window.DELT = {
      kamera(fra, k) { if ($('lasKamera').checked) for (const w of andre(fra)) w.APP.settKamera(k); },
      valg(fra, id, verdi, type) { if ($('lasValg').checked) for (const w of andre(fra)) w.APP.settValg(id, verdi, type); }
    };
    $('sammenlign').addEventListener('click', () => {
      const boks = $('delt').querySelector('.ruter');
      boks.innerHTML = '';
      for (let n = 0; n < 2; n++) {
        const r = document.createElement('iframe');
        r.title = n ? 'Modell til høyre' : 'Modell til venstre';
        r.src = location.pathname;
        // Venstre halvdel starter med modellen som allerede er åpen.
        if (n === 0 && sisteFiler) r.addEventListener('load', () => r.contentWindow.APP.lastFiler(sisteFiler));
        boks.appendChild(r);
      }
      stoppSpill();
      $('delt').style.display = 'grid';
    });
    $('avsluttDelt').addEventListener('click', () => {
      $('delt').style.display = 'none';
      $('delt').querySelector('.ruter').innerHTML = '';
    });
  }

  // ---------- produksjonskurver ----------
  // Vises når modellen er lastet sammen med SMSPEC/UNSMRY. Tidslinja i 3D og kurvene følger
  // hverandre: valgt tidssteg markeres i kurvene, og et klikk i en kurve velger nærmeste steg.
  function kurveTid() { KURVEPANEL.settTid(grid && grid.tider.length ? grid.tider[steg] : null); }
  function apneKurver(apen) {
    const har = !!(grid && grid.kurver);
    $('kurver').style.display = har && apen ? 'block' : 'none';
    $('visKurver').style.display = har && !apen ? '' : 'none';
    document.body.classList.toggle('kurver-apen', har && apen);
    document.documentElement.style.setProperty('--kurve-h', $('kurver').offsetHeight + 'px');
    if (har && apen) KURVEPANEL.tegn();
  }
  function fyllKurveValg() {
    const k = grid.kurver, v = $('kurveValg');
    v.innerHTML = '';
    KURVEPANEL.tom();
    if (k) {
      if (k.felt) v.add(new Option('Hele feltet', ''));
      for (const n of k.bronner) v.add(new Option(n, n));
      worker.postMessage({ type: 'kurver', navn: v.value });
    }
    apneKurver(!!k);
  }
  function nyeKurver(m) {
    KURVEPANEL.vis($('kurveFig'), m, {
      velgTid: t => {
        const a = grid.tider;
        if (!a.length) return;
        let best = 0;
        for (let i = 1; i < a.length; i++) if (Math.abs(a[i] - t) < Math.abs(a[best] - t)) best = i;
        if (best !== steg) { stoppSpill(); settSteg(best); }
      }
    });
    kurveTid();
    document.documentElement.style.setProperty('--kurve-h', $('kurver').offsetHeight + 'px');
  }
  function velgKurve(navn) {
    const v = $('kurveValg');
    if (!grid.kurver || !Array.from(v.options).some(o => o.value === navn)) return false;
    v.value = navn;
    apneKurver(true);
    worker.postMessage({ type: 'kurver', navn });
    return true;
  }
  $('kurveValg').addEventListener('change', () => worker.postMessage({ type: 'kurver', navn: $('kurveValg').value }));
  $('kurveLukk').addEventListener('click', () => apneKurver(false));
  $('visKurver').addEventListener('click', () => apneKurver(true));

  function stoppSpill() { if (spiller) { clearInterval(spiller); spiller = null; $('spill').innerHTML = '&#9654;'; } }
  $('spill').addEventListener('click', () => {
    if (spiller) return stoppSpill();
    if (steg >= grid.tider.length - 1) settSteg(0);
    $('spill').innerHTML = '&#10074;&#10074;';
    spiller = setInterval(() => { if (steg >= grid.tider.length - 1) stoppSpill(); else if (!venter) settSteg(steg + 1); }, 160);
  });
  $('tid').addEventListener('input', () => { stoppSpill(); settSteg(+$('tid').value); });

  // ---------- forkastninger ----------
  function byggForkast() {
    if (forkastMesh) { gruppe.remove(forkastMesh); forkastMesh.geometry.dispose(); forkastMesh = null; }
    forkastQuads = null;
    if (!grid || !grid.forkast.antFlater) return;
    const f = grid.forkast[$('forkastModus').value], n = f.eier.length;
    // Bare valgte forkastninger tas med i indeksen.
    const quads = [];
    for (let q = 0; q < n; q++) if (!skjult.forkast.has(f.eier[q])) quads.push(q);
    const idx = new Uint32Array(quads.length * 6);
    quads.forEach((q, i) => idx.set(f.idx.subarray(6 * q, 6 * q + 6), 6 * i));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(f.pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const farget = $('sprang').checked;
    if (farget) {
      const farger = new Float32Array(n * 12);
      for (let q = 0; q < n; q++) {
        const c = fargeAv(FARGEKART.spektral, f.sprang[q] / grid.maksSprang);
        for (let h = 0; h < 4; h++) { farger[12 * q + 3 * h] = c.r; farger[12 * q + 3 * h + 1] = c.g; farger[12 * q + 3 * h + 2] = c.b; }
      }
      geo.setAttribute('color', new THREE.BufferAttribute(farger, 3));
    }
    forkastMesh = new THREE.Mesh(geo, farget ? sprangMat : forkastMat);
    forkastMesh.frustumCulled = false;
    forkastMesh.renderOrder = 2;
    forkastQuads = quads;
    forkastSynlig();
    gruppe.add(forkastMesh);
    tegn = true;
  }

  // I et tverrsnitt ville forkastningsflatene dekke snittet, så de skjules der.
  function forkastSynlig() {
    if (forkastMesh) forkastMesh.visible = $('visForkast').checked && !($('modus').value === 'snitt' && linje);
    tegn = true;
  }

  // ---------- brønner ----------
  // Brønnene tegnes som rør. De bygges på nytt når overdrivelsen eller tiden endres. Hvert rør
  // tegnes også svakt gjennom cellene, så banen kan følges inne i modellen.
  function byggBronner() {
    for (const o of bronnGruppe.children.slice()) { bronnGruppe.remove(o); o.geometry.dispose(); o.material.dispose(); }
    for (let i = etiketter.length - 1; i >= 0; i--) if (etiketter[i].bronn) { etiketter[i].el.remove(); etiketter.splice(i, 1); }
    if (!grid || !grid.bronner.length) return;
    const z = zs(), b = grid.bbox, t = naa();
    const radius = 0.0013 * Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
    grid.bronner.forEach((w, nr) => {
      if (skjult.bronn.has(nr)) return;
      // Bare koblinger som er åpnet til og med valgt tidspunkt tas med.
      const pkt = [], p = w.punkter;
      const leggTil = i => {
        const v = new THREE.Vector3(p[i], p[i + 1] * z, p[i + 2]);
        if (!pkt.length || pkt[pkt.length - 1].distanceToSquared(v) > 1e-6) pkt.push(v);
      };
      if (w.bane) {
        if (w.tider.length && !Array.prototype.some.call(w.tider, x => x <= t)) return;
        for (let i = 0; i < p.length; i += 3) leggTil(i);
      } else {
        leggTil(0);
        for (let n = 0; n < w.tider.length; n++) if (w.tider[n] <= t) leggTil(3 * (n + 1));
      }
      if (pkt.length < 2) return;
      let type = null;
      for (const s of w.typer) if (s[0] <= t) type = s[1];
      const klasse = type === 'I' ? 'inj' : type === 'P' ? 'prod' : 'ukjent';
      const farge = css(type === 'I' ? '--inj' : type === 'P' ? '--prod' : '--dempet');
      const kurve = new THREE.CatmullRomCurve3(pkt, false, 'catmullrom', 0);   // spenning 0 = rette strekk
      const geo = new THREE.TubeGeometry(kurve, Math.min(2000, (pkt.length - 1) * 6), radius, 8, false);
      const ror = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: farge }));
      const gjennom = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: farge, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false }));
      gjennom.renderOrder = 5;
      bronnGruppe.add(ror, gjennom);
      const el = document.createElement('div');
      el.className = 'etikett bronn ' + klasse;
      el.textContent = w.navn;
      el.addEventListener('click', () => velgKurve(w.navn));
      $('etiketter').appendChild(el);
      etiketter.push({ el, pos: pkt[0], skaler: false, bronn: true, bredde: 7 * w.navn.length + 12 });
    });
    tegn = true;
  }

  // ---------- ramme, etiketter og kompass ----------
  function akseEtikett(tekst, x, y, z) {
    const el = document.createElement('div');
    el.className = 'etikett akse';
    el.textContent = tekst;
    $('etiketter').appendChild(el);
    etiketter.push({ el, pos: new THREE.Vector3(x, y, z), skaler: true, bronn: false });
  }
  // Ramme rundt modellen med dybder langs ett hjørne og lengden på to sider.
  function byggRamme() {
    if (ramme) { gruppe.remove(ramme); ramme.geometry.dispose(); ramme = null; }
    for (let i = etiketter.length - 1; i >= 0; i--) if (!etiketter[i].bronn) { etiketter[i].el.remove(); etiketter.splice(i, 1); }
    if (!mesh) return;
    mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox;
    ramme = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z)), rammeMat);
    ramme.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    ramme.visible = $('visRamme').checked;
    gruppe.add(ramme);
    // «Pene» dybdetrinn: 1, 2 eller 5 ganger en tierpotens, omtrent fem merker.
    const d0 = grid.origo[2] - b.max.y, d1 = grid.origo[2] - b.min.y, grov = (d1 - d0) / 5 || 1;
    const pot = Math.pow(10, Math.floor(Math.log10(grov))), trinn = [1, 2, 5, 10].map(f => f * pot).find(s => s >= grov);
    for (let d = Math.ceil(d0 / trinn) * trinn; d <= d1; d += trinn) akseEtikett(hel(d) + ' m', b.min.x, grid.origo[2] - d, b.max.z);
    const km = v => (v / 1000).toLocaleString('nb-NO', { maximumFractionDigits: 1 }) + ' km';
    akseEtikett('Ø–V ' + km(b.max.x - b.min.x), (b.min.x + b.max.x) / 2, b.min.y, b.max.z);
    akseEtikett('N–S ' + km(b.max.z - b.min.z), b.min.x, b.min.y, (b.min.z + b.max.z) / 2);
    tegn = true;
  }

  const projisert = new THREE.Vector3();
  function plasserEtiketter() {
    if (!etiketter.length) return;
    const w = window.innerWidth, h = window.innerHeight, z = zs();
    const visB = $('visBronner').checked, visR = $('visRamme').checked;
    const plass = [];
    for (const e of etiketter) {
      const vis = e.bronn ? visB : visR;
      projisert.copy(e.pos);
      if (e.skaler) projisert.y *= z;
      projisert.project(kamera);
      if (!vis || projisert.z > 1 || projisert.z < -1) { e.el.style.display = 'none'; continue; }
      e.el.style.display = '';
      e.x = (projisert.x + 1) / 2 * w; e.y = (1 - projisert.y) / 2 * h; e.dyp = projisert.z;
      if (e.bronn) plass.push(e);
      else e.el.style.transform = 'translate(' + e.x.toFixed(1) + 'px,' + e.y.toFixed(1) + 'px) translate(-50%,-50%)';
    }
    // Brønnetiketter som ville overlappe, flyttes oppover. De nærmeste plasseres først.
    plass.sort((a, b) => a.dyp - b.dyp);
    const satt = [];
    for (const e of plass) {
      let y = e.y - 20;
      for (let f = 0; f < 12; f++) {
        if (!satt.some(r => Math.abs(r.x - e.x) < (r.b + e.bredde) / 2 + 2 && Math.abs(r.y - y) < 17)) break;
        y -= 17;
      }
      satt.push({ x: e.x, y, b: e.bredde });
      e.el.style.transform = 'translate(' + e.x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) translate(-50%,-50%)';
    }
  }

  // Kompassnåla peker mot nord (−z i 3D) slik det ser ut på skjermen.
  function dreiKompass() {
    const e = kamera.matrixWorld.elements;
    const vinkel = Math.atan2(-e[2], -e[6]) * 180 / Math.PI;   // nord projisert på kameraets høyre- og opp-akse
    $('nal').setAttribute('transform', 'rotate(' + vinkel.toFixed(1) + ')');
  }

  // ---------- kamera ----------
  function boks() {
    mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox, z = zs();
    const dx = b.max.x - b.min.x, dy = (b.max.y - b.min.y) * z, dz = b.max.z - b.min.z;
    return { dx, dz, r: 0.5 * Math.hypot(dx, dy, dz) || 1,
      senter: new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2 * z, (b.min.z + b.max.z) / 2) };
  }
  function tilpass(ovenfra) {
    if (!mesh || !hud || !hud.antFlater) return;
    // Tilpass til det som faktisk tegnes (pilarene kan dekke et mye større område enn de aktive cellene).
    const b = boks();
    // Den frie flaten ved siden av panelet kan være smalere enn den er høy (delt visning, smalt
    // vindu); da er det den vannrette synsvinkelen som avgjør avstanden.
    const fri = Math.max(200, window.innerWidth - ($('panel').offsetWidth + 12)) / window.innerHeight;
    const halv = Math.min(kamera.fov * Math.PI / 360, Math.atan(Math.tan(kamera.fov * Math.PI / 360) * fri));
    const avstand = b.r / Math.sin(halv) * 0.8;
    styring.target.copy(b.senter);
    // Se på tvers av modellens lengste horisontale akse, så den fyller skjermbredden.
    let retning = b.dz > b.dx ? new THREE.Vector3(-0.8, 0.5, 0.33) : new THREE.Vector3(-0.33, 0.5, 0.8);
    if (ovenfra === true) retning = new THREE.Vector3(0, 1, 0.001);
    else if ($('modus').value === 'snitt' && linje && linje.length > 1) {
      // Se rett på snittet: vannrett, vinkelrett på linja fra første til siste punkt (fra sør- eller vestsiden).
      const a = linje[0], e = linje[linje.length - 1];
      retning = new THREE.Vector3(-(e[1] - a[1]), 0, e[0] - a[0]);
      if (retning.z < 0 || (retning.z === 0 && retning.x > 0)) retning.negate();
      retning.normalize().setY(0.12);
    }
    kamera.position.copy(retning.normalize().multiplyScalar(avstand)).add(styring.target);
    kamera.near = b.r / 200; kamera.far = b.r * 60;
    kamera.updateProjectionMatrix();
    styring.update();
    tegn = true;
  }

  function overdrivelse() {
    gruppe.scale.y = zs();
    $('zsUt').textContent = zs() + '×';
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

  // ---------- plukking ----------
  function plukk(px, py) {
    if (!mesh || !mesh.visible || !hud || !hud.antFlater) return -1;
    const w = window.innerWidth, h = window.innerHeight;
    const ox = kamera.view && kamera.view.enabled ? kamera.view.offsetX : 0;
    kamera.setViewOffset(w, h, ox + px, py, 1, 1);
    const gjemt = [];
    for (const o of [bronnGruppe, hjelpGruppe, forkastMesh, markor, ramme]) if (o && o.visible) { o.visible = false; gjemt.push(o); }
    const farge = renderer.getClearColor(new THREE.Color()), alfa = renderer.getClearAlpha();
    mesh.material = plukkMat;
    renderer.setRenderTarget(plukkMal);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, kamera);
    const px4 = new Uint8Array(4);
    renderer.readRenderTargetPixels(plukkMal, 0, 0, 1, 1, px4);
    renderer.setRenderTarget(null);
    renderer.setClearColor(farge, alfa);
    mesh.material = materiale;
    for (const o of gjemt) o.visible = true;
    storrelse();
    return (px4[0] | (px4[1] << 8) | (px4[2] << 16) | (px4[3] << 24)) - 1;
  }

  // Punktet der siktelinja treffer firkant f (i skalerte koordinater).
  const stråle = new THREE.Raycaster();
  function siktelinje(e) {
    const r = canvas.getBoundingClientRect();
    stråle.setFromCamera({ x: (e.clientX - r.left) / r.width * 2 - 1, y: -(e.clientY - r.top) / r.height * 2 + 1 }, kamera);
  }
  function treffpunkt(f, e) {
    const p = mesh.geometry.attributes.position.array, z = zs();
    siktelinje(e);
    const v = [0, 1, 2, 3].map(h => new THREE.Vector3(p[12 * f + 3 * h], p[12 * f + 3 * h + 1] * z, p[12 * f + 3 * h + 2]));
    const ut = new THREE.Vector3();
    return stråle.ray.intersectTriangle(v[0], v[1], v[2], false, ut) || stråle.ray.intersectTriangle(v[0], v[2], v[3], false, ut)
      || v[0].clone().add(v[1]).add(v[2]).add(v[3]).multiplyScalar(0.25);
  }

  let ned = null, sisteTreff = null;
  canvas.addEventListener('pointerdown', e => { ned = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', e => {
    if (!ned || !mesh || !hud || Math.hypot(e.clientX - ned[0], e.clientY - ned[1]) > 4) return;
    const r = canvas.getBoundingClientRect();
    const f = plukk(e.clientX - r.left, e.clientY - r.top);
    if (tegner) {
      if (f >= 0 && f < hud.antFlater) { tegner.push(treffpunkt(f, e)); tegnSnittLinje(); }
      return;
    }
    if (f < 0 || f >= hud.antFlater) {
      fjernMarkor();
      // Uten celletreff: se om klikket traff en forkastning (mest aktuelt når cellene er skjult).
      siktelinje(e);
      const tf = forkastMesh && forkastMesh.visible ? stråle.intersectObject(forkastMesh)[0] : null;
      if (!tf) { $('celle').style.display = 'none'; return; }
      const fk = grid.forkast[$('forkastModus').value], q = forkastQuads[tf.faceIndex >> 1];
      visTabell([['Forkastning', grid.forkast.navn[fk.eier[q]]], ['Dybde', tall(grid.origo[2] - tf.point.y / zs()) + ' m'],
        ['Sprang', tall(fk.sprang[q]) + ' m']]);
      return;
    }
    const c = hud.celle[f], pkt = treffpunkt(f, e);
    sisteTreff = { c, dybde: grid.origo[2] - pkt.y / zs(), kart: kartModus() ? hud.verdi[4 * f] : null };
    settMarkor(f);
    worker.postMessage({ type: 'celle', id: ++celleId, c, steg, prop, ref: refSteg() });
  });

  function visTabell(rader) {
    const tab = document.createElement('table');
    tab.className = 'tall';
    for (const [a, b] of rader) { const tr = tab.insertRow(); tr.insertCell().textContent = a; tr.insertCell().textContent = b; }
    $('celle').replaceChildren(tab);
    $('celle').style.display = 'block';
  }
  function visCelle(m) {
    if (m.id !== celleId || !sisteTreff) return;
    const c = m.c, i = c % grid.nx, j = Math.floor(c / grid.nx) % grid.ny, k = Math.floor(c / (grid.nx * grid.ny));
    const rader = [['Celle (I, J, K)', (i + 1) + ', ' + (j + 1) + ', ' + (k + 1)], ['Dybde', tall(sisteTreff.dybde) + ' m']];
    if (sisteTreff.kart != null) rader.push(['Kartverdi', sisteTreff.kart < -1e29 ? '–' : tall(sisteTreff.kart)]);
    for (const [navn, v] of m.verdier) if (navn !== 'DEPTH') rader.push([navn, tall(v)]);
    visTabell(rader);
  }

  function fjernMarkor() {
    if (markor) { gruppe.remove(markor); markor.geometry.dispose(); markor = null; tegn = true; }
  }
  function settMarkor(f) {
    fjernMarkor();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.geometry.attributes.position.array.slice(12 * f, 12 * f + 12), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    // Fylt, halvgjennomsiktig flate: en 1 px linje forsvinner på små celler.
    markor = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: css('--markor'), side: THREE.DoubleSide, transparent: true, opacity: 0.75, depthTest: false }));
    markor.renderOrder = 10;
    gruppe.add(markor);
    tegn = true;
  }

  // ---------- tverrsnitt ----------
  function tegnSnittLinje() {
    for (const o of hjelpGruppe.children.slice()) { hjelpGruppe.remove(o); o.material.dispose(); }
    if (snittLinje) { snittLinje.dispose(); snittLinje = null; }
    if (tegner && tegner.length) {
      snittLinje = new THREE.BufferGeometry().setFromPoints(tegner);
      const punkter = new THREE.Points(snittLinje, new THREE.PointsMaterial({ color: css('--markor'), size: 9, sizeAttenuation: false, depthTest: false }));
      const strek = new THREE.Line(snittLinje, linjeMat.clone());
      punkter.renderOrder = strek.renderOrder = 12;
      hjelpGruppe.add(strek, punkter);
    }
    $('ferdig').disabled = !tegner || tegner.length < 2;
    tegn = true;
  }
  function startTegning() {
    // Snittet tegnes på cellene; vis dem mens linja legges.
    linje = null; tegner = [];
    $('tegnehjelp').style.display = 'block';
    $('visGrid').checked = true; if (mesh) mesh.visible = true;
    canvas.style.cursor = 'crosshair';
    tegnSnittLinje();
    forkastSynlig();
    bestillHud();
  }
  function avbrytTegning() {
    tegner = null;
    $('tegnehjelp').style.display = 'none';
    canvas.style.cursor = '';
    tegnSnittLinje();
  }
  function visSnitt(nyLinje) {
    avbrytTegning();
    linje = nyLinje;
    $('modus').value = 'snitt'; $('snittvalg').style.display = 'block';
    forste = true;   // zoom inn på snittet
    forkastSynlig();
    bestillHud();
  }
  $('tegn').addEventListener('click', startTegning);
  $('avbryt').addEventListener('click', () => { avbrytTegning(); if (!linje) { $('modus').value = 'celler'; $('snittvalg').style.display = 'none'; } });
  $('ferdig').addEventListener('click', () => visSnitt(tegner.map(p => [p.x, p.z])));
  $('snittBronn').addEventListener('change', () => {
    const w = grid.bronner[$('snittBronn').value];
    $('snittBronn').value = '';
    if (!w) return;
    // Følg brønnen i kartet; toppunktet over modellen (første punkt) hører ikke med i en bane fra koblinger.
    const pkt = [];
    for (let i = w.bane ? 0 : 3; i < w.punkter.length; i += 3) {
      const p = [w.punkter[i], w.punkter[i + 2]], s = pkt[pkt.length - 1];
      if (!s || Math.hypot(p[0] - s[0], p[1] - s[1]) > 1) pkt.push(p);
    }
    if (pkt.length === 1) pkt.push([pkt[0][0] + 1, pkt[0][1]]);   // loddrett brønn: kort øst–vest-snitt gjennom den
    if (pkt.length < 2) return;
    // Forleng snittet i begge ender, så brønnen ikke ender i kanten av bildet.
    const d = 0.03 * Math.hypot(grid.bbox.x1 - grid.bbox.x0, grid.bbox.y1 - grid.bbox.y0);
    const forleng = (a, b) => { const l = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; return [a[0] + (a[0] - b[0]) / l * d, a[1] + (a[1] - b[1]) / l * d]; };
    pkt.unshift(forleng(pkt[0], pkt[1]));
    pkt.push(forleng(pkt[pkt.length - 1], pkt[pkt.length - 2]));
    visSnitt(pkt);
  });
  $('modus').addEventListener('change', () => {
    const m = $('modus').value;
    $('snittvalg').style.display = m === 'snitt' ? 'block' : 'none';
    avbrytTegning();
    kartNokkel = '';
    lagLut();
    if (m === 'snitt' && !linje) return startTegning();
    if (!m.startsWith('kart')) { nullstillSkala(); fargeskala(); }
    forste = true;
    forkastSynlig();
    bestillHud();
  });

  // ---------- hendelser ----------
  $('egenskap').addEventListener('change', () => {
    tomVistFilter();
    oppdaterEndring();
    kartNokkel = '';
    velgEgenskap(true);
    bestillHud();
  });
  $('cmin').addEventListener('input', fargeskala);
  $('cmax').addEventListener('input', fargeskala);
  $('logg').addEventListener('change', () => { nullstillSkala(); fargeskala(); });
  $('auto').addEventListener('click', () => {
    if (kartModus() && hud && hud.omrade) { sett('cmin', hud.omrade.min); sett('cmax', hud.omrade.max); } else nullstillSkala();
    fargeskala();
  });
  $('fargekart').addEventListener('change', () => { lagLut(); fargeskala(); });
  $('nyttFilter').addEventListener('click', () => nyFilterRad());
  $('zs').addEventListener('input', overdrivelse);
  $('kanter').addEventListener('change', () => { materiale.uniforms.kanter.value = $('kanter').checked ? 1 : 0; tegn = true; });
  $('visGrid').addEventListener('change', () => { if (mesh) mesh.visible = $('visGrid').checked; fjernMarkor(); tegn = true; });
  $('visRamme').addEventListener('change', () => { if (ramme) ramme.visible = $('visRamme').checked; tegn = true; });
  $('visForkast').addEventListener('change', forkastSynlig);
  $('forkastModus').addEventListener('change', byggForkast);
  $('sprang').addEventListener('change', byggForkast);
  $('visBronner').addEventListener('change', () => { bronnGruppe.visible = $('visBronner').checked; tegn = true; });
  $('tilpass').addEventListener('click', () => tilpass(false));
  $('ovenfra').addEventListener('click', () => tilpass(true));
  $('apne').addEventListener('click', () => $('fil').click());
  $('velg').addEventListener('click', () => $('fil').click());
  $('fil').addEventListener('change', e => { lastFiler(e.target.files); e.target.value = ''; });
  $('demo').addEventListener('click', () => {
    $('opptatt').style.display = 'block';
    worker.postMessage({ type: 'demo', nx: 60, ny: 80, nz: 20 });
  });
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && tegner) $('avbryt').click(); });

  // ---------- visninger: tilstand, lenke og lagring ----------
  // En visning er alt som skal til for å gjenskape bildet av en modell som allerede er åpen:
  // kamera, egenskap, tid, endring, utsnitt, filtre, modus, fargeskala og hva som er slått på.
  // Selve modellen ligger aldri i lenken; den beskrives bare med dimensjonene.
  let ventSkala = null, ventKamera = null, ventLenke = null;
  const KRYSS = ['kanter', 'visGrid', 'visRamme', 'visForkast', 'visBronner', 'sprang'];
  const IJK = ['i0', 'i1', 'j0', 'j1', 'k0', 'k1'];
  const modellNokkel = () => grid.nx + 'x' + grid.ny + 'x' + grid.nz + ':' + grid.antAktive;
  function tilstand() {
    const kryss = {};
    for (const id of KRYSS) kryss[id] = $(id).checked;
    return {
      v: 1, m: modellNokkel(), k: kameraTilstand(), prop, steg, ref: refSteg(),
      ijk: IJK.map(id => +$(id).value), filtre: filterRader(), modus: $('modus').value,
      linje: $('modus').value === 'snitt' ? linje : null,
      kart: kartFor != null ? kartFor : $('fargekart').value, cmin: $('cmin').value, cmax: $('cmax').value, logg: $('logg').checked,
      kryss, forkastModus: $('forkastModus').value
    };
  }
  function brukSkala(s, behold) {
    if (!diskret || behold) { $('logg').checked = !!s.logg && !$('logg').disabled; $('cmin').value = s.cmin; $('cmax').value = s.cmax; }
    if (!behold) fargeskala();
  }
  function brukTilstand(t) {
    if (!grid || !t || t.v !== 1) return false;
    if (t.m && t.m !== modellNokkel()) {
      $('advarsel').textContent = 'Visningen ble laget for en modell med andre dimensjoner og er ikke brukt.';
      $('advarsel').style.display = 'block';
      return false;
    }
    stoppSpill();
    const har = (id, v) => Array.from($(id).options).some(o => o.value === String(v));
    if (t.prop && har('egenskap', t.prop)) $('egenskap').value = t.prop;
    prop = $('egenskap').value;
    steg = Math.max(0, Math.min(grid.tider.length - 1, t.steg | 0));
    $('tid').value = steg; oppdaterTidTekst(); kurveTid();
    // Endring: oppdaterEndring bytter selv til det divergerende fargekartet og husker det forrige.
    if (kartFor != null) { $('fargekart').value = kartFor; kartFor = null; }
    if (har('fargekart', t.kart)) $('fargekart').value = t.kart;
    $('endring').checked = t.ref != null;
    if (t.ref != null && har('refSteg', t.ref)) $('refSteg').value = t.ref;
    oppdaterEndring();
    (t.ijk || []).forEach((v, n) => { $(IJK[n]).value = v; });
    oppdaterUtsnittTekst();
    $('filtre').innerHTML = '';
    for (const f of t.filtre || []) {
      nyFilterRad();
      const rad = $('filtre').lastChild.children;
      if (!f.prop || Array.from(rad[0].options).some(o => o.value === f.prop)) rad[0].value = f.prop || '';
      rad[1].value = f.pmin == null ? '' : f.pmin; rad[2].value = f.pmax == null ? '' : f.pmax;
    }
    if (!$('filtre').children.length) nyFilterRad();
    for (const id of KRYSS) if (t.kryss && id in t.kryss) settValg(id, t.kryss[id], 'change');
    if (t.forkastModus) settValg('forkastModus', t.forkastModus, 'change');
    avbrytTegning();
    linje = t.modus === 'snitt' && t.linje && t.linje.length > 1 ? t.linje : null;
    $('modus').value = har('modus', t.modus) && (t.modus !== 'snitt' || linje) ? t.modus : 'celler';
    $('snittvalg').style.display = $('modus').value === 'snitt' ? 'block' : 'none';
    tegnSnittLinje();
    kartNokkel = 'låst';   // kartvisninger skal ikke nullstille skalaen som følger med visningen
    forste = false;
    forkastSynlig();
    ventSkala = { cmin: t.cmin, cmax: t.cmax, logg: t.logg };
    ventKamera = t.k;
    velgEgenskap(true);
    byggBronner();
    bestillHud();
    return true;
  }

  // Lenke: tilstanden som base64url-kodet JSON etter #v=.
  const kod = t => btoa(unescape(encodeURIComponent(JSON.stringify(t)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function dekod(s) {
    try { return JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return null; }
  }
  function lenkeTilstand() { const m = location.hash.match(/[#&]v=([\w-]+)/); return m ? dekod(m[1]) : null; }
  ventLenke = lenkeTilstand();
  if (ventLenke) {
    const p = document.createElement('p');
    p.textContent = 'Lenken inneholder en lagret visning. Åpne modellen den gjelder, så settes visningen automatisk.';
    $('velg').parentNode.insertBefore(p, $('velg'));
  }
  window.addEventListener('hashchange', () => { const t = lenkeTilstand(); if (t && grid) brukTilstand(t); });
  $('kopierLenke').addEventListener('click', () => {
    const hash = '#v=' + kod(tilstand());
    history.replaceState(null, '', hash);
    const ferdig = ok => { $('kopierLenke').textContent = ok ? 'Kopiert' : 'Lenken står i adressefeltet'; setTimeout(() => { $('kopierLenke').textContent = 'Kopier lenke'; }, 1800); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(location.href).then(() => ferdig(true), () => ferdig(false));
    else ferdig(false);
  });

  // Lagrede visninger ligger i nettleseren (localStorage), per modell.
  const LAGER = 'reservoarvisning.visninger';
  function lager() { try { return JSON.parse(localStorage.getItem(LAGER)) || {}; } catch (e) { return {}; } }
  function skrivLager(alle) { try { localStorage.setItem(LAGER, JSON.stringify(alle)); } catch (e) { /* privat modus: visningene lever bare i denne økten */ } }
  let visningene = [];
  function visVisninger() {
    visningene = lager()[modellNokkel()] || [];
    const el = $('visninger');
    el.innerHTML = '';
    visningene.forEach((v, n) => {
      const rad = document.createElement('div'); rad.className = 'visning';
      const navn = document.createElement('input'); navn.value = v.navn; navn.setAttribute('aria-label', 'Navn på visning ' + (n + 1));
      navn.addEventListener('change', () => { v.navn = navn.value; lagreVisninger(); });
      const vis = document.createElement('button'); vis.textContent = 'Vis'; vis.title = 'Gå til visningen' + (n < 9 ? ' (tast ' + (n + 1) + ')' : '');
      vis.addEventListener('click', () => brukTilstand(v.t));
      const x = document.createElement('button'); x.textContent = '×'; x.title = 'Slett visningen'; x.setAttribute('aria-label', 'Slett visningen ' + v.navn);
      x.addEventListener('click', () => { visningene.splice(n, 1); lagreVisninger(); visVisninger(); });
      rad.append(navn, vis, x);
      el.appendChild(rad);
    });
  }
  function lagreVisninger() { const alle = lager(); alle[modellNokkel()] = visningene; skrivLager(alle); }
  function lagreVisning() {
    const t = tilstand();
    const navn = (t.ref != null ? 'Endring i ' : '') + prop + (grid.tider.length > 1 ? ' · ' + dato(grid.tider[steg]) : '') +
      (t.modus !== 'celler' ? ' · ' + $('modus').selectedOptions[0].text : '');
    visningene.push({ navn, t });
    lagreVisninger(); visVisninger();
  }
  $('lagreVisning').addEventListener('click', lagreVisning);

  // ---------- bildeeksport ----------
  // 3D-bildet med brønn- og akseetiketter og en fargeskala nede til venstre, som PNG.
  function lagBilde() {
    renderer.render(scene, kamera);   // tegnebufferen tømmes etter hvert bilde, så les den med en gang
    const kilde = renderer.domElement, c = document.createElement('canvas');
    c.width = kilde.width; c.height = kilde.height;
    const ctx = c.getContext('2d'), s = kilde.width / window.innerWidth, W = window.innerWidth, H = window.innerHeight;
    ctx.fillStyle = css('--bg3d'); ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(kilde, 0, 0);
    ctx.scale(s, s);
    ctx.textBaseline = 'middle';
    for (const el of document.querySelectorAll('#etiketter .etikett')) {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (cs.display === 'none' || !r.width || r.right < 0 || r.left > W || r.bottom < 0 || r.top > H) continue;
      if (!el.classList.contains('akse')) {
        ctx.fillStyle = css('--bg3d'); ctx.strokeStyle = cs.color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.rect(Math.round(r.left) + 0.5, Math.round(r.top) + 0.5, Math.round(r.width) - 1, Math.round(r.height) - 1); ctx.fill(); ctx.stroke();
      }
      ctx.fillStyle = cs.color; ctx.font = cs.fontWeight + ' ' + cs.fontSize + ' system-ui, "Segoe UI", sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(el.textContent, r.left + r.width / 2, r.top + r.height / 2 + 0.5);
    }
    // Fargeskala med egenskap, tidspunkt og grenser.
    const x = 16, bredde = 240, y = H - 74;
    ctx.fillStyle = css('--bg3d'); ctx.globalAlpha = 0.85; ctx.fillRect(x - 8, y - 12, bredde + 16, 74); ctx.globalAlpha = 1;
    ctx.textAlign = 'left'; ctx.fillStyle = css('--tekst'); ctx.font = '600 13px system-ui, "Segoe UI", sans-serif';
    const kart = kartModus() ? ' · ' + $('modus').selectedOptions[0].text : '';
    ctx.fillText((refSteg() != null ? 'Endring i ' + prop + ' siden ' + dato(grid.tider[refSteg()]) : prop) + kart, x, y);
    ctx.fillStyle = css('--dempet'); ctx.font = '12px system-ui, "Segoe UI", sans-serif';
    ctx.fillText((grid.tider.length > 1 ? dato(grid.tider[steg]) + ' · ' : '') + zs() + '× vertikalt', x, y + 17);
    ctx.drawImage($('legende').querySelector('canvas'), x, y + 28, bredde, 10);
    ctx.fillText($('legMin').textContent, x, y + 49);
    ctx.textAlign = 'right'; ctx.fillText($('legMax').textContent, x + bredde, y + 49);
    return c;
  }
  function lagreBilde() {
    if (!grid || !hud) return;
    const a = document.createElement('a');
    a.href = lagBilde().toDataURL('image/png');
    a.download = 'reservoarvisning-' + prop + (grid.tider.length > 1 ? '-' + new Date(grid.tider[steg]).toISOString().slice(0, 10) : '') + '.png';
    a.click();
  }
  $('lagreBilde').addEventListener('click', lagreBilde);

  // ---------- tastatursnarveier ----------
  const visHjelp = vis => { $('hjelp').style.display = vis ? 'grid' : 'none'; };
  $('visHjelp').addEventListener('click', () => visHjelp(true));
  $('lukkHjelp').addEventListener('click', () => visHjelp(false));
  $('hjelp').addEventListener('click', e => { if (e.target === $('hjelp')) visHjelp(false); });
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') return visHjelp(false);
    // Skriver brukeren i et felt eller styrer en glider, er tastene deres.
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === '?') return visHjelp($('hjelp').style.display !== 'grid');
    if (!grid || $('delt').style.display === 'grid') return;
    const kryss = id => { const el = $(id); if (el.offsetParent !== null && !el.disabled) el.click(); };
    const flereSteg = grid.tider.length > 1, k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === ' ' && flereSteg) $('spill').click();
    else if (k === 'ArrowRight' && flereSteg) { stoppSpill(); settSteg(steg + 1); }
    else if (k === 'ArrowLeft' && flereSteg) { stoppSpill(); settSteg(steg - 1); }
    else if (k === 'Home' && flereSteg) { stoppSpill(); settSteg(0); }
    else if (k === 'End' && flereSteg) { stoppSpill(); settSteg(grid.tider.length - 1); }
    else if (k === 't') tilpass(false);
    else if (k === 'o') tilpass(true);
    else if (k === 'k') kryss('kanter');
    else if (k === 'b') kryss('visBronner');
    else if (k === 'f') kryss('visForkast');
    else if (k === 'e') kryss('endring');
    else if (k === 'l') lagreVisning();
    else if (k === 'p') lagreBilde();
    else if (k >= '1' && k <= '9' && visningene[+k - 1]) brukTilstand(visningene[+k - 1].t);
    else return;
    e.preventDefault();
  });

  let dra = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dra++; $('slipp').style.display = 'grid'; });
  window.addEventListener('dragleave', () => { if (--dra <= 0) { dra = 0; $('slipp').style.display = 'none'; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); dra = 0; $('slipp').style.display = 'none';
    lastFiler(e.dataTransfer.files);
  });

  tema(); storrelse(); lagLut(); overdrivelse();

  // For feilsøking og automatisk testing i nettleseren.
  window.APP = { worker, get grid() { return grid; }, get hud() { return hud; }, get stat() { return stat; }, get steg() { return steg; },
    get venter() { return venter || ko; }, kamera, tilpass, plukk, settSteg, visSnitt, lastFiler, settKamera, settValg, kameraTilstand, tilstand, brukTilstand, lagBilde,
    kod, dekod, get visninger() { return visningene; } };
})();
