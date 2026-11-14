// Bakgrunnstråd: leser filer, holder gridet og regner ut flater, verdier, statistikk og volum,
// slik at grensesnittet aldri fryser. Grensesnittet får bare det som skal tegnes.
// Filene mottas som File-objekter og leses herfra: tekstfiler bit for bit, binærfiler
// (EGRID/INIT/UNRST) indekseres først og dataene hentes når de trengs.
'use strict';
importScripts('grdecl.js', 'eclbin.js', 'grid.js');

let g = null;
let dyn = null;          // { kilde, steg: [{ tid, poster }], navn: [..], aktiv: Int32Array }
let tider = [];          // tidsaksen: rapportsteg fra UNRST, ellers datoene i SCHEDULE
let sisteHud = null;     // { celle, verdiFlate } for siste flatesett
let smry = null;         // sammendragsdata fra SMSPEC/UNSMRY, se ECLBIN.sammendrag
const hurtig = new Map();   // nylig leste dynamiske tabeller
const statistikker = new Map();

const erDynamisk = navn => !!dyn && dyn.navn.includes(navn) && !g.props[navn];

// Egenskapen som tabell over alle celler (NaN i inaktive) for et tidssteg.
function hentProp(navn, steg) {
  if (!navn || !g) return null;
  if (g.props[navn]) return g.props[navn];
  if (!erDynamisk(navn)) return null;
  const s = Math.max(0, Math.min(dyn.steg.length - 1, steg | 0)), nokkel = navn + '|' + s;
  if (hurtig.has(nokkel)) return hurtig.get(nokkel);
  const ut = new Float32Array(g.n).fill(NaN), post = dyn.steg[s].poster[navn];
  if (post && post.ant === dyn.aktiv.length) {
    const a = ECLBIN.les(dyn.kilde, post);
    const f = GRID.enhetFaktor(navn, g.enhet);
    for (let q = 0; q < a.length; q++) ut[dyn.aktiv[q]] = a[q] * f;
  }
  if (hurtig.size >= 6) hurtig.delete(hurtig.keys().next().value);
  hurtig.set(nokkel, ut);
  return ut;
}

// Det som vises: egenskapen selv, eller endringen siden et referansesteg (verdi − referanse).
function hentVist(navn, steg, ref) {
  const a = hentProp(navn, steg);
  if (ref == null || !a || !erDynamisk(navn)) return a;
  const nokkel = navn + '|' + steg + '−' + ref;
  if (hurtig.has(nokkel)) return hurtig.get(nokkel);
  const b = hentProp(navn, ref), ut = new Float32Array(g.n);
  for (let c = 0; c < g.n; c++) ut[c] = a[c] - b[c];
  if (hurtig.size >= 6) hurtig.delete(hurtig.keys().next().value);
  hurtig.set(nokkel, ut);
  return ut;
}

// Statistikk for en egenskap. For dynamiske egenskaper gjelder min/maks alle tidssteg (så
// fargeskalaen står stille når tiden endres), mens histogrammet gjelder valgt steg.
function stat(navn, steg, ref) {
  const a = hentProp(navn, steg);
  if (!a) return null;
  // Endring: statistikk for differansen i valgt steg; fortegnet gjør logskala meningsløs.
  if (ref != null && erDynamisk(navn))
    return Object.assign({}, GRID.statistikk(g, hentVist(navn, steg, ref)), { unike: null, minPos: null, histLog: null, endring: true });
  if (!erDynamisk(navn)) {
    if (!statistikker.has(navn)) statistikker.set(navn, GRID.statistikk(g, a));
    return statistikker.get(navn);
  }
  const s = GRID.statistikk(g, a);
  if (!statistikker.has(navn)) {
    let min = Infinity, max = -Infinity, minPos = Infinity;
    for (const st of dyn.steg) {
      const post = st.poster[navn];
      if (!post) continue;
      const v = ECLBIN.les(dyn.kilde, post);
      for (let q = 0; q < v.length; q++) {
        const x = v[q];
        if (x < min) min = x;
        if (x > max) max = x;
        if (x > 0 && x < minPos) minPos = x;
      }
    }
    const f = GRID.enhetFaktor(navn, g.enhet);
    statistikker.set(navn, { min: min * f, max: max * f, minPos: minPos === Infinity ? null : minPos * f });
  }
  const alle = statistikker.get(navn);
  return Object.assign({}, s, { histMin: s.min, histMax: s.max, histMinPos: s.minPos, min: alle.min, max: alle.max, minPos: alle.minPos, unike: null });
}

function verdierPerHjorne(celle, a, verdiFlate) {
  const ut = new Float32Array(celle.length * 4);
  for (let f = 0, w = 0; f < celle.length; f++) {
    let v = verdiFlate ? verdiFlate[f] : a ? a[celle[f]] : NaN;
    if (v !== v) v = -1e30;   // NaN kan ikke testes sikkert i GLSL
    ut[w++] = v; ut[w++] = v; ut[w++] = v; ut[w++] = v;
  }
  return ut;
}

function metning(steg) {
  for (const n of ['SWAT', 'SWATINIT', 'SWL']) { const a = hentProp(n, steg); if (a) return { a, navn: n }; }
  return null;
}

// Kurvene som vises for en brønn (W…) eller for feltet (F…), gruppert i delfigurer med felles
// enhet. Historiske verdier (…H) tegnes stiplet ved siden av de simulerte.
const KURVER = [
  { tittel: 'Olje og vann', enhet: 'SM3/DAY', serier: [['OPR', 'Olje', 'olje'], ['WPR', 'Vann', 'vann']] },
  { tittel: 'Gass', enhet: 'SM3/DAY', serier: [['GPR', 'Gass', 'gass']] },
  { tittel: 'Vanninjeksjon', enhet: 'SM3/DAY', serier: [['WIR', 'Vann', 'vann']] },
  { tittel: 'Gassinjeksjon', enhet: 'SM3/DAY', serier: [['GIR', 'Gass', 'gass']] },
  { tittel: 'Trykk', enhet: 'BARSA', serier: [['BHP', 'Bunnhullstrykk', 'trykk'], ['PR', 'Reservoartrykk', 'trykk']] },
  { tittel: 'Vannkutt', enhet: '', serier: [['WCT', 'Vannkutt', 'vann']] }
];
function kurver(navn) {
  if (!smry) return null;
  const felt = !navn, pre = felt ? 'F' : 'W';
  const finn = k => smry.vektorer.findIndex(v => v.nokkel === k && (felt || v.navn === navn));
  const figurer = [];
  for (const K of KURVER) {
    const serier = [];
    let enhet = '';
    for (const [k, etikett, farge] of K.serier) for (const h of ['', 'H']) {
      const nr = finn(pre + k + h);
      if (nr < 0) continue;
      const [f, e] = GRID.enhetSI(smry.vektorer[nr].enhet), v = smry.serie(nr);
      let noe = false;
      for (let i = 0; i < v.length; i++) { v[i] *= f; if (v[i] !== 0) noe = true; }
      if (!noe) continue;   // brønnen har aldri hatt denne strømmen
      enhet = smry.vektorer[nr].enhet ? e : K.enhet;   // eldre filer mangler UNITS; da antas METRIC
      serier.push({ nokkel: pre + k + h, etikett: etikett + (h ? ' (historisk)' : ''), farge, hist: !!h, verdier: v });
    }
    if (serier.length) figurer.push({ tittel: K.tittel, enhet, serier });
  }
  return { navn: navn || '', tider: smry.tider, figurer };
}
function kurveNavn() {
  if (!smry) return null;
  const s = new Set();
  for (const v of smry.vektorer) if (v.nokkel[0] === 'W' && v.navn) s.add(v.navn);
  return { bronner: Array.from(s).sort(), felt: smry.vektorer.some(v => v.nokkel[0] === 'F'), t0: smry.tider[0], t1: smry.tider[smry.tider.length - 1] };
}

function sendGrid(t0, navn, kw, baner, advarsler) {
  const poster = kw._poster || {}, hendelser = kw._hendelser || null;
  const fk = GRID.forkastninger(g, poster.FAULTS);
  const forkast = {
    navn: fk.navn, antFlater: fk.antFlater,
    hel: { pos: fk.pos, eier: fk.eier, sprang: fk.sprang, idx: GRID.flateAttributter(fk.antFlater).idx },
    kontakt: { pos: fk.kontakt.pos, eier: fk.kontakt.eier, sprang: fk.kontakt.sprang, idx: GRID.flateAttributter(fk.kontakt.antFlater).idx }
  };
  const bronner = GRID.bronner(g, poster, hendelser);
  // Importerte brønnbaner erstatter banen gjennom cellesentrene for brønner med samme navn.
  for (const b of baner) {
    const pkt = GRID.baneTil3D(g, b.xyz);
    const w = bronner.find(x => x.navn.toUpperCase() === b.navn.toUpperCase());
    if (w) { w.punkter = pkt; w.bane = true; }
    else bronner.push({ navn: b.navn, type: null, fase: null, typer: [], punkter: pkt, tider: new Float64Array(0), antKoblinger: 0, bane: true });
  }
  tider = dyn ? dyn.steg.map(s => s.tid) : GRID.tidspunkter(hendelser);
  const navnene = Object.keys(g.props).filter(p => p !== 'DEPTH');
  const props = navnene.map(p => ({ navn: p, dynamisk: false }))
    .concat(dyn ? dyn.navn.filter(p => !g.props[p]).map(p => ({ navn: p, dynamisk: true })) : [], [{ navn: 'DEPTH', dynamisk: false }]);
  postMessage({
    type: 'grid', navn, nx: g.nx, ny: g.ny, nz: g.nz, antAktive: g.antAktive, bbox: g.bbox, origo: g.origo, enhet: g.enhet,
    props, forkast, bronner, tider, advarsler, kurver: kurveNavn(), tid: performance.now() - t0
  });
}

function lesFiler(filer) {
  const kw = {}, tekst = [], binar = [], baner = [], advarsler = [];
  for (const f of filer) {
    const kilde = ECLBIN.filKilde(f);
    if (ECLBIN.erBinar(kilde)) { const idx = ECLBIN.indeks(kilde); binar.push({ f, kilde, idx, type: ECLBIN.filtype(idx) }); }
    else if (/\.(dev|wellpath|bane|csv|txt)$/i.test(f.name)) {
      const b = GRID.baneTekst(new FileReaderSync().readAsText(f), f.name);
      if (b) baner.push(b); else advarsler.push(f.name + ': fant ingen brønnbane (ventet kolonner med X, Y og dybde).');
    }
    else tekst.push({ f, kilde, navn: f.name.toLowerCase() });
  }
  // Tekstfiler: start med hovedfila (.DATA) og følg INCLUDE, så operasjoner utføres i riktig
  // rekkefølge. Filer som ikke er inkludert fra noen, leses til slutt.
  const brukt = new Set();
  const opts = {
    inkluder: sti => {
      const n = sti.split(/[\\/]/).pop().toLowerCase(), t = tekst.find(x => x.navn === n);
      if (t && !brukt.has(t)) { brukt.add(t); GRDECL.parseKilde(t.kilde, kw, opts); }
    }
  };
  tekst.sort((a, b) => (/\.data$/.test(b.navn) ? 1 : 0) - (/\.data$/.test(a.navn) ? 1 : 0));
  for (const t of tekst) if (!brukt.has(t)) { brukt.add(t); GRDECL.parseKilde(t.kilde, kw, opts); }

  const eg = binar.find(b => b.type === 'grid');
  if (eg) {
    const post = n => eg.idx.find(p => p.navn === n);
    const hode = ECLBIN.les(eg.kilde, post('GRIDHEAD'), 4);
    kw.SPECGRID = new Float32Array([hode[1], hode[2], hode[3]]);
    kw.COORD = Float64Array.from(ECLBIN.les(eg.kilde, post('COORD')));
    kw.ZCORN = ECLBIN.les(eg.kilde, post('ZCORN'));
    kw.ACTNUM = post('ACTNUM') ? Float32Array.from(ECLBIN.les(eg.kilde, post('ACTNUM'))) : null;
    if (!kw.ACTNUM) delete kw.ACTNUM;
    if (post('MAPAXES')) kw.MAPAXES = Float64Array.from(ECLBIN.les(eg.kilde, post('MAPAXES')));
    delete kw.DIMENS;
    const gu = post('GRIDUNIT') && String(ECLBIN.les(eg.kilde, post('GRIDUNIT'), 1)[0]).toUpperCase();
    kw._gridLengde = gu && gu.startsWith('FEET') ? 0.3048 : gu && gu.startsWith('CM') ? 0.01 : 1;
  }
  // Resultatfilene oppgir enhetssystemet i INTEHEAD[2]: 1 = METRIC, 2 = FIELD, 3 = LAB.
  for (const b of binar) {
    const ih = (b.type === 'init' || b.type === 'restart') && b.idx.find(p => p.navn === 'INTEHEAD' && p.ant > 2);
    if (ih) { kw._enhet = [, 'METRIC', 'FIELD', 'LAB'][ECLBIN.les(b.kilde, ih, 3)[2]] || kw._enhet; break; }
  }
  const d = kw.SPECGRID || kw.DIMENS;
  const n = d ? (d[0] | 0) * (d[1] | 0) * (d[2] | 0) : 0;
  // Resultatfilene lagrer bare aktive celler; dette er veien tilbake til alle celler.
  const aktiv = [];
  for (let c = 0; c < n; c++) if (!kw.ACTNUM || kw.ACTNUM[c] > 0) aktiv.push(c);

  for (const b of binar.filter(x => x.type === 'init')) {
    let ant = 0;
    for (const p of b.idx) {
      if (!(p.type === 'REAL' || p.type === 'INTE' || p.type === 'DOUB') || /HEAD$|^TAB/.test(p.navn)) continue;
      if (p.ant !== aktiv.length && p.ant !== n) continue;
      const a = ECLBIN.les(b.kilde, p);
      let ut;
      if (p.ant === n && aktiv.length !== n) ut = Float32Array.from(a);
      else { ut = new Float32Array(n).fill(NaN); for (let q = 0; q < a.length; q++) ut[aktiv[q]] = a[q]; }
      kw[p.navn] = ut; ant++;
    }
    if (!ant) advarsler.push(b.f.name + ': antall aktive celler stemmer ikke med gridet. Slipp EGRID-fila fra samme kjøring sammen med INIT.');
  }
  dyn = null;
  const rs = binar.find(x => x.type === 'restart');
  if (rs) {
    const steg = ECLBIN.rapportsteg(rs.kilde, rs.idx).filter(s => s.tid != null);
    const navn = [];
    for (const s of steg) for (const p of Object.keys(s.poster)) if (s.poster[p].ant === aktiv.length && !navn.includes(p)) navn.push(p);
    if (steg.length && navn.length) dyn = { kilde: rs.kilde, steg, navn, aktiv: Int32Array.from(aktiv) };
    else advarsler.push(rs.f.name + ': antall aktive celler stemmer ikke med gridet. Slipp EGRID-fila fra samme kjøring sammen med UNRST.');
  }
  smry = null;
  const sp = binar.find(x => x.type === 'smspec'), su = binar.find(x => x.type === 'unsmry');
  if (sp && su) {
    smry = ECLBIN.sammendrag(sp.kilde, sp.idx, su.kilde, su.idx);
    if (!smry.tider.length) { smry = null; advarsler.push(su.f.name + ': passer ikke med ' + sp.f.name + ' (ulikt antall vektorer).'); }
  } else if (sp || su) advarsler.push((sp || su).f.name + ': produksjonskurver krever både SMSPEC og UNSMRY fra samme kjøring.');
  for (const b of binar.filter(x => x.type === 'ukjent')) advarsler.push(b.f.name + ': ukjent binærfil, hoppet over.');
  return { kw, baner, advarsler };
}

onmessage = function (e) {
  const m = e.data;
  try {
    const t0 = performance.now();
    if (m.type === 'filer' || m.type === 'demo') {
      hurtig.clear(); statistikker.clear(); sisteHud = null; dyn = null; smry = null;
      let kw, baner = [], advarsler = [], navn = 'Eksempelmodell (syntetisk)';
      if (m.type === 'filer') {
        ({ kw, baner, advarsler } = lesFiler(m.filer));
        navn = m.filer.map(f => f.name).join(', ');
      } else kw = GRID.syntetisk(m.nx, m.ny, m.nz);
      g = GRID.lagGrid(kw);
      sendGrid(t0, navn, kw, baner, advarsler);
    } else if (!g) {
      return;
    } else if (m.type === 'kurver') {
      const k = kurver(m.navn);
      if (k) postMessage(Object.assign({ type: 'kurver' }, k));
    } else if (m.type === 'hud') {
      const f = m.filter, a = hentVist(m.prop, m.steg, m.ref);
      // Hvert filter gjelder en navngitt egenskap, eller det som vises når navnet er tomt.
      const filtre = (f.filtre || []).map(x => ({ a: x.prop ? hentProp(x.prop, m.steg) : a, pmin: x.pmin, pmax: x.pmax }));
      const h = GRID.hud(g, Object.assign({}, f, { filtre, kartProp: a }));
      const attr = GRID.flateAttributter(h.antFlater);
      const sw = metning(m.steg);
      const vol = GRID.volum(g, h.syn, { poro: g.props.PORO, ntg: g.props.NTG, porv: g.props.PORV, sw: sw && sw.a, sg: sw && hentProp('SGAS', m.steg) });
      vol.swNavn = sw ? sw.navn : null;
      sisteHud = { celle: h.celle.slice(), verdiFlate: h.verdiFlate || null };
      const verdi = verdierPerHjorne(h.celle, a, h.verdiFlate);
      postMessage({
        type: 'hud', id: m.id, pos: h.pos, celle: h.celle, idx: attr.idx, hj: attr.hj, verdi,
        antFlater: h.antFlater, antCeller: h.antCeller, volum: vol, omrade: h.omrade || null, tid: performance.now() - t0
      }, [h.pos.buffer, h.celle.buffer, attr.idx.buffer, attr.hj.buffer, verdi.buffer]);
    } else if (m.type === 'verdi') {
      if (!sisteHud) return;
      const verdi = verdierPerHjorne(sisteHud.celle, hentVist(m.prop, m.steg, m.ref), null);
      postMessage({ type: 'verdi', id: m.id, verdi }, [verdi.buffer]);
    } else if (m.type === 'stat') {
      postMessage({ type: 'stat', id: m.id, prop: m.prop, stat: stat(m.prop, m.steg, m.ref) });
    } else if (m.type === 'celle') {
      const verdier = [];
      for (const p of Object.keys(g.props)) verdier.push([p, g.props[p][m.c]]);
      if (dyn) for (const p of dyn.navn) if (!g.props[p]) verdier.push([p, hentProp(p, m.steg)[m.c]]);
      if (m.ref != null && erDynamisk(m.prop)) verdier.unshift(['Endring i ' + m.prop, hentVist(m.prop, m.steg, m.ref)[m.c]]);
      postMessage({ type: 'celle', id: m.id, c: m.c, verdier });
    }
  } catch (err) {
    postMessage({ type: 'feil', melding: err && err.message ? err.message : String(err) });
  }
};
