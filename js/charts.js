// Graphiques SVG légers : historique de l'aiguille, loi du nombre de matinées volables, régimes
// par jour, rose des vents, diagramme de fiabilité. Infobulle partagée ; libellés en textContent.

const NS = 'http://www.w3.org/2000/svg';
export const el = (name, attrs = {}, parent) => {
  const n = document.createElementNS(NS, name);
  // Texte SVG : encre discrète et 11 px par défaut, sauf mention contraire.
  if (name === 'text') attrs = { fill: 'var(--muted)', 'font-size': 11, ...attrs };
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
export const h = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.setAttribute('style', v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return n;
};

// ---------------------------------------------------------------- infobulle
let tipEl = null;
export function tooltip() {
  if (!tipEl) {
    tipEl = h('div', { class: 'tooltip', role: 'status' });
    document.body.appendChild(tipEl);
  }
  return {
    show(x, y, ...content) {
      tipEl.replaceChildren(...content);
      tipEl.classList.add('show');
      const r = tipEl.getBoundingClientRect();
      let left = x + 14;
      let top = y + 14;
      if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
      if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
      tipEl.style.left = `${Math.max(8, left)}px`;
      tipEl.style.top = `${Math.max(8, top)}px`;
    },
    hide() {
      tipEl.classList.remove('show');
    },
  };
}

// ---------------------------------------------------------------- couleurs
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const SEQ = ['--seq-100', '--seq-200', '--seq-300', '--seq-400', '--seq-500', '--seq-600', '--seq-700'];
/** Cellule de chaleur pour une probabilité : fond de la rampe bleue, texte blanc ou encre selon la luminance. */
export function heat(p) {
  if (p == null) return { bg: 'transparent', fg: 'var(--muted)' };
  const i = Math.max(0, Math.min(SEQ.length - 1, Math.round(p * (SEQ.length - 1))));
  return { bg: `var(${SEQ[i]})`, fg: i >= 3 ? '#fff' : '#0b0b0b' };
}

export const fmtPct = (p) => (p == null ? '—' : `${Math.round(p * 100)} %`);
export const fmtScore = (s) => (s == null ? '—' : `${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(s)}`);
const fmtDate = (iso, opts) => new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', ...opts });

function sizeOf(container, ratio, min = 240) {
  const w = Math.max(min, Math.round(container.clientWidth || container.parentElement?.clientWidth || 600));
  return { w, h: Math.round(w * ratio) };
}

// ---------------------------------------------------------------- historique de l'aiguille
export function historyChart(container, history, { climScore, stageStart, stageEnd }) {
  container.replaceChildren();
  const { w } = sizeOf(container, 0.35);
  const hgt = Math.max(210, Math.min(300, Math.round(w * 0.36)));
  const m = { t: 14, r: 44, b: 30, l: 40 };
  const svg = el('svg', { viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, role: 'img', 'aria-label': 'Évolution de l’aiguille à chaque mise à jour' }, container);
  const pts = history.map((e) => ({ ...e, x: Date.parse(e.t) }));
  const x0 = Math.min(pts[0]?.x ?? Date.now(), Date.now()) - 6 * 3600e3;
  const x1 = Date.parse(stageEnd);
  const X = (t) => m.l + ((t - x0) / (x1 - x0)) * (w - m.l - m.r);
  const Y = (s) => m.t + ((180 - s) / 360) * (hgt - m.t - m.b);
  // zones et grille
  el('rect', { x: m.l, y: Y(180), width: w - m.l - m.r, height: Y(60) - Y(180), fill: 'var(--good)', opacity: 0.05 }, svg);
  el('rect', { x: m.l, y: Y(-60), width: w - m.l - m.r, height: Y(-180) - Y(-60), fill: 'var(--critical)', opacity: 0.05 }, svg);
  const xs = X(Date.parse(stageStart));
  el('rect', { x: xs, y: m.t, width: X(x1) - xs, height: hgt - m.t - m.b, fill: 'var(--accent)', opacity: 0.07 }, svg);
  const st = el('text', { x: xs + 4, y: m.t + 11, 'font-size': 11 }, svg);
  st.textContent = 'stage';
  for (const s of [-180, -90, 0, 90, 180]) {
    el('line', { x1: m.l, x2: w - m.r, y1: Y(s), y2: Y(s), stroke: s === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }, svg);
    const t = el('text', { x: m.l - 6, y: Y(s) + 4, 'text-anchor': 'end' }, svg);
    t.textContent = fmtScore(s);
  }
  // graduations de dates (tous les 3 jours)
  const d0 = new Date(x0);
  d0.setUTCHours(0, 0, 0, 0);
  for (let t = d0.getTime(); t <= x1; t += 86400e3) {
    const day = new Date(t);
    if ((day.getUTCDate() - 1) % 3 !== 0 || X(t) < m.l) continue;
    const tx = el('text', { x: X(t), y: hgt - 10, 'text-anchor': 'middle' }, svg);
    tx.textContent = fmtDate(day.toISOString(), { day: 'numeric', month: 'short' });
    el('line', { x1: X(t), x2: X(t), y1: hgt - m.b, y2: hgt - m.b + 4, stroke: 'var(--axis)' }, svg);
  }
  if (climScore != null) {
    el('line', { x1: m.l, x2: w - m.r, y1: Y(climScore), y2: Y(climScore), stroke: 'var(--muted)', 'stroke-width': 1, opacity: 0.8 }, svg);
    const ct = el('text', { x: w - m.r + 4, y: Y(climScore) + 4 }, svg);
    ct.textContent = 'normale';
  }
  if (!pts.length) return;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.score).toFixed(1)}`).join('');
  el('path', { d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  const showAll = pts.length <= 60;
  pts.forEach((p, i) => {
    if (!showAll && i !== pts.length - 1) return;
    el('circle', { cx: X(p.x), cy: Y(p.score), r: 4, fill: 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
  });
  const lastP = pts.at(-1);
  const lt = el('text', { x: X(lastP.x) + 8, y: Y(lastP.score) - 8, fill: 'var(--ink)', 'font-weight': 600, 'font-size': 12 }, svg);
  lt.textContent = fmtScore(lastP.score);
  // réticule
  const cross = el('line', { y1: m.t, y2: hgt - m.b, stroke: 'var(--ink-2)', 'stroke-width': 1, opacity: 0 }, svg);
  const dot = el('circle', { r: 5, fill: 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 }, svg);
  const hit = el('rect', { x: m.l, y: m.t, width: w - m.l - m.r, height: hgt - m.t - m.b, fill: 'transparent', tabindex: 0 }, svg);
  const tip = tooltip();
  const showAt = (i, cx, cy) => {
    const p = pts[i];
    cross.setAttribute('x1', X(p.x));
    cross.setAttribute('x2', X(p.x));
    cross.setAttribute('opacity', 1);
    dot.setAttribute('cx', X(p.x));
    dot.setAttribute('cy', Y(p.score));
    dot.setAttribute('opacity', 1);
    tip.show(cx, cy,
      h('div', { class: 'tv' }, `${fmtScore(p.score)} · ${fmtPct(p.p)}`),
      h('div', { class: 'tl' }, fmtDate(p.t, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })),
      h('div', { class: 'tl' }, (p.trigger ?? []).join(', ')));
  };
  const nearest = (clientX) => {
    const r = svg.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * w;
    let best = 0;
    pts.forEach((p, i) => {
      if (Math.abs(X(p.x) - px) < Math.abs(X(pts[best].x) - px)) best = i;
    });
    return best;
  };
  hit.addEventListener('pointermove', (e) => showAt(nearest(e.clientX), e.clientX, e.clientY));
  hit.addEventListener('pointerleave', () => {
    tip.hide();
    cross.setAttribute('opacity', 0);
    dot.setAttribute('opacity', 0);
  });
  hit.addEventListener('focus', () => {
    const r = svg.getBoundingClientRect();
    showAt(pts.length - 1, r.left + (X(lastP.x) / w) * r.width, r.top + 20);
  });
  hit.addEventListener('blur', () => tip.hide());
}

// ---------------------------------------------------------------- nombre de matinées volables
export function distChart(container, dist, climDist, need) {
  container.replaceChildren();
  const { w } = sizeOf(container, 0.5, 260);
  const hgt = 210;
  const m = { t: 24, r: 10, b: 34, l: 10 };
  const svg = el('svg', { viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, role: 'img', 'aria-label': 'Probabilité de 0 à 4 matinées volables' }, container);
  const max = Math.max(...dist, ...climDist, 0.3);
  const band = (w - m.l - m.r) / dist.length;
  const bw = Math.min(40, band * 0.5);
  const Y = (p) => hgt - m.b - (p / max) * (hgt - m.t - m.b);
  el('line', { x1: m.l, x2: w - m.r, y1: hgt - m.b, y2: hgt - m.b, stroke: 'var(--axis)' }, svg);
  const tip = tooltip();
  dist.forEach((p, k) => {
    const cx = m.l + band * (k + 0.5);
    const y = Y(p);
    const hh = hgt - m.b - y;
    const r = Math.min(4, hh);
    const fill = k >= need ? 'var(--accent)' : 'var(--seq-200)';
    const path = `M${cx - bw / 2},${hgt - m.b} L${cx - bw / 2},${y + r} Q${cx - bw / 2},${y} ${cx - bw / 2 + r},${y} L${cx + bw / 2 - r},${y} Q${cx + bw / 2},${y} ${cx + bw / 2},${y + r} L${cx + bw / 2},${hgt - m.b} Z`;
    const bar = el('path', { d: path, fill, tabindex: 0 }, svg);
    const v = el('text', { x: cx, y: y - 6, 'text-anchor': 'middle', fill: 'var(--ink)', 'font-weight': 600, 'font-size': 12 }, svg);
    v.textContent = fmtPct(p);
    const cy = Y(climDist[k]);
    el('line', { x1: cx - bw / 2 - 6, x2: cx + bw / 2 + 6, y1: cy, y2: cy, stroke: 'var(--ink)', 'stroke-width': 2, 'stroke-linecap': 'round' }, svg);
    const lab = el('text', { x: cx, y: hgt - m.b + 16, 'text-anchor': 'middle', 'font-size': 12, fill: 'var(--ink-2)' }, svg);
    lab.textContent = `${k}`;
    const show = (e) => tip.show(e.clientX ?? 0, e.clientY ?? 0,
      h('div', { class: 'tv' }, fmtPct(p)),
      h('div', { class: 'tl' }, `${k} matinée${k > 1 ? 's' : ''} volable${k > 1 ? 's' : ''} sur 4`),
      h('div', { class: 'tl' }, `climatologie : ${fmtPct(climDist[k])}`));
    bar.addEventListener('pointermove', show);
    bar.addEventListener('pointerleave', () => tip.hide());
    bar.addEventListener('focus', () => {
      const r = bar.getBoundingClientRect();
      show({ clientX: r.right, clientY: r.top });
    });
    bar.addEventListener('blur', () => tip.hide());
  });
  const cap = el('text', { x: w / 2, y: hgt - 4, 'text-anchor': 'middle', 'font-size': 11 }, svg);
  cap.textContent = 'matinées volables sur les 4 jours';
}

// ---------------------------------------------------------------- régimes par jour (barres empilées)
export function regimeBars(container, rows, families) {
  container.replaceChildren();
  const { w } = sizeOf(container, 0.3, 260);
  const rowH = 26;
  const gap = 14;
  const m = { t: 4, r: 8, b: 4, l: 86 };
  const hgt = m.t + m.b + rows.length * rowH + (rows.length - 1) * gap;
  const svg = el('svg', { viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, role: 'img', 'aria-label': 'Régimes météo par matinée' }, container);
  const tip = tooltip();
  const inner = w - m.l - m.r;
  rows.forEach((row, i) => {
    const y = m.t + i * (rowH + gap);
    const lab = el('text', { x: m.l - 8, y: y + rowH / 2 + 4, 'text-anchor': 'end', fill: 'var(--ink-2)', 'font-size': 12 }, svg);
    lab.textContent = row.label;
    if (!row.parts.length) {
      const t = el('text', { x: m.l, y: y + rowH / 2 + 4, 'font-size': 12 }, svg);
      t.textContent = 'climatologie seule (aucun ensemble)';
      return;
    }
    let x = m.l;
    const segs = row.parts.filter((p) => p.p > 0);
    segs.forEach((p, j) => {
      const fam = families[p.id];
      const width = p.p * inner - (j < segs.length - 1 ? 2 : 0);
      if (width <= 0.5) {
        x += p.p * inner;
        return;
      }
      const first = j === 0;
      const last = j === segs.length - 1;
      const r = Math.min(4, width / 2);
      const x2 = x + width;
      const d = `M${x + (first ? r : 0)},${y} L${x2 - (last ? r : 0)},${y} ${last ? `Q${x2},${y} ${x2},${y + r} L${x2},${y + rowH - r} Q${x2},${y + rowH} ${x2 - r},${y + rowH}` : `L${x2},${y} L${x2},${y + rowH}`} L${x + (first ? r : 0)},${y + rowH} ${first ? `Q${x},${y + rowH} ${x},${y + rowH - r} L${x},${y + r} Q${x},${y} ${x + r},${y}` : `L${x},${y + rowH} L${x},${y}`} Z`;
      const seg = el('path', { d, fill: `var(${fam.color})`, tabindex: 0 }, svg);
      if (width > 38) {
        const t = el('text', { x: x + width / 2, y: y + rowH / 2 + 4, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 600, fill: fam.ink }, svg);
        t.textContent = fmtPct(p.p);
      }
      const show = (e) => tip.show(e.clientX, e.clientY,
        h('div', { class: 'tv' }, fmtPct(p.p)),
        h('div', { class: 'tl' }, `${fam.label} — ${row.label}`),
        p.pFly != null ? h('div', { class: 'tl' }, `matinée volable dans ce régime : ${fmtPct(p.pFly)}`) : null);
      seg.addEventListener('pointermove', show);
      seg.addEventListener('pointerleave', () => tip.hide());
      seg.addEventListener('focus', () => {
        const r2 = seg.getBoundingClientRect();
        show({ clientX: r2.right, clientY: r2.top });
      });
      seg.addEventListener('blur', () => tip.hide());
      x += p.p * inner;
    });
  });
}

// ---------------------------------------------------------------- rose des vents
export function windRose(container, sectors, calm) {
  container.replaceChildren();
  const size = Math.min(320, Math.max(220, container.clientWidth || 280));
  const c = size / 2;
  const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': 'Rose des vents des matinées d’octobre à Millau' }, container);
  const max = Math.max(...sectors.map((s) => s.freq), 0.05);
  const R = c - 30;
  const R0 = 26; // cercle central : part de vent calme
  for (const f of [0.25, 0.5, 0.75, 1]) el('circle', { cx: c, cy: c, r: R0 + (R - R0) * f, fill: 'none', stroke: 'var(--grid)' }, svg);
  const tip = tooltip();
  sectors.forEach((s, i) => {
    const a0 = ((i * 45 - 18) * Math.PI) / 180;
    const a1 = ((i * 45 + 18) * Math.PI) / 180;
    const wedge = (r) => {
      const ro = R0 + r;
      return `M${c + R0 * Math.sin(a0)},${c - R0 * Math.cos(a0)} L${c + ro * Math.sin(a0)},${c - ro * Math.cos(a0)} A${ro},${ro} 0 0 1 ${c + ro * Math.sin(a1)},${c - ro * Math.cos(a1)} L${c + R0 * Math.sin(a1)},${c - R0 * Math.cos(a1)} A${R0},${R0} 0 0 0 ${c + R0 * Math.sin(a0)},${c - R0 * Math.cos(a0)} Z`;
    };
    const r = (s.freq / max) * (R - R0);
    const g = el('g', { tabindex: 0 }, svg);
    el('path', { d: wedge(r), fill: 'var(--seq-200)' }, g);
    if (s.fly) el('path', { d: wedge(r * s.fly), fill: 'var(--accent)' }, g);
    const lp = { x: c + (R + 16) * Math.sin((i * 45 * Math.PI) / 180), y: c - (R + 16) * Math.cos((i * 45 * Math.PI) / 180) };
    const t = el('text', { x: lp.x, y: lp.y + 4, 'text-anchor': 'middle', 'font-size': 12, fill: 'var(--ink-2)', 'font-weight': 600 }, svg);
    t.textContent = s.sector;
    const show = (e) => tip.show(e.clientX, e.clientY,
      h('div', { class: 'tv' }, `${fmtPct(s.freq)} des heures`),
      h('div', { class: 'tl' }, `Vent de ${s.sector}, ${s.ws ?? '—'} km/h en moyenne`),
      h('div', { class: 'tl' }, `volables : ${fmtPct(s.fly)}`));
    g.addEventListener('pointermove', show);
    g.addEventListener('pointerleave', () => tip.hide());
  });
  el('circle', { cx: c, cy: c, r: R0 - 2, fill: 'var(--surface-2)' }, svg);
  const ct = el('text', { x: c, y: c - 2, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--ink-2)' }, svg);
  ct.textContent = 'calme';
  const cv = el('text', { x: c, y: c + 11, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 600, fill: 'var(--ink)' }, svg);
  cv.textContent = fmtPct(calm);
}

// ---------------------------------------------------------------- fiabilité de la calibration
export function reliabilityChart(container, bins) {
  container.replaceChildren();
  const size = Math.min(300, Math.max(220, container.clientWidth || 260));
  const m = 34;
  const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': 'Probabilité prévue contre fréquence observée' }, container);
  const S = (v) => m + v * (size - 2 * m);
  const Yv = (v) => size - m - v * (size - 2 * m);
  for (const v of [0, 0.5, 1]) {
    el('line', { x1: S(0), x2: S(1), y1: Yv(v), y2: Yv(v), stroke: 'var(--grid)' }, svg);
    const t = el('text', { x: S(0) - 6, y: Yv(v) + 4, 'text-anchor': 'end' }, svg);
    t.textContent = fmtPct(v);
    const t2 = el('text', { x: S(v), y: size - m + 16, 'text-anchor': 'middle' }, svg);
    t2.textContent = fmtPct(v);
  }
  el('line', { x1: S(0), y1: Yv(0), x2: S(1), y2: Yv(1), stroke: 'var(--axis)' }, svg);
  const tip = tooltip();
  for (const b of bins) {
    const circ = el('circle', { cx: S(b.pred), cy: Yv(b.obs), r: Math.max(4, Math.sqrt(b.n) / 2.2), fill: 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': 2, 'fill-opacity': 0.85 }, svg);
    circ.addEventListener('pointermove', (e) => tip.show(e.clientX, e.clientY,
      h('div', { class: 'tv' }, `observé ${fmtPct(b.obs)}`),
      h('div', { class: 'tl' }, `prévu ${fmtPct(b.pred)} · ${b.n} matinées`)));
    circ.addEventListener('pointerleave', () => tip.hide());
  }
  const xl = el('text', { x: size / 2, y: size - 4, 'text-anchor': 'middle' }, svg);
  xl.textContent = 'probabilité prévue (ERA5 calibré)';
}
