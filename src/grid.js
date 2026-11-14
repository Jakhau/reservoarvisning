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
      props[navn] = a instanceof Float32Array ? a : Float32Array.from(a);
    }

    return {
      nx, ny, nz, n, coord, zcorn, act, brudd, props, antAktive,
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
  // filter: { i0,i1,j0,j1,k0,k1 } (0-basert, inklusive) og valgfritt { prop, pmin, pmax }.
  function hud(g, filter) {
    const { nx, ny, nz, n, act, brudd } = g;
    const nxy = nx * ny;
    const f = filter || {};
    const kl = (v, std, maks) => Math.max(0, Math.min(maks, v == null ? std : v | 0));
    const i0 = kl(f.i0, 0, nx - 1), i1 = kl(f.i1, nx - 1, nx - 1);
    const j0 = kl(f.j0, 0, ny - 1), j1 = kl(f.j1, ny - 1, ny - 1);
    const k0 = kl(f.k0, 0, nz - 1), k1 = kl(f.k1, nz - 1, nz - 1);
    const prop = f.prop || null;
    const pmin = f.pmin == null ? -Infinity : f.pmin, pmax = f.pmax == null ? Infinity : f.pmax;

    const syn = new Uint8Array(n);
    let antCeller = 0;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) {
      let c = i0 + nx * j + nxy * k;
      for (let i = i0; i <= i1; i++, c++) {
        if (!act[c]) continue;
        if (prop) { const v = prop[c]; if (!(v >= pmin && v <= pmax)) continue; }
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
    return { pos, celle, antFlater: nf, antCeller };
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

  // Forkastningsflater fra FAULTS-poster: navn, I1 I2 J1 J2 K1 K2 (1-basert) og flate (X, Y, Z,
  // eventuelt med minus eller som I/J/K). Kilde: OPM Flow Reference Manual, FAULTS.
  // Flaten tas med når cellen eller naboen på den andre siden er aktiv.
  const FLATENAVN = { X: 1, 'X+': 1, I: 1, 'I+': 1, 'X-': 0, 'I-': 0, Y: 3, 'Y+': 3, J: 3, 'J+': 3, 'Y-': 2, 'J-': 2,
    Z: 5, 'Z+': 5, K: 5, 'K+': 5, 'Z-': 4, 'K-': 4 };
  function forkastninger(g, poster) {
    const { nx, ny, nz, act } = g, nxy = nx * ny;
    const steg = [-1, 1, -nx, nx, -nxy, nxy];
    const navn = [], indeks = new Map(), pos = [], eier = [];
    const hj = new Float64Array(24);
    for (const r of poster || []) {
      const s = FLATENAVN[String(r[7] == null ? 'X' : r[7]).toUpperCase()];
      if (s == null || typeof r[0] !== 'string') continue;
      const i0 = Math.max(1, r[1] | 0) - 1, i1 = Math.min(nx, r[2] | 0) - 1;
      const j0 = Math.max(1, r[3] | 0) - 1, j1 = Math.min(ny, r[4] | 0) - 1;
      const k0 = Math.max(1, r[5] | 0) - 1, k1 = Math.min(nz, r[6] | 0) - 1;
      if (!indeks.has(r[0])) { indeks.set(r[0], navn.length); navn.push(r[0]); }
      const nr = indeks.get(r[0]);
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const c = i + nx * j + nxy * k;
        const ij = s < 2 ? i : s < 4 ? j : k, maks = s < 2 ? nx : s < 4 ? ny : nz;
        const harNabo = (s & 1) ? ij < maks - 1 : ij > 0;
        // Inaktive celler kan ha vilkårlig geometri. Er cellen inaktiv, brukes naboens motstående flate.
        let fs = s, ci = i, cj = j, ck = k;
        if (!act[c]) {
          if (!(harNabo && act[c + steg[s]])) continue;
          const d = (s & 1) ? 1 : -1;
          if (s < 2) ci += d; else if (s < 4) cj += d; else ck += d;
          fs = s ^ 1;
        }
        hjorner(g, ci, cj, ck, hj);
        for (let h = 0; h < 4; h++) { const q = 3 * FLATER[fs][h]; pos.push(hj[q], hj[q + 1], hj[q + 2]); }
        eier.push(nr);
      }
    }
    return { navn, pos: new Float32Array(pos), eier: new Uint16Array(eier), antFlater: eier.length };
  }

  // Brønner fra WELSPECS (navn, gruppe, brønnhode I J) og COMPDAT (navn, I, J, K1, K2).
  // Simuleringsmodellen inneholder ikke brønnbaner, bare hvilke celler brønnen er koblet til.
  // Banen tegnes derfor gjennom cellesentrene i den rekkefølgen koblingene står i fila, med
  // en rett strek opp til et punkt over modellen ved brønnhodets kolonne. Koblinger fra alle
  // tidssteg slås sammen. Type (P/I) er siste WCON*-nøkkelord brønnen opptrer i.
  function bronner(g, poster) {
    const { nx, ny, nz, bbox, origo } = g, nxy = nx * ny;
    const P = poster || {}, kart = new Map();
    for (const r of P.WELSPECS || []) {
      if (typeof r[0] !== 'string' || kart.has(r[0])) continue;
      kart.set(r[0], { navn: r[0], gruppe: r[1], hi: (r[2] | 0) - 1, hj: (r[3] | 0) - 1, celler: [], sett: new Set(), type: null, fase: null });
    }
    for (const r of P.COMPDAT || []) {
      const w = kart.get(r[0]);
      if (!w) continue;
      const i = r[1] > 0 ? r[1] - 1 : w.hi, j = r[2] > 0 ? r[2] - 1 : w.hj;
      if (!(i >= 0 && i < nx && j >= 0 && j < ny) || !(r[3] > 0)) continue;
      const k1 = r[3] - 1, k2 = Math.min(nz, r[4] > 0 ? r[4] : r[3]) - 1;
      for (let k = k1; k <= k2; k++) {
        const c = i + nx * j + nxy * k;
        if (!w.sett.has(c)) { w.sett.add(c); w.celler.push(c); }
      }
    }
    for (const [nokkel, type] of [['WCONHIST', 'P'], ['WCONPROD', 'P'], ['WCONINJE', 'I'], ['WCONINJH', 'I']]) {
      for (const r of P[nokkel] || []) {
        const w = kart.get(r[0]);
        if (!w) continue;
        // Produksjon og injeksjon står i hver sin liste; en brønn som noen gang har injisert regnes som injektor.
        if (type === 'I') { w.type = 'I'; if (typeof r[1] === 'string') w.fase = r[1].toUpperCase(); }
        else if (!w.type) w.type = 'P';
      }
    }
    const ut = [], hj = new Float64Array(24);
    const yTopp = (origo[2] - bbox.z0) + 0.15 * (bbox.z1 - bbox.z0);
    for (const w of kart.values()) {
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
      ut.push({ navn: w.navn, gruppe: w.gruppe, type: w.type, fase: w.fase, punkter: pkt, antKoblinger: w.celler.length });
    }
    return ut;
  }

  // Min/maks over aktive celler, minste positive verdi (for logskala) og om alt er heltall.
  function statistikk(g, a) {
    let min = Infinity, max = -Infinity, minPos = Infinity, heltall = true;
    for (let c = 0; c < g.n; c++) {
      if (!g.act[c]) continue;
      const v = a[c];
      if (v !== v) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      if (v > 0 && v < minPos) minPos = v;
      if (heltall && v !== Math.floor(v)) heltall = false;
    }
    if (min === Infinity) { min = 0; max = 1; }
    return { min, max, minPos: minPos === Infinity ? null : minPos, heltall };
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
      }
    };
  }

  const GRID = { lagGrid, hjorner, hud, flateAttributter, statistikk, syntetisk, fraBlokk, forkastninger, bronner, FLATER };
  root.GRID = GRID;
  if (typeof module !== 'undefined' && module.exports) module.exports = GRID;
})(typeof self !== 'undefined' ? self : globalThis);
