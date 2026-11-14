// Bakgrunnstråd: leser filer, holder gridet og regner ut synlige flater,
// slik at grensesnittet aldri fryser mens store modeller behandles.
'use strict';
importScripts('grdecl.js', 'grid.js');

let g = null;

function sendGrid(t0, navn, poster) {
  const fk = GRID.forkastninger(g, poster && poster.FAULTS);
  const fa = GRID.flateAttributter(fk.antFlater);
  const forkast = { navn: fk.navn, pos: fk.pos, eier: fk.eier, idx: fa.idx, antFlater: fk.antFlater };
  const bronner = GRID.bronner(g, poster);
  const props = {};
  for (const p of Object.keys(g.props)) {
    props[p] = Object.assign({ data: g.props[p] }, GRID.statistikk(g, g.props[p]));
  }
  postMessage({
    type: 'grid', navn, nx: g.nx, ny: g.ny, nz: g.nz, antAktive: g.antAktive,
    bbox: g.bbox, origo: g.origo, props, forkast, bronner, tid: performance.now() - t0
  });
}

onmessage = function (e) {
  const m = e.data;
  try {
    const t0 = performance.now();
    if (m.type === 'filer') {
      const kw = {};
      for (const f of m.filer) GRDECL.parse(new Uint8Array(f.buf), kw);
      g = GRID.lagGrid(kw);
      sendGrid(t0, m.filer.map(f => f.navn).join(', '), kw._poster);
    } else if (m.type === 'demo') {
      const kw = GRID.syntetisk(m.nx, m.ny, m.nz);
      g = GRID.lagGrid(kw);
      sendGrid(t0, 'Eksempelmodell (syntetisk)', kw._poster);
    } else if (m.type === 'hud') {
      if (!g) return;
      const f = m.filter;
      const h = GRID.hud(g, Object.assign({}, f, { prop: f.propNavn ? g.props[f.propNavn] : null }));
      const a = GRID.flateAttributter(h.antFlater);
      postMessage({
        type: 'hud', id: m.id, pos: h.pos, celle: h.celle, idx: a.idx, hj: a.hj,
        antFlater: h.antFlater, antCeller: h.antCeller, tid: performance.now() - t0
      }, [h.pos.buffer, h.celle.buffer, a.idx.buffer, a.hj.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'feil', melding: err && err.message ? err.message : String(err) });
  }
};
