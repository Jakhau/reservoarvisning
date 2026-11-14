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

  // 'grid' (EGRID), 'restart' (UNRST) eller 'init'.
  function filtype(idx) {
    const navn = new Set(idx.map(p => p.navn));
    if (navn.has('GRIDHEAD') && navn.has('ZCORN')) return 'grid';
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

  const ECLBIN = { bufferKilde, filKilde, erBinar, indeks, les, filtype, rapportsteg };
  root.ECLBIN = ECLBIN;
  if (typeof module !== 'undefined' && module.exports) module.exports = ECLBIN;
})(typeof self !== 'undefined' ? self : globalThis);
