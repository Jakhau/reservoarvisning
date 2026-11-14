// Hjørnepunktgrid (corner-point) og ekstraksjon av synlige celleflater ("hud").
// Geometri: Ponting (1989), "Corner point geometry in reservoir simulation". Hver celle har
// åtte hjørner som ligger på fire pilarer (COORD) i dybdene gitt av ZCORN.
// Dybder er positive nedover (m). Ut til 3D: x = øst, y = opp, z = sør, sentrert om origo.
(function (root) {
  'use strict';

  const TOL = 0.01;   // m; større sprang enn dette mellom naboflater regnes som forkastning

  // Hjørnenummer c = di + 2·dj + 4·dk. Flatene i rekkefølgen I-, I+, J-, J+, K-, K+.
  const FLATER = [
    [0, 2, 6, 4], [1, 3, 7, 5],
    [0, 1, 5, 4], [2, 3, 7, 6],
    [0, 1, 3, 2], [4, 5, 7, 6]
  ];

  // Blokksentrert grid (DX/DY/DZ/TOPS) gjøres om til hjørnepunkt med loddrette pilarer.
  function fraBlokk(kw, nx, ny, nz) {
    const n = nx * ny * nz, nxy = nx * ny;
    const hent = (a, c) => a[c < a.length ? c : a.length - 1];
    const coord = new Float64Array(6 * (nx + 1) * (ny + 1));
    const xs = new Float64Array(nx + 1), ys = new Float64Array(ny + 1);
    for (let i = 0; i < nx; i++) xs[i + 1] = xs[i] + hent(kw.DX, i);
    for (let j = 0; j < ny; j++) ys[j + 1] = ys[j] + hent(kw.DY, j * nx);
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const p = 6 * (i + (nx + 1) * j);
      coord[p] = coord[p + 3] = xs[i];
      coord[p + 1] = coord[p + 4] = ys[j];
      coord[p + 2] = 0; coord[p + 5] = 1;
    }
    const zcorn = new Float32Array(8 * n);
    const sx = 2 * nx, sxy = 4 * nxy;
    const topp = new Float64Array(nxy);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const ij = i + nx * j, c = ij + nxy * k;
      if (c < kw.TOPS.length) topp[ij] = kw.TOPS[c];
      const z0 = topp[ij], z1 = z0 + hent(kw.DZ, c);
      for (let h = 0; h < 4; h++) {
        const q = (2 * i + (h & 1)) + sx * (2 * j + (h >> 1));
        zcorn[q + sxy * (2 * k)] = z0;
        zcorn[q + sxy * (2 * k + 1)] = z1;
      }
      topp[ij] = z1;
    }
    return { coord, zcorn };
  }

  // Omregning til SI-baserte «METRIC»-enheter (m, bar, m³) fra enhetssystemene FIELD og LAB.
  // Faktorer: 1 fot = 0,3048 m (eksakt), 1 psi = 0,0689476 bar, 1 rb = 0,1589873 m³,
  // 1 Mscf/stb = 178,1076 Sm³/Sm³, 1 atm = 1,01325 bar. Kilde: OPM Flow Reference Manual,
  // kap. 2 (enhetssystemer) og SPE Metric Standard (1982).
  const LENGDE = { FIELD: 0.3048, LAB: 0.01 };
  const FAKTOR = {
    FIELD: [[/^(DX|DY|DZ|TOPS|DEPTH|DZNET)$/, 0.3048], [/^(S?PRESSURE|PBUB|PDEW|PCOW|PCOG|PCW|PCG|SWATINIT_PC)$/, 0.0689476],
      [/^R?PORV$/, 0.1589873], [/^RS$/, 178.1076], [/^RV$/, 1 / 178.1076], [/^TRAN[XYZ]-?$/, 0.1589873 / 0.0689476]],
    LAB: [[/^(DX|DY|DZ|TOPS|DEPTH|DZNET)$/, 0.01], [/^(S?PRESSURE|PBUB|PDEW|PCOW|PCOG|PCW|PCG)$/, 1.01325], [/^R?PORV$/, 1e-6]]
  };
  function enhetFaktor(navn, enhet) {
    for (const [re, f] of FAKTOR[enhet] || []) if (re.test(navn)) return f;
    return 1;
  }

  // Sammendragsvektorer oppgir enheten som tekst; FIELD-enhetene regnes om til SI-baserte.
  // 1 stb = 0,1589873 m³, 1 Mscf = 28,31685 m³ (SPE Metric Standard 1982).
  const SI_ENHET = {
    'STB/DAY': [0.1589873, 'SM3/DAY'], 'STB': [0.1589873, 'SM3'], 'RB/DAY': [0.1589873, 'RM3/DAY'], 'RB': [0.1589873, 'RM3'],
    'MSCF/DAY': [28.31685, 'SM3/DAY'], 'MSCF': [28.31685, 'SM3'], 'PSIA': [0.0689476, 'BARSA'], 'PSI': [0.0689476, 'BAR'],
    'MSCF/STB': [178.1076, 'SM3/SM3'], 'STB/MSCF': [1 / 178.1076, 'SM3/SM3'], 'FT': [0.3048, 'M'],
    'STB/DAY/PSI': [0.1589873 / 0.0689476, 'SM3/DAY/BAR']
  };
  function enhetSI(enhet) { return SI_ENHET[String(enhet || '').toUpperCase()] || [1, enhet || '']; }

  // Skalert kopi. (TypedArray.from med funksjon er flere ganger tregere på store tabeller.)
  function skalert(a, f, Type) {
    const ut = new Type(a.length);
    for (let i = 0; i < a.length; i++) ut[i] = a[i] * f;
    return ut;
  }

  function lagGrid(kw) {
    const d = kw.SPECGRID || kw.DIMENS;
    if (!d || d.length < 3) throw new Error('Fant verken SPECGRID eller DIMENS. Slipp alle filene modellen består av samtidig.');
    const nx = d[0] | 0, ny = d[1] | 0, nz = d[2] | 0, n = nx * ny * nz, nxy = nx * ny;
    if (!(n > 0)) throw new Error('Ugyldige dimensjoner: ' + nx + ' × ' + ny + ' × ' + nz);
    let coord = kw.COORD, zcorn = kw.ZCORN;
    if (!coord || !zcorn) {
      if (kw.DX && kw.DY && kw.DZ && kw.TOPS) ({ coord, zcorn } = fraBlokk(kw, nx, ny, nz));
      else throw new Error('Fant ikke COORD/ZCORN (eller DX/DY/DZ/TOPS). Mangler en INCLUDE-fil?');
    }
    if (coord.length < 6 * (nx + 1) * (ny + 1)) throw new Error('COORD har ' + coord.length + ' verdier, ventet ' + 6 * (nx + 1) * (ny + 1));
    if (zcorn.length < 8 * n) throw new Error('ZCORN har ' + zcorn.length + ' verdier, ventet ' + 8 * n);

    brukOperasjoner(kw, nx, ny, nz);
    coord = kartakser(coord, kw.MAPAXES);
    // Geometrien regnes om til meter. En EGRID-fil oppgir sin egen lengdeenhet (GRIDUNIT).
    const enhet = kw._enhet || 'METRIC';
    const lf = kw._gridLengde || LENGDE[enhet] || 1;
    if (lf !== 1) {
      coord = skalert(coord, lf, Float64Array);
      zcorn = skalert(zcorn, lf, Float32Array);
    }

    const sx = 2 * nx, sxy = 4 * nxy;
    const act = new Uint8Array(n);
    const brudd = new Uint8Array(n);   // bit 0/1/2: flaten mot +I/+J/+K passer ikke med naboen
    let antAktive = 0, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = i + nx * j + nxy * k;
      const q = 2 * i + sx * 2 * j + sxy * 2 * k;
      // Celler uten tykkelse (utkiling) vises ikke.
      const tykk = Math.max(
        Math.abs(zcorn[q + sxy] - zcorn[q]), Math.abs(zcorn[q + 1 + sxy] - zcorn[q + 1]),
        Math.abs(zcorn[q + sx + sxy] - zcorn[q + sx]), Math.abs(zcorn[q + sx + 1 + sxy] - zcorn[q + sx + 1]));
      if ((!kw.ACTNUM || kw.ACTNUM[c] > 0) && tykk > 1e-6) {
        act[c] = 1; antAktive++;
        for (let h = 0; h < 4; h++) {
          const a = zcorn[q + (h & 1) + sx * (h >> 1)], b = zcorn[q + (h & 1) + sx * (h >> 1) + sxy];
          if (a < z0) z0 = a; if (a > z1) z1 = a;
          if (b < z0) z0 = b; if (b > z1) z1 = b;
        }
      }
      let m = 0;
      if (i < nx - 1) {
        const a = q + 1;
        if (Math.abs(zcorn[a] - zcorn[a + 1]) > TOL || Math.abs(zcorn[a + sx] - zcorn[a + sx + 1]) > TOL ||
            Math.abs(zcorn[a + sxy] - zcorn[a + sxy + 1]) > TOL || Math.abs(zcorn[a + sx + sxy] - zcorn[a + sx + sxy + 1]) > TOL) m |= 1;
      }
      if (j < ny - 1) {
        const a = q + sx;
        if (Math.abs(zcorn[a] - zcorn[a + sx]) > TOL || Math.abs(zcorn[a + 1] - zcorn[a + 1 + sx]) > TOL ||
            Math.abs(zcorn[a + sxy] - zcorn[a + sxy + sx]) > TOL || Math.abs(zcorn[a + 1 + sxy] - zcorn[a + 1 + sxy + sx]) > TOL) m |= 2;
      }
      if (k < nz - 1) {
        const a = q + sxy;
        if (Math.abs(zcorn[a] - zcorn[a + sxy]) > TOL || Math.abs(zcorn[a + 1] - zcorn[a + 1 + sxy]) > TOL ||
            Math.abs(zcorn[a + sx] - zcorn[a + sx + sxy]) > TOL || Math.abs(zcorn[a + sx + 1] - zcorn[a + sx + 1 + sxy]) > TOL) m |= 4;
      }
      brudd[c] = m;
    }
    if (antAktive === 0) throw new Error('Modellen har ingen aktive celler.');

    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let p = 0, e = 6 * (nx + 1) * (ny + 1); p < e; p += 3) {
      const x = coord[p], y = coord[p + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }

    const props = {};
    for (const navn of Object.keys(kw)) {
      const a = kw[navn];
      if (a.length !== n || navn === 'ACTNUM' || navn === 'ZCORN' || navn === 'COORD') continue;
      const f = enhetFaktor(navn, enhet);
      props[navn] = f !== 1 ? skalert(a, f, Float32Array) : a instanceof Float32Array ? a : Float32Array.from(a);
    }
    // Dybde til cellesenteret finnes alltid, også når modellen ikke har egenskaper.
    if (!props.DEPTH) {
      const dyp = new Float32Array(n);
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const q = 2 * i + sx * 2 * j + sxy * 2 * k;
        dyp[i + nx * j + nxy * k] = (zcorn[q] + zcorn[q + 1] + zcorn[q + sx] + zcorn[q + sx + 1] +
          zcorn[q + sxy] + zcorn[q + 1 + sxy] + zcorn[q + sx + sxy] + zcorn[q + sx + 1 + sxy]) / 8;
      }
      props.DEPTH = dyp;
    }

    return {
      nx, ny, nz, n, coord, zcorn, act, brudd, props, antAktive, enhet,
      bbox: { x0, x1, y0, y1, z0, z1 },
      origo: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]
    };
  }

  // De åtte hjørnene til celle (i,j,k) i 3D-koordinater, skrevet til ut[0..24).
  function hjorner(g, i, j, k, ut) {
    const { nx, ny, coord, zcorn, origo } = g;
    const sx = 2 * nx, sxy = 4 * nx * ny;
    for (let c = 0; c < 8; c++) {
      const di = c & 1, dj = (c >> 1) & 1, dk = c >> 2;
      const z = zcorn[(2 * i + di) + sx * (2 * j + dj) + sxy * (2 * k + dk)];
      const p = 6 * ((i + di) + (nx + 1) * (j + dj));
      const xt = coord[p], yt = coord[p + 1], zt = coord[p + 2];
      const zb = coord[p + 5];
      let x = xt, y = yt;
      if (zb !== zt) {
        const t = (z - zt) / (zb - zt);
        x = xt + t * (coord[p + 3] - xt);
        y = yt + t * (coord[p + 4] - yt);
      }
      ut[3 * c] = x - origo[0];
      ut[3 * c + 1] = origo[2] - z;
      ut[3 * c + 2] = origo[1] - y;
    }
    return ut;
  }

  // Finner flatene som faktisk er synlige: flater mot inaktive/filtrerte celler, mot kanten
  // av modellen og langs forkastninger. Innvendige flater tegnes aldri, så en modell med
  // millioner av celler gir bare noen hundre tusen firkanter.
  // Egenskapsfiltre: filter.filtre = [{ a, pmin, pmax }] der alle må være oppfylt (NaN faller
  // utenfor). Den eldre formen { prop, pmin, pmax } er ett slikt filter.
  function filterliste(f) {
    const inn = f.filtre ? f.filtre.slice() : [];
    if (f.prop) inn.push({ a: f.prop, pmin: f.pmin, pmax: f.pmax });
    const ut = inn.filter(x => x && x.a).map(x => ({ a: x.a, lo: x.pmin == null ? -Infinity : x.pmin, hi: x.pmax == null ? Infinity : x.pmax }));
    return ut.length ? ut : null;
  }
  function passerer(filtre, c) {
    for (let q = 0; q < filtre.length; q++) { const v = filtre[q].a[c]; if (!(v >= filtre[q].lo && v <= filtre[q].hi)) return false; }
    return true;
  }

  // filter: { i0,i1,j0,j1,k0,k1 } (0-basert, inklusive) og valgfritt egenskapsfiltre, se filterliste.
  function hud(g, filter) {
    if (filter && filter.modus === 'snitt') return snitt(g, filter);
    if (filter && filter.modus === 'kart') return kart(g, filter);
    const { nx, ny, nz, n, act, brudd } = g;
    const nxy = nx * ny;
    const f = filter || {};
    const kl = (v, std, maks) => Math.max(0, Math.min(maks, v == null ? std : v | 0));
    const i0 = kl(f.i0, 0, nx - 1), i1 = kl(f.i1, nx - 1, nx - 1);
    const j0 = kl(f.j0, 0, ny - 1), j1 = kl(f.j1, ny - 1, ny - 1);
    const k0 = kl(f.k0, 0, nz - 1), k1 = kl(f.k1, nz - 1, nz - 1);
    const filtre = filterliste(f);

    const syn = new Uint8Array(n);
    let antCeller = 0;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) {
      let c = i0 + nx * j + nxy * k;
      for (let i = i0; i <= i1; i++, c++) {
        if (!act[c]) continue;
        if (filtre && !passerer(filtre, c)) continue;
        syn[c] = 1; antCeller++;
      }
    }

    const maske = new Uint8Array(n);
    let nf = 0;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) {
      let c = i0 + nx * j + nxy * k;
      for (let i = i0; i <= i1; i++, c++) {
        if (!syn[c]) continue;
        let m = 0;
        if (i === 0 || !syn[c - 1] || (brudd[c - 1] & 1)) { m |= 1; nf++; }
        if (i === nx - 1 || !syn[c + 1] || (brudd[c] & 1)) { m |= 2; nf++; }
        if (j === 0 || !syn[c - nx] || (brudd[c - nx] & 2)) { m |= 4; nf++; }
        if (j === ny - 1 || !syn[c + nx] || (brudd[c] & 2)) { m |= 8; nf++; }
        if (k === 0 || !syn[c - nxy] || (brudd[c - nxy] & 4)) { m |= 16; nf++; }
        if (k === nz - 1 || !syn[c + nxy] || (brudd[c] & 4)) { m |= 32; nf++; }
        maske[c] = m;
      }
    }

    const pos = new Float32Array(nf * 12);
    const celle = new Uint32Array(nf);
    const hj = new Float64Array(24);
    let w = 0, fi = 0;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) {
      let c = i0 + nx * j + nxy * k;
      for (let i = i0; i <= i1; i++, c++) {
        const m = maske[c];
        if (!m) continue;
        hjorner(g, i, j, k, hj);
        for (let s = 0; s < 6; s++) {
          if (!(m & (1 << s))) continue;
          const fl = FLATER[s];
          for (let h = 0; h < 4; h++) {
            const q = 3 * fl[h];
            pos[w++] = hj[q]; pos[w++] = hj[q + 1]; pos[w++] = hj[q + 2];
          }
          celle[fi++] = c;
        }
      }
    }
    return { pos, celle, antFlater: nf, antCeller, syn };
  }

  // Trekantindekser og hjørnekoordinater (0/1) per firkant; brukes til cellekanter i shaderen.
  function flateAttributter(nf) {
    const idx = new Uint32Array(nf * 6), hj = new Uint8Array(nf * 8);
    for (let f = 0; f < nf; f++) {
      const v = 4 * f, a = 6 * f, b = 8 * f;
      idx[a] = v; idx[a + 1] = v + 1; idx[a + 2] = v + 2;
      idx[a + 3] = v; idx[a + 4] = v + 2; idx[a + 5] = v + 3;
      hj[b + 2] = 1; hj[b + 4] = 1; hj[b + 5] = 1; hj[b + 7] = 1;
    }
    return { idx, hj };
  }

  // ---------- operasjoner og kartakser ----------
  // EQUALS, COPY, MULTIPLY, ADD, MINVALUE, MAXVALUE og data gitt inne i BOX/ENDBOX, utført i
  // den rekkefølgen de står i filene. Post: navn, verdi, I1 I2 J1 J2 K1 K2 (1-basert; uten
  // boks gjelder gjeldende BOX, ellers hele gridet). Kilde: OPM Flow Reference Manual.
  const standardverdi = navn => (navn === 'ACTNUM' || navn === 'NTG' || /^MULT/.test(navn)) ? 1 : 0;
  function brukOperasjoner(kw, nx, ny, nz) {
    const n = nx * ny * nz, nxy = nx * ny, maks = [nx, nx, ny, ny, nz, nz];
    const hent = (navn, lag) => {
      if (typeof navn !== 'string') return null;
      navn = navn.toUpperCase();
      let a = kw[navn];
      if (a && a.length === n) return a;
      if (!lag) return null;
      a = new Float32Array(n);
      if (standardverdi(navn)) a.fill(1);
      kw[navn] = a;
      return a;
    };
    const boksAv = (r, o, std) => {
      const b = [1, nx, 1, ny, 1, nz];
      for (let q = 0; q < 6; q++) {
        let v = r ? r[o + q] : null;
        if (v == null && std) v = std[q];
        if (typeof v === 'number' && v >= 1) b[q] = Math.min(maks[q], v | 0);
      }
      return b;
    };
    const forBoks = (b, fn) => {
      let q = 0;
      for (let k = b[4] - 1; k < b[5]; k++) for (let j = b[2] - 1; j < b[3]; j++) for (let i = b[0] - 1; i < b[1]; i++) fn(i + nx * j + nxy * k, q++);
    };
    for (const o of kw._ops || []) {
      if (o.op === 'BOKSDATA') {
        const b = boksAv(null, 0, o.boks), ant = (b[1] - b[0] + 1) * (b[3] - b[2] + 1) * (b[5] - b[4] + 1);
        if (ant <= 0 || o.data.length < ant) continue;
        const a = hent(o.navn, true);
        forBoks(b, (c, q) => { a[c] = o.data[q]; });
        continue;
      }
      const r = o.post;
      if (o.op === 'COPY') {
        const fra = hent(r[0], false);
        if (!fra) continue;
        const til = hent(r[1], true);
        if (til) forBoks(boksAv(r, 2, o.boks), c => { til[c] = fra[c]; });
        continue;
      }
      const v = r[1];
      if (typeof v !== 'number') continue;
      const a = hent(r[0], o.op === 'EQUALS');
      if (!a) continue;
      const b = boksAv(r, 2, o.boks);
      if (o.op === 'EQUALS') forBoks(b, c => { a[c] = v; });
      else if (o.op === 'MULTIPLY') forBoks(b, c => { a[c] *= v; });
      else if (o.op === 'ADD') forBoks(b, c => { a[c] += v; });
      else if (o.op === 'MINVALUE') forBoks(b, c => { if (a[c] < v) a[c] = v; });
      else if (o.op === 'MAXVALUE') forBoks(b, c => { if (a[c] > v) a[c] = v; });
    }
  }

  // MAPAXES: x1 y1 (punkt på gridets y-akse), x0 y0 (origo), x2 y2 (punkt på x-aksen), i
  // kartkoordinater. Gridkoordinatene dreies og flyttes over i kartsystemet.
  function kartakser(coord, m) {
    if (!m || m.length < 6) return coord;
    const ox = m[2], oy = m[3];
    let ux = m[4] - ox, uy = m[5] - oy, vx = m[0] - ox, vy = m[1] - oy;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (!(lu > 0 && lv > 0)) return coord;
    ux /= lu; uy /= lu; vx /= lv; vy /= lv;
    if (ox === 0 && oy === 0 && ux === 1 && uy === 0 && vx === 0 && vy === 1) return coord;
    const ut = new Float64Array(coord.length);
    for (let p = 0; p + 2 < coord.length; p += 3) {
      const x = coord[p], y = coord[p + 1];
      ut[p] = ox + x * ux + y * vx;
      ut[p + 1] = oy + x * uy + y * vy;
      ut[p + 2] = coord[p + 2];
    }
    return ut;
  }

  // ---------- utvalg, volum ----------
  function synlige(g, f) {
    const { nx, ny, nz, n, act } = g, nxy = nx * ny;
    f = f || {};
    const kl = (v, std, maks) => Math.max(0, Math.min(maks, v == null ? std : v | 0));
    const r = [kl(f.i0, 0, nx - 1), kl(f.i1, nx - 1, nx - 1), kl(f.j0, 0, ny - 1), kl(f.j1, ny - 1, ny - 1), kl(f.k0, 0, nz - 1), kl(f.k1, nz - 1, nz - 1)];
    const filtre = filterliste(f);
    const syn = new Uint8Array(n);
    let antCeller = 0;
    for (let k = r[4]; k <= r[5]; k++) for (let j = r[2]; j <= r[3]; j++) {
      let c = r[0] + nx * j + nxy * k;
      for (let i = r[0]; i <= r[1]; i++, c++) {
        if (!act[c]) continue;
        if (filtre && !passerer(filtre, c)) continue;
        syn[c] = 1; antCeller++;
      }
    }
    return { syn, antCeller, r };
  }

  // Cellevolum (m³): cellen deles i 24 tetraedre fra sentrum via flatemidtpunktene.
  // Eksakt for celler med plane flater, og en god tilnærming ellers.
  function cellevolum(g) {
    if (g._vol) return g._vol;
    const { nx, ny, n, act } = g, nxy = nx * ny;
    const vol = new Float32Array(n), h = new Float64Array(24);
    for (let c = 0; c < n; c++) {
      if (!act[c]) continue;
      hjorner(g, c % nx, Math.floor(c / nx) % ny, Math.floor(c / nxy), h);
      let cx = 0, cy = 0, cz = 0;
      for (let q = 0; q < 8; q++) { cx += h[3 * q]; cy += h[3 * q + 1]; cz += h[3 * q + 2]; }
      cx /= 8; cy /= 8; cz /= 8;
      let v = 0;
      for (let s = 0; s < 6; s++) {
        const fl = FLATER[s];
        let mx = 0, my = 0, mz = 0;
        for (let q = 0; q < 4; q++) { mx += h[3 * fl[q]]; my += h[3 * fl[q] + 1]; mz += h[3 * fl[q] + 2]; }
        mx = mx / 4 - cx; my = my / 4 - cy; mz = mz / 4 - cz;
        for (let q = 0; q < 4; q++) {
          const a = 3 * fl[q], b = 3 * fl[(q + 1) & 3];
          const ax = h[a] - cx, ay = h[a + 1] - cy, az = h[a + 2] - cz;
          const bx = h[b] - cx, by = h[b + 1] - cy, bz = h[b + 2] - cz;
          v += Math.abs(ax * (by * mz - bz * my) - ay * (bx * mz - bz * mx) + az * (bx * my - by * mx)) / 6;
        }
      }
      vol[c] = v;
    }
    return (g._vol = vol);
  }

  // Bulkvolum, porevolum og hydrokarbonporevolum for utvalget. Porevolum = PORV når den finnes
  // (fra INIT), ellers V·PORO·NTG. HCPV = PV·(1 − Sw). Med gassmetning deles HCPV i
  // gass = PV·Sg og olje = PV·(1 − Sw − Sg); alt er volum ved reservoarforhold.
  function volum(g, syn, a) {
    const vol = cellevolum(g);
    a = a || {};
    const harPv = !!(a.porv || a.poro);
    let bulk = 0, pv = 0, hc = 0, gass = 0;
    for (let c = 0; c < g.n; c++) {
      if (!syn[c]) continue;
      bulk += vol[c];
      if (!harPv) continue;
      const p = a.porv ? a.porv[c] : vol[c] * a.poro[c] * (a.ntg ? a.ntg[c] : 1);
      if (p !== p) continue;
      pv += p;
      if (a.sw) {
        const s = a.sw[c];
        if (s !== s) continue;
        hc += p * (1 - s);
        if (a.sg) { const sg = a.sg[c]; if (sg === sg) gass += p * Math.min(sg, 1 - s); }
      }
    }
    const delt = harPv && a.sw && a.sg;
    return { bulk, pv: harPv ? pv : null, hcpv: harPv && a.sw ? hc : null, gass: delt ? gass : null, olje: delt ? hc - gass : null };
  }

  // ---------- tverrsnitt ----------
  // Pilarenes kartposisjon i modellens middeldybde; brukes til å finne hvilken kolonne et punkt ligger i.
  function pilarXY(g) {
    if (g._pxy) return g._pxy;
    const { nx, ny, coord } = g, np = (nx + 1) * (ny + 1), a = new Float64Array(2 * np), zm = g.origo[2];
    for (let p = 0; p < np; p++) {
      const q = 6 * p, zt = coord[q + 2], zb = coord[q + 5];
      const t = zb !== zt ? (zm - zt) / (zb - zt) : 0;
      a[2 * p] = coord[q] + t * (coord[q + 3] - coord[q]);
      a[2 * p + 1] = coord[q + 1] + t * (coord[q + 4] - coord[q + 1]);
    }
    return (g._pxy = a);
  }

  // Lokale koordinater (u, v) for punktet (x, y) i kolonnens firkant: invers bilineær avbildning med Newton.
  function lokal(g, pxy, i, j, x, y, ut) {
    const w = g.nx + 1, a = 2 * (i + w * j), b = a + 2, c = a + 2 * w, d = c + 2;
    const x00 = pxy[a], y00 = pxy[a + 1], x10 = pxy[b], y10 = pxy[b + 1];
    const x01 = pxy[c], y01 = pxy[c + 1], x11 = pxy[d], y11 = pxy[d + 1];
    let u = 0.5, v = 0.5;
    for (let it = 0; it < 8; it++) {
      const fx = (1 - u) * (1 - v) * x00 + u * (1 - v) * x10 + (1 - u) * v * x01 + u * v * x11 - x;
      const fy = (1 - u) * (1 - v) * y00 + u * (1 - v) * y10 + (1 - u) * v * y01 + u * v * y11 - y;
      const xu = (1 - v) * (x10 - x00) + v * (x11 - x01), xv = (1 - u) * (x01 - x00) + u * (x11 - x10);
      const yu = (1 - v) * (y10 - y00) + v * (y11 - y01), yv = (1 - u) * (y01 - y00) + u * (y11 - y10);
      const det = xu * yv - xv * yu;
      if (Math.abs(det) < 1e-12) break;
      u -= (fx * yv - fy * xv) / det;
      v -= (fy * xu - fx * yu) / det;
    }
    ut[0] = u; ut[1] = v;
  }

  // Kolonnen (i + nx·j) som inneholder (x, y), eller −1. Går nabo for nabo fra `start` når den er kjent.
  function finnKolonne(g, pxy, x, y, start, uv) {
    const { nx, ny } = g, e = 1e-9;
    if (start >= 0) {
      let i = start % nx, j = (start / nx) | 0;
      for (let it = 0; it < nx + ny + 4; it++) {
        lokal(g, pxy, i, j, x, y, uv);
        let flyttet = false;
        if (uv[0] < -e) { i--; flyttet = true; } else if (uv[0] > 1 + e) { i++; flyttet = true; }
        if (uv[1] < -e) { j--; flyttet = true; } else if (uv[1] > 1 + e) { j++; flyttet = true; }
        if (i < 0 || i >= nx || j < 0 || j >= ny) return -1;
        if (!flyttet) return i + nx * j;
      }
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      lokal(g, pxy, i, j, x, y, uv);
      if (uv[0] >= -e && uv[0] <= 1 + e && uv[1] >= -e && uv[1] <= 1 + e) return i + nx * j;
    }
    return -1;
  }

  // Loddrett snitt langs en knekklinje. f.linje = [[x, z], …] i 3D-koordinater (x øst, z sør).
  // For hver kolonne linja krysser tegnes én firkant per synlig celle, med topp og bunn
  // interpolert bilineært fra cellens hjørnedybder.
  function snitt(g, f) {
    const s = synlige(g, f), syn = s.syn, r = s.r;
    const { nx, ny, zcorn, origo, bbox } = g, nxy = nx * ny, sx = 2 * nx, sxy = 4 * nxy;
    const pxy = pilarXY(g), uv = [0, 0], pos = [], celle = [];
    const steg = 0.2 * Math.sqrt((bbox.x1 - bbox.x0) * (bbox.y1 - bbox.y0) / nxy) || 1;
    const linje = (f.linje || []).map(p => [p[0] + origo[0], origo[1] - p[1]]);
    const zi = (q, u, v) => (1 - u) * (1 - v) * zcorn[q] + u * (1 - v) * zcorn[q + 1] + (1 - u) * v * zcorn[q + sx] + u * v * zcorn[q + sx + 1];
    const kl = v => v < 0 ? 0 : v > 1 ? 1 : v;
    let forrige = -1;
    for (let l = 0; l + 1 < linje.length; l++) {
      const P = linje[l], Q = linje[l + 1], L = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
      if (!(L > 0)) continue;
      const m = Math.max(1, Math.min(20000, Math.ceil(L / steg)));
      const lukk = (kol, tA, tB) => {
        const i = kol % nx, j = (kol / nx) | 0;
        if (i < r[0] || i > r[1] || j < r[2] || j > r[3]) return;
        const xa = P[0] + tA * (Q[0] - P[0]), ya = P[1] + tA * (Q[1] - P[1]);
        const xb = P[0] + tB * (Q[0] - P[0]), yb = P[1] + tB * (Q[1] - P[1]);
        lokal(g, pxy, i, j, xa, ya, uv); const ua = kl(uv[0]), va = kl(uv[1]);
        lokal(g, pxy, i, j, xb, yb, uv); const ub = kl(uv[0]), vb = kl(uv[1]);
        for (let k = r[4]; k <= r[5]; k++) {
          const c = kol + nxy * k;
          if (!syn[c]) continue;
          const q = 2 * i + sx * 2 * j + sxy * 2 * k;
          const ta = zi(q, ua, va), tb = zi(q, ub, vb), ba = zi(q + sxy, ua, va), bb = zi(q + sxy, ub, vb);
          pos.push(xa - origo[0], origo[2] - ta, origo[1] - ya, xb - origo[0], origo[2] - tb, origo[1] - yb,
            xb - origo[0], origo[2] - bb, origo[1] - yb, xa - origo[0], origo[2] - ba, origo[1] - ya);
          celle.push(c);
        }
      };
      const kolVed = (t, start) => finnKolonne(g, pxy, P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1]), start, uv);
      // Halverer seg fram til der linja forlater kolonnen `kol` mellom tInne og tUte.
      const grense = (tInne, tUte, kol) => {
        for (let it = 0; it < 14; it++) { const tm = (tInne + tUte) / 2; if (kolVed(tm, kol) === kol) tInne = tm; else tUte = tm; }
        return tInne;
      };
      // Prøver langs linja; like kolonner etter hverandre slås sammen, og overgangene finnes nøyaktig.
      let kolonne = -1, fra = 0;
      for (let q = 0; q < m; q++) {
        const t = (q + 0.5) / m;
        const kol = kolVed(t, forrige);
        if (kol >= 0) forrige = kol;
        if (kol === kolonne) continue;
        const tf = q === 0 ? 0 : (q - 0.5) / m;
        let skifte = tf;
        if (kolonne >= 0) { skifte = grense(tf, t, kolonne); lukk(kolonne, fra, skifte); }
        else if (kol >= 0) skifte = grense(t, tf, kol);
        kolonne = kol; fra = skifte;
      }
      if (kolonne >= 0) lukk(kolonne, fra, grense((m - 0.5) / m, 1, kolonne));
    }
    return { pos: Float32Array.from(pos), celle: Uint32Array.from(celle), antFlater: celle.length, antCeller: s.antCeller, syn };
  }

  // ---------- kart ----------
  // Én verdi per kolonne over de synlige cellene: 'snitt' (gjennomsnitt), 'sum' eller 'tykkelse'
  // (sum av celletykkelser). Tegnes på toppflaten av øverste synlige celle.
  function kart(g, f) {
    const s = synlige(g, f), syn = s.syn, r = s.r;
    const { nx, ny, zcorn } = g, nxy = nx * ny, sx = 2 * nx, sxy = 4 * nxy;
    const prop = f.kartProp || null, type = f.kart || 'snitt';
    const pos = [], celle = [], verdier = [], hj = new Float64Array(24);
    let min = Infinity, max = -Infinity;
    for (let j = r[2]; j <= r[3]; j++) for (let i = r[0]; i <= r[1]; i++) {
      let sum = 0, ant = 0, tyk = 0, topp = -1;
      for (let k = r[4]; k <= r[5]; k++) {
        const c = i + nx * j + nxy * k;
        if (!syn[c]) continue;
        if (topp < 0) topp = k;
        const q = 2 * i + sx * 2 * j + sxy * 2 * k;
        tyk += (zcorn[q + sxy] - zcorn[q] + zcorn[q + 1 + sxy] - zcorn[q + 1] +
          zcorn[q + sx + sxy] - zcorn[q + sx] + zcorn[q + sx + 1 + sxy] - zcorn[q + sx + 1]) / 4;
        if (prop) { const v = prop[c]; if (v === v) { sum += v; ant++; } }
      }
      if (topp < 0) continue;
      const v = type === 'tykkelse' ? tyk : !ant ? NaN : type === 'sum' ? sum : sum / ant;
      hjorner(g, i, j, topp, hj);
      for (let h = 0; h < 4; h++) { const q = 3 * FLATER[4][h]; pos.push(hj[q], hj[q + 1], hj[q + 2]); }
      celle.push(i + nx * j + nxy * topp);
      verdier.push(v);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === Infinity) { min = 0; max = 1; }
    return { pos: Float32Array.from(pos), celle: Uint32Array.from(celle), antFlater: celle.length, antCeller: s.antCeller, syn,
      verdiFlate: Float32Array.from(verdier), omrade: { min, max } };
  }

  // ---------- forkastninger ----------
  // FAULTS-poster: navn, I1 I2 J1 J2 K1 K2 (1-basert) og flate (X, Y, Z, eventuelt med minus
  // eller som I/J/K). Kilde: OPM Flow Reference Manual, FAULTS.
  // Gir to flatesett: hele celleflaten på forkastningen, og «kontakt», som bare er den delen
  // der en aktiv celle faktisk ligger mot en aktiv celle på den andre siden (sand mot sand,
  // som i et Allan-diagram). Sprang er middelforskjellen i dybde for samme lag på de to sidene.
  const FLATENAVN = { X: 1, 'X+': 1, I: 1, 'I+': 1, 'X-': 0, 'I-': 0, Y: 3, 'Y+': 3, J: 3, 'J+': 3, 'Y-': 2, 'J-': 2,
    Z: 5, 'Z+': 5, K: 5, 'K+': 5, 'Z-': 4, 'K-': 4 };
  function forkastninger(g, poster) {
    const { nx, ny, nz, act, zcorn, coord, origo } = g, nxy = nx * ny, sx = 2 * nx, sxy = 4 * nxy;
    const steg = [-1, 1, -nx, nx, -nxy, nxy];
    const navn = [], indeks = new Map(), pos = [], eier = [], sprang = [], kpos = [], keier = [], ksprang = [];
    const hj = new Float64Array(24), pa = [0, 0, 0], pb = [0, 0, 0];
    // Dybde på en sideflate: akse 0 = I-flate (side velger di, e velger dj), akse 1 = J-flate.
    const zf = (i, j, k, akse, side, e, dk) => akse === 0
      ? zcorn[(2 * i + side) + sx * (2 * j + e) + sxy * (2 * k + dk)]
      : zcorn[(2 * i + e) + sx * (2 * j + side) + sxy * (2 * k + dk)];
    const pilar = (p, z, ut) => {
      const q = 6 * p, zt = coord[q + 2], zb = coord[q + 5], t = zb !== zt ? (z - zt) / (zb - zt) : 0;
      ut[0] = coord[q] + t * (coord[q + 3] - coord[q]) - origo[0];
      ut[1] = origo[2] - z;
      ut[2] = origo[1] - (coord[q + 1] + t * (coord[q + 4] - coord[q + 1]));
    };
    const kryss = (ss, f0, f1, g0, g1) => {
      const d0 = f0 - g0, d1 = f1 - g1;
      if (d0 * d1 < 0) ss.push(d0 / (d0 - d1));
    };
    for (const r of poster || []) {
      const s = FLATENAVN[String(r[7] == null ? 'X' : r[7]).toUpperCase()];
      if (s == null || typeof r[0] !== 'string') continue;
      const i0 = Math.max(1, r[1] | 0) - 1, i1 = Math.min(nx, r[2] | 0) - 1;
      const j0 = Math.max(1, r[3] | 0) - 1, j1 = Math.min(ny, r[4] | 0) - 1;
      const k0 = Math.max(1, r[5] | 0) - 1, k1 = Math.min(nz, r[6] | 0) - 1;
      if (!indeks.has(r[0])) { indeks.set(r[0], navn.length); navn.push(r[0]); }
      const nr = indeks.get(r[0]), akse = s >> 1, side = s & 1;
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const c = i + nx * j + nxy * k;
        const ij = akse === 0 ? i : akse === 1 ? j : k, maks = akse === 0 ? nx : akse === 1 ? ny : nz;
        const harNabo = side ? ij < maks - 1 : ij > 0;
        const d = side ? 1 : -1, ni = akse === 0 ? i + d : i, nj = akse === 1 ? j + d : j;
        let spr = 0;
        if (akse < 2 && harNabo && act[c] && act[c + steg[s]]) {   // sprang gir bare mening mellom to aktive celler
          spr =(Math.abs(zf(i, j, k, akse, side, 0, 0) - zf(ni, nj, k, akse, 1 - side, 0, 0)) +
                 Math.abs(zf(i, j, k, akse, side, 1, 0) - zf(ni, nj, k, akse, 1 - side, 1, 0))) / 2;
        }
        // Inaktive celler kan ha vilkårlig geometri. Er cellen inaktiv, brukes naboens motstående flate.
        let fs = s, ci = i, cj = j, ck = k;
        if (!act[c]) {
          if (!(harNabo && act[c + steg[s]])) continue;
          if (akse === 0) ci += d; else if (akse === 1) cj += d; else ck += d;
          fs = s ^ 1;
        }
        hjorner(g, ci, cj, ck, hj);
        for (let h = 0; h < 4; h++) { const q = 3 * FLATER[fs][h]; pos.push(hj[q], hj[q + 1], hj[q + 2]); }
        eier.push(nr); sprang.push(spr);

        if (akse > 1 || !harNabo || !act[c]) continue;
        const tA0 = zf(i, j, k, akse, side, 0, 0), tA1 = zf(i, j, k, akse, side, 1, 0);
        const bA0 = zf(i, j, k, akse, side, 0, 1), bA1 = zf(i, j, k, akse, side, 1, 1);
        const p0 = akse === 0 ? (i + side) + (nx + 1) * j : i + (nx + 1) * (j + side);
        const p1 = akse === 0 ? p0 + nx + 1 : p0 + 1;
        for (let kb = 0; kb < nz; kb++) {
          if (!act[ni + nx * nj + nxy * kb]) continue;
          const tB0 = zf(ni, nj, kb, akse, 1 - side, 0, 0), tB1 = zf(ni, nj, kb, akse, 1 - side, 1, 0);
          const bB0 = zf(ni, nj, kb, akse, 1 - side, 0, 1), bB1 = zf(ni, nj, kb, akse, 1 - side, 1, 1);
          if (tB0 >= bA0 && tB1 >= bA1) continue;
          if (bB0 <= tA0 && bB1 <= tA1) continue;
          // Topp og bunn er lineære langs flaten. Mellom to krysningspunkter er overlappet en firkant.
          const ss = [0, 1];
          kryss(ss, tA0, tA1, tB0, tB1); kryss(ss, bA0, bA1, bB0, bB1);
          kryss(ss, tA0, tA1, bB0, bB1); kryss(ss, tB0, tB1, bA0, bA1);
          ss.sort((a, b) => a - b);
          for (let q = 0; q + 1 < ss.length; q++) {
            const sL = ss[q], sR = ss[q + 1];
            if (sR - sL < 1e-9) continue;
            const tL = Math.max(tA0 + sL * (tA1 - tA0), tB0 + sL * (tB1 - tB0)), bL = Math.min(bA0 + sL * (bA1 - bA0), bB0 + sL * (bB1 - bB0));
            const tR = Math.max(tA0 + sR * (tA1 - tA0), tB0 + sR * (tB1 - tB0)), bR = Math.min(bA0 + sR * (bA1 - bA0), bB0 + sR * (bB1 - bB0));
            if (bL - tL < -1e-6 || bR - tR < -1e-6 || (bL - tL) + (bR - tR) < 1e-4) continue;
            for (const [sv, zv] of [[sL, tL], [sR, tR], [sR, Math.max(tR, bR)], [sL, Math.max(tL, bL)]]) {
              pilar(p0, zv, pa); pilar(p1, zv, pb);
              kpos.push(pa[0] + sv * (pb[0] - pa[0]), pa[1], pa[2] + sv * (pb[2] - pa[2]));
            }
            keier.push(nr); ksprang.push(spr);
          }
        }
      }
    }
    return {
      navn, pos: new Float32Array(pos), eier: new Uint16Array(eier), sprang: new Float32Array(sprang), antFlater: eier.length,
      kontakt: { pos: new Float32Array(kpos), eier: new Uint16Array(keier), sprang: new Float32Array(ksprang), antFlater: keier.length }
    };
  }

  // ---------- brønner ----------
  const MND = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, JLY: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  function datoAv(r) {
    const m = MND[String(r[1]).toUpperCase().slice(0, 3)];
    return m == null || !(r[2] > 0) ? null : Date.UTC(r[2], m, (r[0] | 0) || 1);
  }
  // Alle datoer i DATES, sortert (millisekunder siden 1970, UTC).
  function tidspunkter(hendelser) {
    const s = new Set();
    for (const [n, r] of hendelser || []) if (n === 'DATES') { const t = datoAv(r); if (t != null) s.add(t); }
    return Array.from(s).sort((a, b) => a - b);
  }

  // Brønner fra WELSPECS (navn, gruppe, brønnhode I J) og COMPDAT (navn, I, J, K1, K2).
  // Simuleringsmodellen inneholder ikke brønnbaner, bare hvilke celler brønnen er koblet til.
  // Banen tegnes derfor gjennom cellesentrene i den rekkefølgen koblingene står i fila, med
  // en rett strek opp til et punkt over modellen ved brønnhodets kolonne.
  // Med `hendelser` (postene i filrekkefølge, inkludert DATES) får hver kobling tidspunktet den
  // ble åpnet, og `typer` lister når brønnen skifter mellom produsent (P) og injektor (I).
  function bronner(g, poster, hendelser) {
    const { nx, ny, nz, bbox, origo } = g, nxy = nx * ny;
    if (!hendelser) {
      hendelser = [];
      for (const n of ['WELSPECS', 'COMPDAT', 'WCONHIST', 'WCONPROD', 'WCONINJE', 'WCONINJH']) for (const r of (poster || {})[n] || []) hendelser.push([n, r]);
    }
    const kartet = new Map();
    let t = -Infinity;
    for (const [n, r] of hendelser) {
      if (n === 'DATES') { const d = datoAv(r); if (d != null) t = d; continue; }
      if (typeof r[0] !== 'string') continue;
      if (n === 'WELSPECS') {
        if (!kartet.has(r[0])) kartet.set(r[0], { navn: r[0], gruppe: r[1], hi: (r[2] | 0) - 1, hj: (r[3] | 0) - 1, celler: [], tider: [], sett: new Set(), typer: [] });
        continue;
      }
      const w = kartet.get(r[0]);
      if (!w) continue;
      if (n === 'COMPDAT') {
        const i = r[1] > 0 ? r[1] - 1 : w.hi, j = r[2] > 0 ? r[2] - 1 : w.hj;
        if (!(i >= 0 && i < nx && j >= 0 && j < ny) || !(r[3] > 0)) continue;
        const k1 = r[3] - 1, k2 = Math.min(nz, r[4] > 0 ? r[4] : r[3]) - 1;
        for (let k = k1; k <= k2; k++) {
          const c = i + nx * j + nxy * k;
          if (!w.sett.has(c)) { w.sett.add(c); w.celler.push(c); w.tider.push(t); }
        }
      } else if (n.startsWith('WCON')) {
        const inj = n === 'WCONINJE' || n === 'WCONINJH';
        const fase = inj && typeof r[1] === 'string' ? r[1].toUpperCase() : null;
        const siste = w.typer[w.typer.length - 1];
        // Står brønnen i begge listene på samme tidspunkt, regnes den som injektor.
        if (siste && siste[0] === t) { if (inj) { siste[1] = 'I'; siste[2] = fase; } }
        else if (!siste || siste[1] !== (inj ? 'I' : 'P') || siste[2] !== fase) w.typer.push([t, inj ? 'I' : 'P', fase]);
      }
    }
    const ut = [], hj = new Float64Array(24);
    const yTopp = (origo[2] - bbox.z0) + 0.15 * (bbox.z1 - bbox.z0);
    for (const w of kartet.values()) {
      if (!w.celler.length) continue;
      const pkt = new Float32Array(3 * (w.celler.length + 1));
      const senter = (c, o) => {
        hjorner(g, c % nx, Math.floor(c / nx) % ny, Math.floor(c / nxy), hj);
        for (let a = 0; a < 3; a++) {
          let s = 0;
          for (let h = 0; h < 8; h++) s += hj[3 * h + a];
          pkt[o + a] = s / 8;
        }
      };
      const hi = Math.max(0, Math.min(nx - 1, w.hi)), hjj = Math.max(0, Math.min(ny - 1, w.hj));
      senter(hi + nx * hjj, 0);
      pkt[1] = yTopp;
      w.celler.forEach((c, n) => senter(c, 3 * (n + 1)));
      const siste = w.typer[w.typer.length - 1];
      ut.push({ navn: w.navn, gruppe: w.gruppe, type: siste ? siste[1] : null, fase: siste ? siste[2] : null, typer: w.typer,
        punkter: pkt, tider: Float64Array.from(w.tider), antKoblinger: w.celler.length });
    }
    return ut;
  }

  // Brønnbane fra tekstfil: kolonner med X, Y og dybde (TVD, positiv nedover), eventuelt MD først.
  // Kolonnene finnes fra en overskriftslinje (X/EASTING, Y/NORTHING, Z/TVD); uten overskrift
  // antas X Y Z for tre kolonner og MD X Y Z for fire eller flere. Brønnnavn fra en linje med
  // «WELL NAME: …», ellers filnavnet.
  function baneTekst(tekst, filnavn) {
    let navn = String(filnavn || 'Brønn').replace(/\.[^.]*$/, ''), kol = null;
    const pkt = [];
    for (const linje of tekst.split(/\r?\n/)) {
      const m = linje.match(/well\s*(?:name)?\s*[:=]\s*["']?([^"'\s,;]+)/i);
      if (m) { navn = m[1]; continue; }
      const t = linje.replace(/^[#!%\s]+/, '').split(/[\s,;]+/).filter(Boolean);
      if (t.length < 3) continue;
      const tall = t.map(Number);
      if (tall.every(v => v === v)) { pkt.push(tall); continue; }
      if (!pkt.length && !kol) {
        const finn = re => t.findIndex(x => re.test(x.replace(/[(\[].*$/, '')));
        const x = finn(/^(x|east(ing)?|utm_?x|utme)$/i), y = finn(/^(y|north(ing)?|utm_?y|utmn)$/i), z = finn(/^(z|tvd\w*|depth)$/i);
        if (x >= 0 && y >= 0 && z >= 0) kol = [x, y, z];
      }
    }
    if (pkt.length < 2) return null;
    if (!kol) kol = pkt[0].length >= 4 ? [1, 2, 3] : [0, 1, 2];
    const xyz = new Float64Array(3 * pkt.length);
    let oppover = true;
    pkt.forEach((p, n) => { for (let a = 0; a < 3; a++) xyz[3 * n + a] = p[kol[a]]; if (p[kol[2]] > 0) oppover = false; });
    if (oppover) for (let n = 0; n < pkt.length; n++) xyz[3 * n + 2] = -xyz[3 * n + 2];   // høyde over havet → dybde
    return { navn, xyz };
  }
  function baneTil3D(g, xyz) {
    const ut = new Float32Array(xyz.length);
    for (let p = 0; p < xyz.length; p += 3) {
      ut[p] = xyz[p] - g.origo[0]; ut[p + 1] = g.origo[2] - xyz[p + 2]; ut[p + 2] = g.origo[1] - xyz[p + 1];
    }
    return ut;
  }

  // ---------- statistikk ----------
  // Min/maks over aktive celler, minste positive verdi (for logskala), histogram (lineært og
  // logaritmisk, 48 søyler) og de unike verdiene når egenskapen er heltall med få klasser.
  function statistikk(g, a) {
    let min = Infinity, max = -Infinity, minPos = Infinity, heltall = true;
    let unike = new Set();
    for (let c = 0; c < g.n; c++) {
      if (!g.act[c]) continue;
      const v = a[c];
      if (v !== v) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      if (v > 0 && v < minPos) minPos = v;
      if (heltall && v !== Math.floor(v)) heltall = false;
      if (unike && heltall) { unike.add(v); if (unike.size > 32) unike = null; }
    }
    if (min === Infinity) { min = 0; max = 1; }
    if (minPos === Infinity) minPos = null;
    const N = 48, hist = new Array(N).fill(0), histLog = minPos != null && max > minPos ? new Array(N).fill(0) : null;
    const d = max - min, l0 = histLog ? Math.log(minPos) : 0, ld = histLog ? Math.log(max) - l0 : 1;
    for (let c = 0; c < g.n; c++) {
      if (!g.act[c]) continue;
      const v = a[c];
      if (v !== v) continue;
      hist[d > 0 ? Math.min(N - 1, Math.floor((v - min) / d * N)) : 0]++;
      if (histLog && v > 0) histLog[Math.min(N - 1, Math.floor((Math.log(v) - l0) / ld * N))]++;
    }
    return { min, max, minPos, heltall, unike: heltall && unike ? Array.from(unike).sort((x, y) => x - y) : null, hist, histLog };
  }

  // Syntetisk eksempelmodell: dom med en forkastning med varierende sprang, ellipseformet
  // omriss og egenskaper som følger lagdeling og dybde. Brukes til demo og tester.
  function syntetisk(nx, ny, nz) {
    nx = nx || 60; ny = ny || 80; nz = nz || 20;
    const n = nx * ny * nz, nxy = nx * ny, dx = 50, dy = 50;
    const X0 = 450000, Y0 = 6500000;
    const coord = new Float64Array(6 * (nx + 1) * (ny + 1));
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const p = 6 * (i + (nx + 1) * j);
      coord[p] = coord[p + 3] = X0 + i * dx;
      coord[p + 1] = coord[p + 4] = Y0 + j * dy;
      coord[p + 2] = 1000; coord[p + 5] = 3000;
    }
    const iForkast = Math.floor(nx * 0.55);
    const topp = (xn, yn) => 2000 + 150 * (xn * xn + yn * yn) + 20 * Math.sin(3 * xn) * Math.cos(2 * yn);
    const zcorn = new Float32Array(8 * n), actnum = new Float32Array(n);
    const poro = new Float32Array(n), permx = new Float32Array(n), swat = new Float32Array(n), satnum = new Float32Array(n);
    const sx = 2 * nx, sxy = 4 * nxy;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = i + nx * j + nxy * k;
      let zsum = 0;
      for (let h = 0; h < 8; h++) {
        const di = h & 1, dj = (h >> 1) & 1, dk = h >> 2;
        const xn = 2 * (i + di) / nx - 1, yn = 2 * (j + dj) / ny - 1;
        const sprang = i >= iForkast ? 45 * Math.max(0, 1 - yn * yn) : 0;
        const tykkelse = 120 + 30 * xn;
        const z = topp(xn, yn) + sprang + tykkelse * (k + dk) / nz;
        zcorn[(2 * i + di) + sx * (2 * j + dj) + sxy * (2 * k + dk)] = z;
        zsum += z;
      }
      const xc = 2 * (i + 0.5) / nx - 1, yc = 2 * (j + 0.5) / ny - 1, zc = zsum / 8;
      actnum[c] = xc * xc + yc * yc <= 1.05 ? 1 : 0;
      const phi = Math.max(0.03, Math.min(0.34,
        0.2 + 0.08 * Math.sin(4 * xc + 0.3 * k) * Math.cos(3 * yc) + 0.04 * Math.cos(0.9 * k)));
      poro[c] = phi;
      permx[c] = Math.pow(10, 15 * phi - 1.5);
      swat[c] = Math.max(0.15, Math.min(1, 0.15 + (zc - 2090) / 50));
      satnum[c] = 1 + Math.floor(3 * k / nz);
    }
    // Én forkastning langs spranget, en vertikal produsent på toppen og en horisontal injektor på flanken.
    const iP = Math.round(nx * 0.3), jM = Math.round(ny / 2), kI = Math.max(1, Math.round(nz * 0.75));
    const compdat = [['P-1', iP, jM, 1, Math.max(1, Math.round(nz * 0.4))]];
    for (let i = Math.round(nx * 0.72); i <= Math.round(nx * 0.88); i++) compdat.push(['I-1', i, jM, kI, kI]);
    return {
      SPECGRID: new Float32Array([nx, ny, nz]), COORD: coord, ZCORN: zcorn, ACTNUM: actnum,
      PORO: poro, PERMX: permx, SWAT: swat, SATNUM: satnum,
      _poster: {
        FAULTS: [['Hovedforkastning', iForkast, iForkast, 1, ny, 1, nz, 'X']],
        WELSPECS: [['P-1', 'FELT', iP, jM, null, 'OIL'], ['I-1', 'FELT', Math.round(nx * 0.72), jM, null, 'WATER']],
        COMPDAT: compdat,
        WCONHIST: [['P-1', 'OPEN', 'ORAT']],
        WCONINJE: [['I-1', 'WATER', 'OPEN', 'RATE']]
      },
      // Samme poster i tidsrekkefølge: produsenten fra start, injektoren fra 2001.
      _hendelser: [
        ['WELSPECS', ['P-1', 'FELT', iP, jM, null, 'OIL']], ['WELSPECS', ['I-1', 'FELT', Math.round(nx * 0.72), jM, null, 'WATER']],
        ['COMPDAT', compdat[0]], ['WCONHIST', ['P-1', 'OPEN', 'ORAT']],
        ['DATES', [1, 'JAN', 2000]], ['DATES', [1, 'JAN', 2001]]
      ].concat(compdat.slice(1).map(r => ['COMPDAT', r]),
        [['WCONINJE', ['I-1', 'WATER', 'OPEN', 'RATE']], ['DATES', [1, 'JAN', 2002]], ['DATES', [1, 'JAN', 2003]]])
    };
  }

  const GRID = { lagGrid, hjorner, hud, flateAttributter, statistikk, syntetisk, fraBlokk, forkastninger, bronner, tidspunkter,
    brukOperasjoner, kartakser, enhetFaktor, enhetSI, synlige, cellevolum, volum, snitt, kart, baneTekst, baneTil3D, FLATER };
  root.GRID = GRID;
  if (typeof module !== 'undefined' && module.exports) module.exports = GRID;
})(typeof self !== 'undefined' ? self : globalThis);
