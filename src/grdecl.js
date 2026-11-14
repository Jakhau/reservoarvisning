// GRDECL-parser (Eclipse ASCII-format for grid, egenskaper, forkastninger og brønner).
// Leser bytes direkte (ikke strenger), og kan mates bit for bit slik at filer på flere GB
// ikke trenger å ligge i minnet samtidig.
// Format: nøkkelord på egen linje, deretter tall avsluttet med "/". "N*v" gjentar v N ganger,
// "--" starter en kommentar. Kilde: OPM Flow Reference Manual, kap. 4 (inputformat).
(function (root) {
  'use strict';

  // Postlister (avsluttes med en tom post, "/" alene) som hoppes over.
  const POSTLISTE = new Set([
    'OPERATE', 'OPERATER', 'EQUALREG', 'COPYREG', 'MULTIREG', 'ADDREG', 'MULTFLT', 'NNC', 'EDITNNC',
    'MULTREGT', 'AQUNUM', 'AQUCON', 'THPRESFT', 'PINCHREG',
    'WELOPEN', 'WRFTPLT', 'WTRACER', 'WTEST', 'WPAVE', 'GRUPTREE', 'GCONINJE', 'GCONPROD',
    'WELTARG', 'WECON', 'WGRUPCON', 'WELSEGS', 'COMPSEGS', 'WSEGVALV', 'COMPLUMP', 'WPIMULT'
  ]);
  // Postlister som tas vare på. Hver post blir en liste med tall, tekster og null (standardverdi).
  // De lagres per nøkkelord i ut._poster og i filrekkefølge i ut._hendelser (for tidsutvikling).
  const FANG = new Set(['FAULTS', 'WELSPECS', 'COMPDAT', 'WCONHIST', 'WCONPROD', 'WCONINJE', 'WCONINJH', 'DATES']);
  // Operasjoner på egenskaper i en boks; lagres i ut._ops og utføres i rekkefølge av GRID.lagGrid.
  const OPS = new Set(['EQUALS', 'COPY', 'MULTIPLY', 'ADD', 'MINVALUE', 'MAXVALUE']);

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

  // Lager en leser med tilstand. mat(bytes) kan kalles flere ganger; hver bit må slutte på et
  // linjeskift (unntatt den siste). opts.inkluder(sti) kalles når en INCLUDE treffes, slik at
  // den inkluderte fila kan leses inn på riktig sted i rekkefølgen.
  function leser(ut, opts) {
    ut = ut || {};
    opts = opts || {};
    let navn = null, buf = null, len = 0;
    // 0 utenfor data, 1 talldata, 2 venter på INCLUDE-sti, 3 postliste som hoppes over,
    // 4 postliste som fanges, 6 hopp til "/"
    let modus = 0, iPost = 0, post = null, mottak = null, boks = null;

    function avslutt() {
      if (navn && len > 0) {
        if (navn === 'BOX') boks = len >= 6 ? Array.from(buf.subarray(0, 6)) : null;
        else if (boks) (ut._ops || (ut._ops = [])).push({ op: 'BOKSDATA', navn, boks: boks.slice(), data: buf.slice(0, len) });
        else {
          const eks = ut[navn];
          // En kortere forekomst skal ikke overskrive hele tabellen.
          if (!eks || eks.length <= len) ut[navn] = buf.slice(0, len);
        }
      }
      navn = null; buf = null; len = 0;
    }

    function mat(b) {
      const n = b.length;
      let p = 0;
      const tekst = (s, e) => { let t = ''; for (let i = s; i < e; i++) t += String.fromCharCode(b[i]); return t; };
      while (p < n) {
        const c = b[p];
        if (c <= 32 || c === 44) { p++; continue; }
        if (c === 45 && b[p + 1] === 45) {
          while (p < n && b[p] !== 10) p++;
          continue;
        }
        if (modus === 2) {
          // INCLUDE-sti: i anførselstegn, eller uten (da kan den inneholde skråstreker).
          let sti, ferdig = false;
          if (c === 39 || c === 34) {
            const q = ++p;
            while (p < n && b[p] !== c && b[p] !== 10) p++;
            sti = tekst(q, p); p++;
          } else {
            const q = p;
            while (p < n && b[p] > 32) p++;
            sti = tekst(q, p);
            if (sti.length > 1 && sti.endsWith('/')) { sti = sti.slice(0, -1); ferdig = true; }
          }
          modus = ferdig ? 0 : 6;
          if (ferdig) while (p < n && b[p] !== 10) p++;
          (ut._include || (ut._include = [])).push(sti.trim());
          if (opts.inkluder) opts.inkluder(sti.trim());
          continue;
        }
        if (c === 47) {
          if (modus === 3) { if (iPost === 0) modus = 0; iPost = 0; }
          else if (modus === 4) {
            if (post.length === 0) modus = 0;
            else { mottak(post); post = []; }
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
        if (modus === 6) continue;
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
          else if (t === 'ENDBOX') { boks = null; modus = 0; }
          // Enhetssystemet står i RUNSPEC, altså før GRID. Senere er «FIELD» et gruppenavn.
          else if ((t === 'FIELD' || t === 'METRIC' || t === 'LAB') && !ut._etterRunspec) { ut._enhet = t; modus = 0; }
          else if (t === 'GRID' || t === 'SCHEDULE') { ut._etterRunspec = true; modus = 0; }
          else if (POSTLISTE.has(t)) { modus = 3; iPost = 0; }
          else if (FANG.has(t)) {
            modus = 4; post = [];
            const alle = ut._poster || (ut._poster = {});
            const liste = alle[t] || (alle[t] = []);
            const hendelser = ut._hendelser || (ut._hendelser = []);
            mottak = r => { liste.push(r); hendelser.push([t, r]); };
          }
          else if (OPS.has(t)) {
            modus = 4; post = [];
            const ops = ut._ops || (ut._ops = []);
            const b0 = boks ? boks.slice() : null;
            mottak = r => ops.push({ op: t, post: r, boks: b0 });
          }
          else {
            modus = 1; navn = t; len = 0;
            // COORD kan ha UTM-koordinater (7 siffer før komma) og trenger dobbel presisjon.
            buf = (t === 'COORD' || t === 'MAPAXES') ? new Float64Array(4096) : new Float32Array(4096);
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
    }

    return { mat, slutt: () => { avslutt(); return ut; } };
  }

  function parse(b, ut, opts) {
    const l = leser(ut, opts);
    l.mat(b);
    return l.slutt();
  }

  // Leser en kilde ({ size, les(pos, lengde) }) i biter og kutter hver bit ved siste linjeskift.
  function parseKilde(kilde, ut, opts, bit) {
    bit = bit || (32 << 20);
    const l = leser(ut, opts);
    let pos = 0, rest = null;
    while (pos < kilde.size) {
      let del = kilde.les(pos, bit);
      pos += del.length;
      if (rest) {
        const sammen = new Uint8Array(rest.length + del.length);
        sammen.set(rest); sammen.set(del, rest.length);
        del = sammen; rest = null;
      }
      if (pos < kilde.size) {
        let kutt = del.length;
        while (kutt > 0 && del[kutt - 1] !== 10) kutt--;
        if (kutt === 0) { rest = del; continue; }   // ingen linjeskift i biten: les videre
        rest = del.slice(kutt);
        del = del.subarray(0, kutt);
      }
      l.mat(del);
    }
    if (rest) l.mat(rest);
    return l.slutt();
  }

  function parseTekst(tekst, ut, opts) {
    return parse(new TextEncoder().encode(tekst), ut, opts);
  }

  const GRDECL = { parse, parseKilde, parseTekst, leser, flyt };
  root.GRDECL = GRDECL;
  if (typeof module !== 'undefined' && module.exports) module.exports = GRDECL;
})(typeof self !== 'undefined' ? self : globalThis);
