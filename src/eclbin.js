// Leser Eclipse binærformat (EGRID, INIT, UNRST): Fortran-poster i big-endian.
// Hvert nøkkelord har et hode [16][navn 8 tegn][antall][type 4 tegn][16] og deretter data i
// blokker på inntil 1000 elementer (105 for tekst), hver omgitt av blokklengden.
// Kilde: OPM Flow Reference Manual, vedlegg om utdatafiler; samme oppsett som i resdata/ecl.
// Fila leses gjennom en «kilde» med les(pos, lengde), slik at store filer kan indekseres
// og leses stykkevis uten å ligge i minnet.
(function (root) {
  'use strict';

  const STR = { INTE: 4, REAL: 4, LOGI: 4, DOUB: 8, CHAR: 8, MESS: 0 };

  function bufferKilde(u8) {
    return { size: u8.length, les: (p, l) => u8.subarray(p, Math.min(u8.length, p + l)) };
  }
  // I en worker: leser biter av en File synkront.
  function filKilde(fil) {
    const fr = new FileReaderSync();
    return { size: fil.size, les: (p, l) => new Uint8Array(fr.readAsArrayBuffer(fil.slice(p, p + l))) };
  }

  function erBinar(kilde) {
    const b = kilde.les(0, 4);
    return b.length === 4 && b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 16;
  }

  // Går gjennom fila og noterer hvor hvert nøkkelord ligger, uten å lese dataene.
  function indeks(kilde) {
    const ut = [];
    let vin = null, vinPos = 0, pos = 0;
    while (pos + 24 <= kilde.size) {
      if (!vin || pos < vinPos || pos + 24 > vinPos + vin.length) { vin = kilde.les(pos, 16384); vinPos = pos; }
      const o = pos - vinPos;
      const dv = new DataView(vin.buffer, vin.byteOffset + o, 24);
      if (dv.getInt32(0) !== 16) throw new Error('Ugyldig binærfil (ventet posthode ved byte ' + pos + ')');
      let navn = '', type = '';
      for (let i = 4; i < 12; i++) navn += String.fromCharCode(vin[o + i]);
      for (let i = 16; i < 20; i++) type += String.fromCharCode(vin[o + i]);
      const ant = dv.getInt32(12);
      const str = type[0] === 'C' && type !== 'CHAR' ? parseInt(type.slice(1), 10) : STR[type];
      if (str == null || str !== str) throw new Error('Ukjent datatype ' + type + ' i ' + navn.trim());
      const blokk = type[0] === 'C' ? 105 : 1000;
      const bytes = ant > 0 ? ant * str + Math.ceil(ant / blokk) * 8 : 0;
      ut.push({ navn: navn.trim(), type, ant, pos: pos + 24, bytes, str });
      pos += 24 + bytes;
    }
    return ut;
  }

  // Leser dataene til ett nøkkelord. `maks` begrenser antall elementer (for store hoder).
  function les(kilde, post, maks) {
    const ant = maks == null ? post.ant : Math.min(maks, post.ant);
    const blokk = post.type[0] === 'C' ? 105 : 1000;
    const trengs = ant * post.str + Math.ceil(ant / blokk) * 8;
    const b = kilde.les(post.pos, trengs);
    const dv = new DataView(b.buffer, b.byteOffset, b.length);
    const t = post.type;
    const ut = t === 'REAL' ? new Float32Array(ant) : t === 'DOUB' ? new Float64Array(ant)
      : (t === 'INTE' || t === 'LOGI') ? new Int32Array(ant) : new Array(ant);
    let p = 0, n = 0;
    while (n < ant) {
      const iBlokk = Math.min(dv.getInt32(p) / post.str, ant - n);
      p += 4;
      if (t === 'REAL') for (let i = 0; i < iBlokk; i++, p += 4) ut[n++] = dv.getFloat32(p);
      else if (t === 'DOUB') for (let i = 0; i < iBlokk; i++, p += 8) ut[n++] = dv.getFloat64(p);
      else if (t === 'INTE' || t === 'LOGI') for (let i = 0; i < iBlokk; i++, p += 4) ut[n++] = dv.getInt32(p);
      else for (let i = 0; i < iBlokk; i++, p += post.str) {
        let s = '';
        for (let c = 0; c < post.str; c++) s += String.fromCharCode(b[p + c]);
        ut[n++] = s.trim();
      }
      p += 4;
    }
    return ut;
  }

  // 'grid' (EGRID), 'restart' (UNRST), 'init', 'smspec' eller 'unsmry'.
  function filtype(idx) {
    const navn = new Set(idx.map(p => p.navn));
    if (navn.has('GRIDHEAD') && navn.has('ZCORN')) return 'grid';
    if (navn.has('WELLETC')) return 'rft';
    if (navn.has('KEYWORDS')) return 'smspec';
    if (navn.has('PARAMS')) return 'unsmry';
    if (navn.has('SEQNUM')) return 'restart';
    if (navn.has('INTEHEAD')) return 'init';
    return 'ukjent';
  }

  // Deler en UNRST-indeks i rapportsteg. Dato ligger i INTEHEAD[64..66] (dag, måned, år).
  function rapportsteg(kilde, idx) {
    const steg = [];
    let s = null;
    for (const p of idx) {
      if (p.navn === 'SEQNUM') { s = { nr: les(kilde, p, 1)[0], tid: null, poster: {} }; steg.push(s); continue; }
      if (!s) continue;
      if (p.navn === 'INTEHEAD' && s.tid == null && p.ant > 66) {
        const h = les(kilde, p, 67);
        s.tid = Date.UTC(h[66], h[65] - 1, h[64]);
      } else if ((p.type === 'REAL' || p.type === 'DOUB') && p.ant > 0 && !s.poster[p.navn]) s.poster[p.navn] = p;
    }
    return steg;
  }

  // Sammendragsdata (SMSPEC + UNSMRY): tidsserier for felt, grupper og brønner.
  // SMSPEC beskriver vektorene (KEYWORDS, WGNAMES/NAMES, NUMS, UNITS) og startdato; UNSMRY har
  // én PARAMS-post per ministeg med én verdi per vektor. Returnerer
  // { start, tider (ms UTC), vektorer: [{ nokkel, navn, num, enhet }], serie(nr) → Float32Array }.
  function sammendrag(spes, spesIdx, data, dataIdx) {
    const post = n => spesIdx.find(p => p.navn === n);
    const kw = les(spes, post('KEYWORDS'));
    const pn = post('WGNAMES') || post('NAMES');
    const navn = pn ? les(spes, pn) : [], nums = post('NUMS') ? les(spes, post('NUMS')) : [];
    const enh = post('UNITS') ? les(spes, post('UNITS')) : [];
    const sd = post('STARTDAT') ? les(spes, post('STARTDAT')) : [1, 1, 1970];
    const start = Date.UTC(sd[2], sd[1] - 1, sd[0], sd[3] || 0, sd[4] || 0, (sd[5] || 0) / 1e6);
    const nv = kw.length;
    const vektorer = kw.map((k, i) => ({ nokkel: k, navn: !navn[i] || /^:\+/.test(navn[i]) ? '' : navn[i], num: nums[i] || 0, enhet: enh[i] || '' }));
    const steg = dataIdx.filter(p => p.navn === 'PARAMS' && p.ant === nv);
    const m = new Float32Array(steg.length * nv);
    steg.forEach((p, s) => m.set(les(data, p), s * nv));
    const serie = nr => { const ut = new Float32Array(steg.length); for (let s = 0; s < steg.length; s++) ut[s] = m[s * nv + nr]; return ut; };
    // TIME er dager siden start (timer i LAB-enheter).
    const it = kw.indexOf('TIME'), tider = new Float64Array(steg.length);
    if (it >= 0) {
      const t = serie(it), ms = /^HOUR/i.test(enh[it] || '') ? 3600e3 : 86400e3;
      for (let s = 0; s < t.length; s++) tider[s] = start + t[s] * ms;
    }
    return { start, tider, vektorer, serie };
  }

  // RFT-fil: én måling per brønn og tidspunkt med trykk og metninger i hver koblet celle.
  // Dybde og trykk regnes om til meter og bar når fila oppgir fot og psi (WELLETC[3] og [4]).
  // Returnerer [{ bronn, tid, dybde, trykk, swat, sgas }] med målepunktene sortert etter dybde.
  function rft(kilde, idx) {
    const ut = [];
    let e = null;
    for (const p of idx) {
      if (p.navn === 'TIME') { e = { bronn: '', tid: null, fd: 1, ft: 1 }; ut.push(e); continue; }
      if (!e) continue;
      if (p.navn === 'DATE') { const d = les(kilde, p, 3); e.tid = Date.UTC(d[2], d[1] - 1, d[0]); }
      else if (p.navn === 'WELLETC') {
        const w = les(kilde, p, 5);
        e.bronn = w[1]; e.fd = /^FEET/i.test(w[3] || '') ? 0.3048 : 1; e.ft = /^PSI/i.test(w[4] || '') ? 0.0689476 : 1;
      }
      else if (p.navn === 'DEPTH' || p.navn === 'PRESSURE' || p.navn === 'SWAT' || p.navn === 'SGAS') e[p.navn] = p;
    }
    return ut.filter(x => x.bronn && x.tid != null && x.DEPTH && x.PRESSURE).map(x => {
      const d = les(kilde, x.DEPTH), t = les(kilde, x.PRESSURE), sw = x.SWAT ? les(kilde, x.SWAT) : null, sg = x.SGAS ? les(kilde, x.SGAS) : null;
      const rek = Array.from(d.keys()).sort((a, b) => d[a] - d[b]);
      const tab = (a, f) => a ? Float32Array.from(rek, i => a[i] * f) : null;
      return { bronn: x.bronn, tid: x.tid, dybde: tab(d, x.fd), trykk: tab(t, x.ft), swat: tab(sw, 1), sgas: tab(sg, 1) };
    });
  }

  const ECLBIN = { bufferKilde, filKilde, erBinar, indeks, les, filtype, rapportsteg, sammendrag, rft };
  root.ECLBIN = ECLBIN;
  if (typeof module !== 'undefined' && module.exports) module.exports = ECLBIN;
})(typeof self !== 'undefined' ? self : globalThis);
