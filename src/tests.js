// Kjør: cd src && node tests.js
'use strict';
const GRDECL = require('./grdecl.js');
const GRID = require('./grid.js');

let ok = 0, feil = 0;
function test(navn, fn) {
  if (process.env.VIS) console.log('> ' + navn);   // VIS=1 node tests.js viser hvilken test som kjører
  try { fn(); ok++; } catch (e) { feil++; console.log('FEIL  ' + navn + '\n      ' + e.message); }
}
function lik(a, b, tol, hva) {
  if (!(Math.abs(a - b) <= (tol || 0))) throw new Error((hva || 'verdi') + ': fikk ' + a + ', ventet ' + b);
}

// Regulært grid nx×ny×nz med 100 m celler og 10 m lag, skrevet som GRDECL-tekst.
function boksTekst(nx, ny, nz, ekstra) {
  let t = '-- testgrid\nSPECGRID\n ' + nx + ' ' + ny + ' ' + nz + ' 1 F /\nCOORD\n';
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++)
    t += (i * 100) + ' ' + (j * 100) + ' 1000 ' + (i * 100) + ' ' + (j * 100) + ' 2000\n';
  t += '/\nZCORN\n';
  for (let k = 0; k < nz; k++) for (let dk = 0; dk < 2; dk++)
    t += (4 * nx * ny) + '*' + (1500 + 10 * (k + dk)) + '\n';
  t += '/\n' + (ekstra || '');
  return t;
}

// --- Parser ---
test('flyt: heltall, desimaler, eksponent og fortegn', () => {
  const f = s => { const b = Buffer.from(s); return GRDECL.flyt(b, 0, b.length); };
  lik(f('42'), 42); lik(f('-3.25'), -3.25); lik(f('.5'), 0.5); lik(f('1.5E3'), 1500);
  lik(f('2.5e-2'), 0.025); lik(f('1D2'), 100); lik(f('7321456.78'), 7321456.78);
  lik(f('0.1'), 0.1); lik(f('+6.02E+23'), 6.02e23, 1e8);
  if (!Number.isNaN(f('abc'))) throw new Error('abc skal gi NaN');
});

test('parse: gjentakelse, kommentarer og tekst etter skråstrek', () => {
  const kw = GRDECL.parseTekst('PORO -- porøsitet\n 3*0.25 0.1\n 2*0.3 / slutt\nNOECHO\nPERMX\n1 2 3 4 5 6 /\n');
  lik(kw.PORO.length, 6); lik(kw.PORO[2], 0.25, 1e-7); lik(kw.PORO[3], 0.1, 1e-7); lik(kw.PORO[5], 0.3, 1e-7);
  lik(kw.PERMX.length, 6); lik(kw.PERMX[5], 6);
  if (kw.NOECHO) throw new Error('NOECHO har ingen data');
});

test('parse: INCLUDE, tekstdata og postlister hoppes over uten å ødelegge data', () => {
  const kw = GRDECL.parseTekst(
    'INCLUDE\n ./INCLUDE/GRID/fil.grdecl /\nGRIDUNIT\n METRES MAP /\nPORO\n4*0.2 /\n' +
    'EQUALS\n PORO 0.1 1 1 1 1 1 1 /\n PERMX 5 /\n/\nCOPY\nPERMX PERMY /\n/\nNTG\n4*1 /\n');
  lik(kw.PORO.length, 4); lik(kw.PORO[0], 0.2, 1e-7); lik(kw.NTG.length, 4);
  if (kw.PERMX || kw.PERMY) throw new Error('postliste ble tolket som data');
});

test('parse: COORD beholder dobbel presisjon for UTM-koordinater', () => {
  const kw = GRDECL.parseTekst('COORD\n 456789.12 7321456.78 1000 456789.12 7321456.78 2000 /\n');
  if (!(kw.COORD instanceof Float64Array)) throw new Error('COORD skal være Float64Array');
  lik(kw.COORD[1], 7321456.78, 1e-9);
});

test('parse: flere filer slås sammen', () => {
  const kw = GRDECL.parseTekst('SPECGRID\n2 1 1 1 F /\n');
  GRDECL.parseTekst('PORO\n0.1 0.2 /\n', kw);
  lik(kw.SPECGRID[0], 2); lik(kw.PORO.length, 2);
});

// --- Grid og hud ---
test('én celle gir seks flater med riktige hjørner', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(1, 1, 1)));
  const h = GRID.hud(g);
  lik(h.antFlater, 6); lik(h.antCeller, 1); lik(h.pos.length, 72);
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < h.pos.length; i += 3) {
    xmin = Math.min(xmin, h.pos[i]); xmax = Math.max(xmax, h.pos[i]);
    ymin = Math.min(ymin, h.pos[i + 1]); ymax = Math.max(ymax, h.pos[i + 1]);
    zmin = Math.min(zmin, h.pos[i + 2]); zmax = Math.max(zmax, h.pos[i + 2]);
  }
  lik(xmax - xmin, 100, 1e-4, 'utstrekning øst'); lik(ymax - ymin, 10, 1e-4, 'tykkelse');
  lik(zmax - zmin, 100, 1e-4, 'utstrekning nord'); lik(xmin, -50, 1e-4, 'sentrering');
});

test('hver flate er et plant rektangel med areal lik analytisk verdi', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(1, 1, 1)));
  const h = GRID.hud(g);
  let sum = 0;
  for (let f = 0; f < 6; f++) {
    const p = i => [h.pos[12 * f + 3 * i], h.pos[12 * f + 3 * i + 1], h.pos[12 * f + 3 * i + 2]];
    const a = p(0), b = p(1), c = p(2), d = p(3);
    const kr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const m = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
    const n1 = kr(m(b, a), m(c, a)), n2 = kr(m(c, a), m(d, a));
    // Riktig rekkefølge rundt firkanten gir to trekanter med samme normalretning.
    if (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] <= 0) throw new Error('flate ' + f + ' er vridd');
    sum += (Math.hypot(...n1) + Math.hypot(...n2)) / 2;
  }
  lik(sum, 2 * 100 * 100 + 4 * 100 * 10, 1e-2, 'overflateareal');
});

test('innvendige flater fjernes: 3×3×3 gir 54 flater', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(3, 3, 3)));
  lik(GRID.hud(g).antFlater, 54); lik(g.antAktive, 27);
});

test('inaktiv celle i midten åpner seks nye flater', () => {
  let act = 'ACTNUM\n13*1 0 13*1 /\n';
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(3, 3, 3, act)));
  lik(g.antAktive, 26); lik(GRID.hud(g).antFlater, 60);
});

test('IJK-filter: ett K-lag av 3×3×3 gir 9+9+12 flater', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(3, 3, 3)));
  const h = GRID.hud(g, { k0: 1, k1: 1 });
  lik(h.antCeller, 9); lik(h.antFlater, 30);
  for (const c of h.celle) if (Math.floor(c / 9) !== 1) throw new Error('celle utenfor laget');
});

test('egenskapsfilter viser bare celler innenfor intervallet', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(2, 1, 1, 'PORO\n0.1 0.3 /\n')));
  const h = GRID.hud(g, { prop: g.props.PORO, pmin: 0.2, pmax: 1 });
  lik(h.antCeller, 1); lik(h.antFlater, 6); lik(h.celle[0], 1);
});

test('forkastning: begge naboflatene tegnes når dybdene ikke passer', () => {
  const kw = GRDECL.parseTekst(boksTekst(2, 1, 1));
  lik(GRID.hud(GRID.lagGrid(kw)).antFlater, 10, 0, 'uten forkastning');
  // Senk celle 2 (i=1) med 5 m: ZCORN-indeks 2 og 3 i hver rad.
  for (let r = 0; r < 4; r++) { kw.ZCORN[4 * r + 2] += 5; kw.ZCORN[4 * r + 3] += 5; }
  lik(GRID.hud(GRID.lagGrid(kw)).antFlater, 12, 0, 'med forkastning');
});

test('skrå pilarer: hjørner interpoleres langs pilaren', () => {
  const kw = GRDECL.parseTekst(
    'SPECGRID\n1 1 1 1 F /\nCOORD\n0 0 1000 100 0 2000\n100 0 1000 200 0 2000\n' +
    '0 100 1000 100 100 2000\n100 100 1000 200 100 2000 /\nZCORN\n4*1500 4*1600 /\n');
  const g = GRID.lagGrid(kw), hj = GRID.hjorner(g, 0, 0, 0, new Float64Array(24));
  // Pilar 0 går fra x=0 ved 1000 m til x=100 ved 2000 m, altså x=50 ved 1500 m og x=60 ved 1600 m.
  lik(hj[0] + g.origo[0], 50, 1e-9, 'x topp'); lik(hj[12] + g.origo[0], 60, 1e-9, 'x bunn');
  lik(g.origo[2] - hj[1], 1500, 1e-9, 'dybde topp');
});

test('celler uten tykkelse regnes som inaktive', () => {
  const kw = GRDECL.parseTekst(boksTekst(1, 1, 2));
  for (let q = 8; q < 16; q++) kw.ZCORN[q] = 1510;   // lag 2 får topp = bunn
  const g = GRID.lagGrid(kw);
  lik(g.antAktive, 1); lik(GRID.hud(g).antFlater, 6);
});

test('blokksentrert grid (DX/DY/DZ/TOPS) gjøres om til hjørnepunkt', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst('DIMENS\n2 2 2 /\nDX\n8*100 /\nDY\n8*50 /\nDZ\n4*10 4*20 /\nTOPS\n4*2000 /\n'));
  lik(g.bbox.x1, 200); lik(g.bbox.y1, 100); lik(g.bbox.z0, 2000, 1e-3); lik(g.bbox.z1, 2030, 1e-3);
  lik(GRID.hud(g).antFlater, 24);
});

test('statistikk: min/maks over aktive celler og heltallsdeteksjon', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(3, 1, 1, 'ACTNUM\n1 1 0 /\nPORO\n0.1 0.2 0.9 /\nSATNUM\n1 2 3 /\nPERMX\n0 10 100 /\n')));
  const s = GRID.statistikk(g, g.props.PORO);
  lik(s.min, 0.1, 1e-7); lik(s.max, 0.2, 1e-7);
  if (s.heltall) throw new Error('PORO er ikke heltall');
  if (!GRID.statistikk(g, g.props.SATNUM).heltall) throw new Error('SATNUM er heltall');
  lik(GRID.statistikk(g, g.props.PERMX).minPos, 10);
});

test('manglende geometri gir forståelig feilmelding', () => {
  let m = '';
  try { GRID.lagGrid(GRDECL.parseTekst('SPECGRID\n2 2 2 1 F /\nPORO\n8*0.2 /\n')); } catch (e) { m = e.message; }
  if (!/COORD/.test(m)) throw new Error('fikk: ' + m);
});

test('flateattributter: to trekanter per firkant', () => {
  const a = GRID.flateAttributter(2);
  if (Array.from(a.idx).join() !== '0,1,2,0,2,3,4,5,6,4,6,7') throw new Error(Array.from(a.idx).join());
  if (Array.from(a.hj.subarray(0, 8)).join() !== '0,0,1,0,1,1,0,1') throw new Error(Array.from(a.hj).join());
});

test('syntetisk modell: forkastning, omriss og egenskaper', () => {
  const g = GRID.lagGrid(GRID.syntetisk(20, 24, 6));
  if (!(g.antAktive > 0 && g.antAktive < g.n)) throw new Error('ventet inaktive celler i hjørnene');
  if (!['PORO', 'PERMX', 'SWAT', 'SATNUM'].every(p => g.props[p])) throw new Error('mangler egenskaper');
  const h = GRID.hud(g);
  // Skallet uten forkastning ville vært færre flater enn med; sjekk at bruddflaggene finnes.
  let brudd = 0; for (const b of g.brudd) if (b & 1) brudd++;
  if (brudd === 0) throw new Error('fant ingen forkastningsflater');
  if (!(h.antFlater < 6 * g.antAktive / 2)) throw new Error('huden er ikke redusert: ' + h.antFlater);
  for (const v of h.pos) if (!Number.isFinite(v)) throw new Error('ugyldig koordinat');
});

test('ytelse: 1 million celler hudlegges på under 2 s', () => {
  const g = GRID.lagGrid(GRID.syntetisk(100, 100, 100));
  const t = Date.now(); const h = GRID.hud(g); const ms = Date.now() - t;
  console.log('      (1 M celler → ' + h.antFlater + ' flater på ' + ms + ' ms)');
  if (ms > 2000) throw new Error(ms + ' ms');
});

// --- Forkastninger og brønner ---
test('parse: poster med tekst, tall og standardverdier fanges', () => {
  const kw = GRDECL.parseTekst(
    "FAULTS\n-- navn\n 'F 1' 2 2 1 3 1 3 'X' /\n F2 1 1 1 1 1 3 Y- / kommentar\n/\n" +
    "WELSPECS\n 'B-2H' 'G' 15 31 1* 'OIL' 2* 'STOP' /\n/\nPORO\n2*0.2 /\n");
  const P = kw._poster;
  lik(P.FAULTS.length, 2);
  if (JSON.stringify(P.FAULTS[0]) !== '["F 1",2,2,1,3,1,3,"X"]') throw new Error(JSON.stringify(P.FAULTS[0]));
  if (P.FAULTS[1][0] !== 'F2' || P.FAULTS[1][7] !== 'Y-') throw new Error(JSON.stringify(P.FAULTS[1]));
  if (JSON.stringify(P.WELSPECS[0]) !== '["B-2H","G",15,31,null,"OIL",null,null,"STOP"]') throw new Error(JSON.stringify(P.WELSPECS[0]));
  lik(kw.PORO.length, 2, 0, 'nøkkelordet etter postlista');
});

test('forkastning: X-flate i 3×3×3 gir 9 loddrette flater på riktig sted', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(3, 3, 3)));
  const f = GRID.forkastninger(g, [['F1', 2, 2, 1, 3, 1, 3, 'X'], ['F1', 1, 1, 1, 1, 1, 1, 'Z'], ['Ukjent', 1, 1, 1, 1, 1, 1, 'Q']]);
  lik(f.navn.length, 1); lik(f.antFlater, 10); lik(f.pos.length, 120);
  // I+-flaten til celle I=2 ligger på x = 200 m, altså 50 m øst for midten (150 m).
  for (let v = 0; v < 36; v++) lik(f.pos[3 * v], 50, 1e-4, 'x på forkastningsplanet');
});

test('forkastning: flater uten aktiv celle på noen side utelates', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(3, 1, 1, 'ACTNUM\n0 0 1 /\n')));
  lik(GRID.forkastninger(g, [['A', 1, 1, 1, 1, 1, 1, 'X']]).antFlater, 0, 0, 'begge sider inaktive');
  const f = GRID.forkastninger(g, [['B', 2, 2, 1, 1, 1, 1, 'X']]);
  lik(f.antFlater, 1, 0, 'nabo aktiv');
  // Flaten hentes fra den aktive naboen (I=3, vestflaten på x = 200 m, 50 m øst for midten).
  for (let v = 0; v < 4; v++) lik(f.pos[3 * v], 50, 1e-4, 'x fra naboens flate');
});

test('brønn: bane gjennom cellesentre, standard-IJ fra brønnhodet og type fra WCON*', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(3, 3, 3)));
  const b = GRID.bronner(g, {
    WELSPECS: [['P1', 'G', 2, 2], ['I1', 'G', 1, 1], ['TOM', 'G', 3, 3]],
    COMPDAT: [['P1', null, null, 1, 3], ['P1', 2, 2, 3, 3], ['I1', 3, 1, 2, 2], ['UKJENT', 1, 1, 1, 1]],
    WCONHIST: [['P1', 'OPEN'], ['I1', 'OPEN']], WCONINJE: [['I1', 'WATER']]
  });
  lik(b.length, 2, 0, 'brønner uten koblinger utelates');
  const p = b[0];
  lik(p.antKoblinger, 3, 0, 'dobbel kobling telles én gang'); lik(p.punkter.length, 12);
  if (p.type !== 'P' || b[1].type !== 'I' || b[1].fase !== 'WATER') throw new Error('feil type');
  // Midtkolonnen: x = z = 0. Lagene ligger på 1505, 1515 og 1525 m; midten av modellen er 1515 m.
  lik(p.punkter[3], 0, 1e-4); lik(p.punkter[5], 0, 1e-4);
  lik(p.punkter[4], 10, 1e-3, 'lag 1'); lik(p.punkter[7], 0, 1e-3, 'lag 2'); lik(p.punkter[10], -10, 1e-3, 'lag 3');
  if (!(p.punkter[1] > 15)) throw new Error('toppunktet skal ligge over modellen');
  lik(b[1].punkter[3], 100, 1e-4, 'I1 koblet til I=3');
});

test('syntetisk modell har forkastning og to brønner', () => {
  const kw = GRID.syntetisk(20, 24, 6), g = GRID.lagGrid(kw);
  const f = GRID.forkastninger(g, kw._poster.FAULTS), b = GRID.bronner(g, kw._poster);
  if (!(f.antFlater > 50)) throw new Error('forkastningsflater: ' + f.antFlater);
  lik(b.length, 2);
  if (b[0].type !== 'P' || b[1].type !== 'I') throw new Error('feil brønntyper');
});

// --- Binærformat (EGRID/INIT/UNRST) ---
test('eclbin: hode, blokker på 1000 elementer og big-endian leses riktig', () => {
  const ECLBIN = require('./eclbin.js');
  // Bygger en fil for hånd: PORO med 1500 REAL (to blokker) og SEQNUM med ett heltall.
  const deler = [];
  const hode = (navn, ant, type) => { const b = Buffer.alloc(24); b.writeInt32BE(16, 0); b.write(navn.padEnd(8), 4, 'latin1'); b.writeInt32BE(ant, 12); b.write(type, 16, 'latin1'); b.writeInt32BE(16, 20); deler.push(b); };
  const blokk = (n, skriv) => { const b = Buffer.alloc(8 + 4 * n); b.writeInt32BE(4 * n, 0); for (let i = 0; i < n; i++) skriv(b, 4 + 4 * i, i); b.writeInt32BE(4 * n, 4 + 4 * n); deler.push(b); };
  hode('PORO', 1500, 'REAL');
  blokk(1000, (b, o, i) => b.writeFloatBE(i * 0.5, o));
  blokk(500, (b, o, i) => b.writeFloatBE(1000 + i, o));
  hode('SEQNUM', 1, 'INTE');
  blokk(1, (b, o) => b.writeInt32BE(7, o));
  const k = ECLBIN.bufferKilde(Buffer.concat(deler));
  if (!ECLBIN.erBinar(k)) throw new Error('skal kjennes igjen som binær');
  const idx = ECLBIN.indeks(k);
  lik(idx.length, 2); lik(idx[0].ant, 1500);
  if (idx[1].navn !== 'SEQNUM' || ECLBIN.filtype(idx) !== 'restart') throw new Error('feil navn/filtype');
  const a = ECLBIN.les(k, idx[0]);
  lik(a.length, 1500); lik(a[999], 499.5); lik(a[1000], 1000); lik(a[1499], 1499);
  lik(ECLBIN.les(k, idx[1])[0], 7);
  if (ECLBIN.erBinar(ECLBIN.bufferKilde(Buffer.from('PORO\n1 /\n')))) throw new Error('tekstfil er ikke binær');
});

// --- Operasjoner, INCLUDE, bitvis lesing, MAPAXES ---
test('operasjoner: EQUALS, MULTIPLY, ADD, COPY, MINVALUE og BOX utføres i rekkefølge', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(3, 1, 1,
    'PORO\n3*0.2 /\nEQUALS\n PORO 0.1 1 1 1 1 1 1 /\n PERMX 100 /\n/\nMULTIPLY\n PERMX 2 3 3 1 1 1 1 /\n/\n' +
    'ADD\n PORO 0.05 /\n/\nCOPY\n PERMX PERMY /\n/\nMINVALUE\n PORO 0.2 /\n/\n' +
    'BOX\n 2 3 1 1 1 1 /\nNTG\n 0.5 0.6 /\nENDBOX\nSWAT\n3*0.3 /\n')));
  const p = g.props;
  lik(p.PORO[0], 0.2, 1e-6, 'PORO celle 1 (0,1+0,05 løftet til 0,2)'); lik(p.PORO[1], 0.25, 1e-6, 'PORO celle 2');
  lik(p.PERMX[0], 100); lik(p.PERMX[2], 200); lik(p.PERMY[2], 200);
  lik(p.NTG[0], 1, 0, 'NTG utenfor boksen får standardverdi'); lik(p.NTG[1], 0.5); lik(p.NTG[2], 0.6, 1e-6);
  lik(p.SWAT[2], 0.3, 1e-6, 'data etter ENDBOX gjelder hele gridet');
});

test('INCLUDE leses inn på riktig sted, og bitvis lesing gir samme resultat', () => {
  const filer = { 'poro.inc': 'PORO\n2*0.2 /\n' };
  const hoved = "SPECGRID\n2 1 1 1 F /\nINCLUDE\n './INCLUDE/poro.inc' /\nMULTIPLY\n PORO 2 /\n/\nINCLUDE\n poro.inc /\n";
  const kw = {};
  const opts = { inkluder: sti => { const f = filer[sti.split(/[\\/]/).pop().toLowerCase()]; if (f) GRDECL.parseTekst(f, kw, opts); } };
  GRDECL.parseTekst(hoved, kw, opts);
  if (kw._include.join() !== './INCLUDE/poro.inc,poro.inc') throw new Error(kw._include.join());
  lik(kw.PORO.length, 2); lik(kw._ops.length, 1);
  // Samme tekst i biter på 7 byte må gi identiske tabeller.
  const tekst = boksTekst(4, 3, 2, 'PORO\n 12*0.25 12*0.125 /\n'), bytes = new TextEncoder().encode(tekst);
  const hel = GRDECL.parse(bytes), biter = GRDECL.parseKilde({ size: bytes.length, les: (p, l) => bytes.subarray(p, Math.min(bytes.length, p + l)) }, {}, null, 7);
  for (const k of ['SPECGRID', 'COORD', 'ZCORN', 'PORO']) {
    lik(biter[k].length, hel[k].length, 0, k + ' lengde');
    for (let i = 0; i < hel[k].length; i++) if (biter[k][i] !== hel[k][i]) throw new Error(k + '[' + i + ']');
  }
});

test('MAPAXES dreier gridet over i kartkoordinater', () => {
  // x-aksen peker mot nord, y-aksen mot vest, origo i (1000, 2000): gridpunkt (300, 0) havner i (1000, 2300).
  const g = GRID.lagGrid(GRDECL.parseTekst('MAPAXES\n 900 2000 1000 2000 1000 2100 /\n' + boksTekst(3, 1, 1)));
  lik(g.bbox.x0, 900, 1e-9); lik(g.bbox.x1, 1000, 1e-9); lik(g.bbox.y0, 2000, 1e-9); lik(g.bbox.y1, 2300, 1e-9);
});

// --- Volum, snitt og kart ---
test('cellevolum: boks og skjev celle (skjærdeformasjon bevarer volumet)', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(2, 2, 2)));
  lik(GRID.cellevolum(g)[0], 100 * 100 * 10, 1e-1, 'boks');
  const skjev = GRID.lagGrid(GRDECL.parseTekst(
    'SPECGRID\n1 1 1 1 F /\nCOORD\n0 0 1000 100 0 2000\n100 0 1000 200 0 2000\n' +
    '0 100 1000 100 100 2000\n100 100 1000 200 100 2000 /\nZCORN\n4*1500 4*1600 /\n'));
  lik(GRID.cellevolum(skjev)[0], 100 * 100 * 100, 1, 'skjev celle');
});

test('volum: bulk, porevolum og HCPV for utvalget', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(2, 1, 1, 'PORO\n0.2 0.3 /\nNTG\n1 0.5 /\nSWAT\n0.25 1 /\n')));
  const syn = GRID.synlige(g).syn, V = 1e5;
  const v = GRID.volum(g, syn, { poro: g.props.PORO, ntg: g.props.NTG, sw: g.props.SWAT });
  lik(v.bulk, 2 * V, 1); lik(v.pv, 0.2 * V + 0.15 * V, 1); lik(v.hcpv, 0.2 * V * 0.75, 1);
  lik(GRID.volum(g, syn, {}).pv, null);
  const porv = GRID.volum(g, GRID.synlige(g, { i0: 1, i1: 1 }).syn, { porv: new Float32Array([7, 9]) });
  lik(porv.bulk, V, 1); lik(porv.pv, 9, 1e-6, 'PORV brukes direkte');
});

test('snitt: loddrett snitt gjennom 3×3×3 har riktig antall flater og areal', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(3, 3, 3)));
  // Øst–vest gjennom midterste rad (3D: x fra −150 til 150, z = 0), og litt utenfor modellen i begge ender.
  const s = GRID.hud(g, { modus: 'snitt', linje: [[-200, 0], [200, 0]] });
  lik(s.antFlater, 9, 0, 'tre kolonner × tre lag');
  let areal = 0;
  for (let f = 0; f < s.antFlater; f++) {
    const p = s.pos.subarray(12 * f, 12 * f + 12);
    areal += Math.abs(p[3] - p[0]) * Math.abs(p[1] - p[10]);
    lik(p[2], 0, 1e-6, 'snittet ligger i planet z = 0');
  }
  lik(areal, 300 * 30, 1, 'areal');
  for (const c of s.celle) lik(Math.floor(c / 3) % 3, 1, 0, 'bare midterste J-rad');
  lik(GRID.hud(g, { modus: 'snitt', linje: [[-200, 0], [200, 0]], k0: 1, k1: 1 }).antFlater, 3, 0, 'K-filter gjelder');
  lik(GRID.hud(g, { modus: 'snitt', linje: [[0, -200], [0, 200], [200, 200]] }).antFlater, 9, 0, 'knekklinje, siste del utenfor');
});

test('kart: tykkelse, gjennomsnitt og sum per kolonne', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(2, 1, 3, 'PORO\n0.1 0.2 0.2 0.2 0.3 0.2 /\nACTNUM\n1 1 1 1 1 0 /\n')));
  const t = GRID.hud(g, { modus: 'kart', kart: 'tykkelse' });
  lik(t.antFlater, 2); lik(t.verdiFlate[0], 30, 1e-4); lik(t.verdiFlate[1], 20, 1e-4, 'inaktiv celle teller ikke');
  const m = GRID.hud(g, { modus: 'kart', kart: 'snitt', kartProp: g.props.PORO });
  lik(m.verdiFlate[0], 0.2, 1e-6); lik(m.verdiFlate[1], 0.2, 1e-6); lik(m.omrade.max, 0.2, 1e-6);
  lik(GRID.hud(g, { modus: 'kart', kart: 'sum', kartProp: g.props.PORO }).verdiFlate[0], 0.6, 1e-6);
  lik(GRID.hud(g, { modus: 'kart', kart: 'tykkelse', k0: 1, k1: 2 }).celle[0], 2, 0, 'tegnes på øverste synlige celle');
});

// --- Forkastningskontakt, tid og brønnbaner ---
test('forkastning: sprang og kontaktflate (sand mot sand) for ett lags forskyvning', () => {
  const kw = GRDECL.parseTekst(boksTekst(2, 1, 2));
  // Senk hele kolonne 2 med 10 m = ett lag. Da ligger lag 2 i vest mot lag 1 i øst.
  for (let r = 0; r < 8; r++) { kw.ZCORN[4 * r + 2] += 10; kw.ZCORN[4 * r + 3] += 10; }
  const f = GRID.forkastninger(GRID.lagGrid(kw), [['F', 1, 1, 1, 1, 1, 2, 'X']]);
  lik(f.antFlater, 2); lik(f.sprang[0], 10, 1e-4); lik(f.sprang[1], 10, 1e-4);
  lik(f.kontakt.antFlater, 1, 0, 'bare lag 2 mot lag 1 overlapper');
  const p = f.kontakt.pos;
  lik(Math.abs(p[1] - p[10]), 10, 1e-4, 'kontaktens høyde'); lik(Math.abs(p[2] - p[5]), 100, 1e-4, 'kontaktens bredde');
  // Halvt lags forskyvning gir to kontakter fra lag 1 og én fra lag 2 (til sammen 5 + 5 + 5 m høyde).
  const kw2 = GRDECL.parseTekst(boksTekst(2, 1, 2));
  for (let r = 0; r < 8; r++) { kw2.ZCORN[4 * r + 2] += 5; kw2.ZCORN[4 * r + 3] += 5; }
  const k2 = GRID.forkastninger(GRID.lagGrid(kw2), [['F', 1, 1, 1, 1, 1, 2, 'X']]).kontakt;
  let h = 0; for (let q = 0; q < k2.antFlater; q++) h += Math.abs(k2.pos[12 * q + 1] - k2.pos[12 * q + 10]);
  lik(k2.antFlater, 3); lik(h, 15, 1e-3, 'samlet kontakthøyde');
});

test('brønner over tid: koblinger får åpningsdato og typen følger WCON*', () => {
  const kw = GRDECL.parseTekst(boksTekst(3, 3, 3,
    "WELSPECS\n 'A' 'G' 1 1 /\n/\nCOMPDAT\n 'A' 1 1 1 1 /\n/\nWCONHIST\n 'A' 'OPEN' /\n/\n" +
    "DATES\n 1 'JAN' 2000 /\n/\nCOMPDAT\n 'A' 1 1 2 3 /\n/\nWCONINJE\n 'A' 'WATER' /\n/\nDATES\n 15 'JUN' 2001 /\n/\n"));
  const g = GRID.lagGrid(kw), b = GRID.bronner(g, kw._poster, kw._hendelser)[0];
  const t = GRID.tidspunkter(kw._hendelser);
  lik(t.length, 2); lik(t[1], Date.UTC(2001, 5, 15));
  lik(b.antKoblinger, 3);
  if (b.tider[0] !== -Infinity) throw new Error('første kobling er fra start');
  lik(b.tider[1], Date.UTC(2000, 0, 1)); lik(b.tider[2], Date.UTC(2000, 0, 1));
  if (JSON.stringify(b.typer.map(x => x[1])) !== '["P","I"]' || b.typer[1][2] !== 'WATER') throw new Error(JSON.stringify(b.typer));
  lik(b.typer[1][0], Date.UTC(2000, 0, 1)); if (b.type !== 'I') throw new Error('sluttype');
});

test('brønnbane: kolonner fra overskrift, navn fra fil, og omregning til 3D', () => {
  const a = GRID.baneTekst('# WELL NAME: B-2H\nMD X Y TVD\n0 100 200 0\n500 110 205 480\n1000 300 260 900\n', 'fil.dev');
  if (a.navn !== 'B-2H') throw new Error(a.navn);
  lik(a.xyz.length, 9); lik(a.xyz[3], 110); lik(a.xyz[5], 480);
  const b = GRID.baneTekst('Northing,Easting,Z(m)\n200,100,-10\n205,110,-480\n', 'D-1H.csv');
  if (b.navn !== 'D-1H') throw new Error(b.navn);
  lik(b.xyz[0], 100, 0, 'x fra Easting'); lik(b.xyz[1], 200); lik(b.xyz[5], 480, 0, 'høyde over havet snus til dybde');
  lik(GRID.baneTekst('1 2 3\n4 5 6\n', 'x.txt').xyz[4], 5, 0, 'uten overskrift: X Y Z');
  if (GRID.baneTekst('PORO\n0.2 /\n', 'x.txt') !== null) throw new Error('ikke en brønnbane');
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(3, 3, 3)));
  const p = GRID.baneTil3D(g, new Float64Array([150, 150, 1515]));
  lik(p[0], 0); lik(p[1], 0); lik(p[2], 0);
});

test('statistikk: histogram og unike verdier', () => {
  const g = GRID.lagGrid(GRDECL.parseTekst(boksTekst(4, 1, 1, 'SATNUM\n1 3 3 2 /\nPERMX\n1 10 100 1000 /\n')));
  const s = GRID.statistikk(g, g.props.SATNUM);
  if (s.unike.join() !== '1,2,3') throw new Error(s.unike.join());
  lik(s.hist.reduce((x, y) => x + y, 0), 4); lik(s.hist[0], 1); lik(s.hist[47], 2);
  const p = GRID.statistikk(g, g.props.PERMX);
  lik(p.histLog[0], 1); lik(p.histLog[16], 1); lik(p.histLog[32], 1); lik(p.histLog[47], 1);
  if (GRID.statistikk(g, g.props.DEPTH).unike && GRID.statistikk(g, g.props.DEPTH).heltall === false) throw new Error('DEPTH er ikke klasser');
  lik(g.props.DEPTH[0], 1505, 1e-3, 'DEPTH = cellesenterets dybde');
});

test('eclbin: SPE1 fra OPM leses riktig (hoppes over uten testdata)', () => {
  const fs = require('fs'), ECLBIN = require('./eclbin.js'), d = '../data/spe1/SPE1CASE1.';
  if (!fs.existsSync(d + 'EGRID')) { console.log('      (ingen testdata i data/spe1)'); return; }
  const k = ECLBIN.bufferKilde(fs.readFileSync(d + 'EGRID')), idx = ECLBIN.indeks(k);
  const hode = ECLBIN.les(k, idx.find(p => p.navn === 'GRIDHEAD'), 4);
  lik(hode[1], 10); lik(hode[2], 10); lik(hode[3], 3);
  const r = ECLBIN.bufferKilde(fs.readFileSync(d + 'UNRST')), steg = ECLBIN.rapportsteg(r, ECLBIN.indeks(r));
  lik(steg.length, 121); lik(steg[0].tid, Date.UTC(2015, 0, 1));
  // SPE1 (Odeh 1981): starttrykk 4800 psia i 8400 fot; trykket i øverste lag ligger like under.
  const p0 = ECLBIN.les(r, steg[0].poster.PRESSURE);
  lik(p0.length, 300); if (!(p0[0] > 4700 && p0[0] < 4800)) throw new Error('starttrykk ' + p0[0]);
});

console.log(ok + ' av ' + (ok + feil) + ' tester besto');
process.exit(feil ? 1 : 0);
