// Produksjonskurver: små delfigurer med felles tidsakse, én per enhet (aldri to y-akser i samme
// figur). Simulert verdi tegnes heltrukket og historisk stiplet i samme farge. En loddrett linje
// viser tidspunktet som er valgt i 3D-visningen; klikk eller dra i en figur for å flytte det.
(function () {
  'use strict';
  const css = navn => getComputedStyle(document.documentElement).getPropertyValue(navn).trim();
  const FARGE = { olje: '--olje', vann: '--vann', gass: '--gass', trykk: '--tekst' };
  const ENHET = { 'SM3/DAY': 'Sm³/d', 'RM3/DAY': 'Rm³/d', 'BARSA': 'bar', 'BAR': 'bar', 'SM3/SM3': 'Sm³/Sm³', '': '' };
  const kort = v => Math.abs(v) >= 1e4 ? v.toLocaleString('nb-NO', { notation: 'compact', maximumSignificantDigits: 3 })
    : v.toLocaleString('nb-NO', { maximumSignificantDigits: 3 });
  const dato = t => new Date(t).toLocaleDateString('nb-NO', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const M = { v: 46, h: 8, t: 6, b: 18 };   // marger rundt tegneflaten

  let data = null, figurer = [], tid = null, peker = null, velgTid = null;

  // «Pene» aksegrenser: 1, 2 eller 5 ganger en tierpotens.
  function pent(maks) {
    if (!(maks > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(maks))), m = maks / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }

  function vis(el, d, opts) {
    data = d; velgTid = opts && opts.velgTid; peker = null;
    el.innerHTML = '';
    figurer = d.figurer.map(f => {
      const boks = document.createElement('div'); boks.className = 'fig';
      const h = document.createElement('h3');
      h.textContent = f.tittel + (ENHET[f.enhet] != null ? (ENHET[f.enhet] ? ' · ' + ENHET[f.enhet] : '') : ' · ' + f.enhet);
      const c = document.createElement('canvas');
      c.setAttribute('role', 'img');
      c.setAttribute('aria-label', f.tittel + ' over tid for ' + (d.navn || 'feltet') + ': ' + f.serier.map(s => s.etikett).join(', '));
      const leg = document.createElement('div'); leg.className = 'leg';
      const ruter = f.serier.map(s => {
        const r = document.createElement('span');
        const m = document.createElement('i'); m.className = s.hist ? 'hist' : ''; m.style.color = 'var(' + FARGE[s.farge] + ')';
        const v = document.createElement('b');
        r.append(m, s.etikett + ' ', v); leg.appendChild(r);
        return v;
      });
      boks.append(h, c, leg); el.appendChild(boks);
      // Trykk måles ikke fra null; nullverdier er stengte perioder og holdes utenfor.
      let lo = 0, hi = 0;
      if (f.serier[0].farge === 'trykk') {
        lo = Infinity;
        for (const s of f.serier) for (const v of s.verdier) if (v > 0) { if (v < lo) lo = v; if (v > hi) hi = v; }
        const steg = pent((hi - lo) / 3 || 1);
        lo = Math.floor(lo / steg) * steg; hi = Math.max(lo + steg, Math.ceil(hi / steg) * steg);
      } else {
        for (const s of f.serier) for (const v of s.verdier) if (v > hi) hi = v;
        hi = pent(hi);
      }
      const fig = { f, c, ruter, lo, hi, trykk: f.serier[0].farge === 'trykk' };
      const tilTid = e => {
        const r = c.getBoundingClientRect(), x = (e.clientX - r.left - M.v) / (r.width - M.v - M.h);
        const t = d.tider, a = t[0], b = t[t.length - 1];
        return a + Math.max(0, Math.min(1, x)) * (b - a);
      };
      c.addEventListener('pointermove', e => { peker = tilTid(e); if (c.hasPointerCapture(e.pointerId) && velgTid) velgTid(peker); tegn(); });
      c.addEventListener('pointerleave', () => { peker = null; tegn(); });
      c.addEventListener('pointerdown', e => { c.setPointerCapture(e.pointerId); if (velgTid) velgTid(tilTid(e)); });
      return fig;
    });
    tegn();
  }

  // Indeksen til siste ministeg som ikke er senere enn t.
  function indeks(t) {
    const a = data.tider;
    let lo = 0, hi = a.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m] <= t) lo = m; else hi = m - 1; }
    return lo;
  }

  function tegn() {
    if (!data) return;
    const t = data.tider, t0 = t[0], t1 = t[t.length - 1], dpr = window.devicePixelRatio || 1;
    const kant = css('--kant'), dempet = css('--dempet'), markor = css('--markor'), tekst = css('--tekst');
    const les = peker != null ? peker : tid;
    const iLes = les != null && les >= t0 && les <= t1 ? indeks(les) : -1;
    for (const g of figurer) {
      const c = g.c, W = c.clientWidth, H = c.clientHeight;
      if (!W || !H) continue;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const pw = W - M.v - M.h, ph = H - M.t - M.b;
      const X = v => M.v + (t1 > t0 ? (v - t0) / (t1 - t0) : 0) * pw, Y = v => M.t + (1 - (v - g.lo) / (g.hi - g.lo)) * ph;
      // rutenett og akser
      ctx.font = '10px system-ui, sans-serif'; ctx.lineWidth = 1; ctx.strokeStyle = kant; ctx.fillStyle = dempet;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let n = 0; n <= 2; n++) {
        const v = g.lo + (g.hi - g.lo) * n / 2, y = Math.round(Y(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(M.v, y); ctx.lineTo(W - M.h, y); ctx.stroke();
        ctx.fillText(kort(v), M.v - 5, y);
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const a0 = new Date(t0).getUTCFullYear(), a1 = new Date(t1).getUTCFullYear();
      if (a1 > a0) {
        const hopp = Math.max(1, Math.ceil((a1 - a0) / Math.max(1, Math.floor(pw / 44))));
        for (let ar = a0 + 1; ar <= a1; ar += hopp) {
          const x = X(Date.UTC(ar, 0, 1));
          if (x < M.v + 12 || x > W - M.h - 12) continue;
          ctx.fillRect(Math.round(x), M.t + ph, 1, 3);
          ctx.fillText(String(ar), x, M.t + ph + 5);
        }
      } else {
        ctx.textAlign = 'left'; ctx.fillText(dato(t0), M.v, M.t + ph + 5);
        ctx.textAlign = 'right'; ctx.fillText(dato(t1), W - M.h, M.t + ph + 5);
      }
      // kurver
      ctx.save();
      ctx.beginPath(); ctx.rect(M.v, M.t - 2, pw, ph + 4); ctx.clip();
      ctx.lineJoin = 'round';
      for (const s of g.f.serier) {
        ctx.strokeStyle = css(FARGE[s.farge]); ctx.lineWidth = s.hist ? 1.5 : 2; ctx.setLineDash(s.hist ? [4, 3] : []);
        ctx.beginPath();
        let penn = false;
        for (let i = 0; i < t.length; i++) {
          const v = s.verdier[i];
          if (g.trykk && !(v > 0)) { penn = false; continue; }
          if (penn) ctx.lineTo(X(t[i]), Y(v)); else { ctx.moveTo(X(t[i]), Y(v)); penn = true; }
        }
        ctx.stroke();
      }
      ctx.restore(); ctx.setLineDash([]);
      // valgt tid i 3D-visningen, og pekeren
      const strek = (v, farge, bredde) => {
        if (v == null || v < t0 || v > t1) return;
        ctx.fillStyle = farge; ctx.fillRect(Math.round(X(v)) - (bredde >> 1), M.t, bredde, ph);
      };
      strek(tid, markor, 2);
      if (peker != null) strek(peker, tekst, 1);
      g.ruter.forEach((r, n) => {
        const v = iLes < 0 ? null : g.f.serier[n].verdier[iLes];
        r.textContent = v == null ? '' : g.trykk && !(v > 0) ? '–' : kort(v);   // trykk 0 = stengt brønn
      });
    }
    const ut = document.getElementById('kurveLes');
    if (ut) ut.textContent = iLes < 0 ? '' : dato(t[iLes]);
  }

  window.KURVEPANEL = { vis, tegn, settTid(t) { tid = t; tegn(); }, tom() { data = null; figurer = []; } };
  window.addEventListener('resize', tegn);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', tegn);
})();
