// GRDECL-parser (Eclipse ASCII-format for grid og egenskaper).
// Leser bytes direkte (ikke strenger) slik at filer på flere hundre MB går raskt.
// Format: nøkkelord på egen linje, deretter tall avsluttet med "/". "N*v" gjentar v N ganger,
// "--" starter en kommentar. Kilde: OPM Flow Reference Manual, kap. 4 (inputformat).
(function (root) {
  'use strict';

  // Nøkkelord som består av flere poster, avsluttet med en tom post ("/" alene).
  // Disse hoppes over; de endrer egenskaper i bokser/regioner og er ikke støttet ennå.
  const POSTLISTE = new Set([
    'EQUALS', 'COPY', 'MULTIPLY', 'ADD', 'MINVALUE', 'MAXVALUE', 'OPERATE', 'OPERATER',
    'EQUALREG', 'COPYREG', 'MULTIREG', 'ADDREG', 'MULTFLT', 'NNC', 'EDITNNC',
    'MULTREGT', 'AQUNUM', 'AQUCON', 'THPRESFT', 'PINCHREG',
    'WELOPEN', 'WRFTPLT', 'WTRACER', 'WTEST', 'WPAVE', 'GRUPTREE', 'GCONINJE', 'GCONPROD',
    'WELTARG', 'WECON', 'WGRUPCON', 'WELSEGS', 'COMPSEGS', 'WSEGVALV', 'COMPLUMP', 'WPIMULT'
  ]);

  // Postlister som tas vare på: forkastninger og brønner. Hver post blir en liste med
  // tall, tekster og null (for standardverdier, "1*"). Lagres i ut._poster[nøkkelord].
  const FANG = new Set(['FAULTS', 'WELSPECS', 'COMPDAT', 'WCONHIST', 'WCONPROD', 'WCONINJE', 'WCONINJH']);

  const P10 = new Float64Array(23);
  for (let i = 0; i < 23; i++) P10[i] = Math.pow(10, i);

  // Tolker b[s..e) som flyttall. Støtter fortegn, desimaler og eksponent (E eller D).
  function flyt(b, s, e) {
    let i = s, neg = false, c = b[i];
    if (c === 45) { neg = true; i++; } else if (c === 43) i++;
    let m = 0, eks = 0, sif = 0, noe = false;
    for (; i < e; i++) {
      c = b[i] - 48;
      if (c < 0 || c > 9) break;
      noe = true;
      if (sif < 15) { m = m * 10 + c; if (m > 0) sif++; } else eks++;
    }
    if (i < e && b[i] === 46) {
      i++;
      for (; i < e; i++) {
        c = b[i] - 48;
        if (c < 0 || c > 9) break;
        noe = true;
        if (sif < 15) { m = m * 10 + c; eks--; if (m > 0) sif++; }
      }
    }
    if (!noe) return NaN;
    if (i < e) {
      c = b[i];
      if (c !== 69 && c !== 101 && c !== 68 && c !== 100) return NaN;
      i++;
      let en = false, x = 0;
      if (b[i] === 45) { en = true; i++; } else if (b[i] === 43) i++;
      for (; i < e; i++) {
        c = b[i] - 48;
        if (c < 0 || c > 9) return NaN;
        x = x * 10 + c;
      }
      eks += en ? -x : x;
    }
    let v;
    if (eks === 0) v = m;
    else if (eks < 0) v = eks >= -22 ? m / P10[-eks] : m * Math.pow(10, eks);
    else v = eks <= 22 ? m * P10[eks] : m * Math.pow(10, eks);
    return neg ? -v : v;
  }

  // Leser en fil (Uint8Array) og legger nøkkelordene i `ut` som typede tabeller.
  // Kan kalles flere ganger med samme `ut` for å slå sammen INCLUDE-filer.
  function parse(b, ut) {
    ut = ut || {};
    const n = b.length;
    let p = 0;
    let navn = null, buf = null, len = 0;
    let modus = 0;   // 0 = utenfor data, 1 = talldata, 2 = hopp til "/", 3 = postliste, 4 = postliste som fanges
    let iPost = 0;
    let post = null, poster = null;
    const tekst = (s, e) => { let t = ''; for (let i = s; i < e; i++) t += String.fromCharCode(b[i]); return t; };

    function avslutt() {
      if (navn && len > 0) {
        const eks = ut[navn];
        // En kortere forekomst (f.eks. inne i BOX) skal ikke overskrive hele tabellen.
        if (!eks || eks.length <= len) ut[navn] = buf.slice(0, len);
      }
      navn = null; buf = null; len = 0;
    }

    while (p < n) {
      const c = b[p];
      if (c <= 32 || c === 44) { p++; continue; }
      if (c === 45 && b[p + 1] === 45) {
        while (p < n && b[p] !== 10) p++;
        continue;
      }
      if (c === 47) {
        if (modus === 3) { if (iPost === 0) modus = 0; iPost = 0; }
        else if (modus === 4) {
          if (post.length === 0) modus = 0;
          else { poster.push(post); post = []; }
        }
        else { avslutt(); modus = 0; }
        while (p < n && b[p] !== 10) p++;   // resten av linja etter "/" er kommentar
        continue;
      }
      if (c === 39 || c === 34) {
        const q = ++p;
        while (p < n && b[p] !== c && b[p] !== 10) p++;
        if (modus === 4) post.push(tekst(q, p).trim());
        p++;
        if (modus === 3) iPost++;
        continue;
      }
      const s = p;
      let stjerne = -1;
      while (p < n) {
        const d = b[p];
        if (d <= 32 || d === 47 || d === 44) break;
        if (d === 42 && stjerne < 0) stjerne = p;
        p++;
      }
      if (modus === 2) continue;
      if (modus === 3) { iPost++; continue; }
      if (modus === 4) {
        if (stjerne === p - 1) {   // "3*": tre standardverdier
          const ant = stjerne > s ? flyt(b, s, stjerne) : NaN;
          if (ant === ant) { for (let i = 0; i < ant; i++) post.push(null); continue; }
        }
        const v = flyt(b, s, p);
        post.push(v === v ? v : tekst(s, p));
        continue;
      }

      const c0 = b[s];
      if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
        avslutt();
        const t = tekst(s, p).toUpperCase();
        if (t === 'INCLUDE') modus = 2;
        else if (POSTLISTE.has(t)) { modus = 3; iPost = 0; }
        else if (FANG.has(t)) {
          modus = 4; post = [];
          const alle = ut._poster || (ut._poster = {});
          poster = alle[t] || (alle[t] = []);
        }
        else {
          modus = 1; navn = t; len = 0;
          // COORD kan ha UTM-koordinater (7 siffer før komma) og trenger dobbel presisjon.
          buf = t === 'COORD' ? new Float64Array(4096) : new Float32Array(4096);
        }
        continue;
      }
      if (modus !== 1) continue;

      let ant = 1, v;
      if (stjerne >= 0) {
        ant = flyt(b, s, stjerne) | 0;
        v = stjerne + 1 < p ? flyt(b, stjerne + 1, p) : 0;   // "3*" = standardverdi
      } else v = flyt(b, s, p);
      if (ant <= 0) continue;
      if (len + ant > buf.length) {
        let ny = buf.length * 2;
        while (ny < len + ant) ny *= 2;
        const nb = new buf.constructor(ny);
        nb.set(buf.subarray(0, len));
        buf = nb;
      }
      if (ant === 1) buf[len++] = v;
      else { buf.fill(v, len, len + ant); len += ant; }
    }
    avslutt();
    return ut;
  }

  function parseTekst(tekst, ut) {
    return parse(new TextEncoder().encode(tekst), ut);
  }

  const GRDECL = { parse, parseTekst, flyt };
  root.GRDECL = GRDECL;
  if (typeof module !== 'undefined' && module.exports) module.exports = GRDECL;
})(typeof self !== 'undefined' ? self : globalThis);
