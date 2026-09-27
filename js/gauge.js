// VU-mètre SVG : échelle −180 (impossible) → +180 (le stage aura lieu), aiguille amortie comme un
// vrai galvanomètre, traînée des positions précédentes et repère de la normale climatologique.

const NS = 'http://www.w3.org/2000/svg';
const W = 600;
const H = 360;
const C = { x: 300, y: 352 }; // pivot, caché sous le bandeau comme sur un vrai VU-mètre
const R = 262; // rayon de l'échelle
const SWEEP = 60; // demi-course en degrés
const BEZEL_Y = 304;

const el = (name, attrs = {}, parent) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
const angleOf = (score) => (Math.max(-180, Math.min(180, score)) / 180) * SWEEP;
const polar = (deg, r) => {
  const t = (deg * Math.PI) / 180;
  return { x: C.x + r * Math.sin(t), y: C.y - r * Math.cos(t) };
};
const arcPath = (a0, a1, r0, r1) => {
  const p0 = polar(a0, r1);
  const p1 = polar(a1, r1);
  const p2 = polar(a1, r0);
  const p3 = polar(a0, r0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${p0.x},${p0.y} A${r1},${r1} 0 ${large} 1 ${p1.x},${p1.y} L${p2.x},${p2.y} A${r0},${r0} 0 ${large} 0 ${p3.x},${p3.y} Z`;
};

function hexToRgb(hex) {
  const h = hex.trim().replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function createGauge(container, { label = '' } = {}) {
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
  container.appendChild(svg);
  const defs = el('defs', {}, svg);
  const face = el('linearGradient', { id: 'vu-face', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: '0', 'stop-color': 'var(--dial-top)' }, face);
  el('stop', { offset: '1', 'stop-color': 'var(--dial-bottom)' }, face);
  const glow = el('radialGradient', { id: 'vu-glow', cx: '0.5', cy: '0.62', r: '0.62' }, defs);
  el('stop', { offset: '0', 'stop-color': 'var(--dial-glow)' }, glow);
  el('stop', { offset: '1', 'stop-color': 'rgba(0,0,0,0)' }, glow);
  const shadow = el('filter', { id: 'vu-shadow', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
  el('feDropShadow', { dx: '2', dy: '3', stdDeviation: '2', 'flood-opacity': '0.28' }, shadow);

  el('rect', { x: 0, y: 0, width: W, height: H, rx: 14, fill: 'url(#vu-face)' }, svg);
  el('rect', { x: 0, y: 0, width: W, height: H, rx: 14, fill: 'url(#vu-glow)' }, svg);

  const band = el('g', {}, svg);
  const scale = el('g', { fill: 'none', stroke: 'var(--dial-ink)' }, svg);
  el('path', { d: `M${polar(-SWEEP, R).x},${polar(-SWEEP, R).y} A${R},${R} 0 0 1 ${polar(SWEEP, R).x},${polar(SWEEP, R).y}`, 'stroke-width': 1.6 }, scale);
  const labels = el('g', { fill: 'var(--dial-ink)', 'font-family': 'system-ui, -apple-system, sans-serif', 'text-anchor': 'middle' }, svg);
  for (let s = -180; s <= 180; s += 15) {
    const a = angleOf(s);
    const major = s % 60 === 0;
    const mid = s % 30 === 0;
    const p0 = polar(a, R);
    const p1 = polar(a, R + (major ? 20 : mid ? 13 : 8));
    el('line', { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, 'stroke-width': major ? 2.2 : 1.2 }, scale);
    if (major) {
      const p = polar(a, R + 36);
      const t = el('text', { x: p.x, y: p.y + 6, 'font-size': 17, 'font-weight': s === 0 ? 700 : 600 }, labels);
      t.textContent = s > 0 ? `+${s}` : s === 0 ? '0' : `−${-s}`;
    }
  }
  // Libellés du cadran
  const vu = el('text', { x: C.x, y: 236, 'font-size': 40, 'font-weight': 700, 'letter-spacing': '2' }, labels);
  vu.textContent = 'VU';
  const vuSub = el('text', { x: C.x, y: 258, 'font-size': 11.5, 'letter-spacing': '1.6', fill: 'var(--dial-soft)' }, labels);
  vuSub.textContent = 'VOLS UTILES · 3 MATINÉES';
  const left = el('text', { x: 64, y: 262, 'font-size': 12, 'font-weight': 700, 'letter-spacing': '1.4', 'text-anchor': 'start', fill: 'var(--critical)' }, labels);
  left.textContent = 'IMPOSSIBLE';
  const right = el('text', { x: W - 64, y: 262, 'font-size': 12, 'font-weight': 700, 'letter-spacing': '1.4', 'text-anchor': 'end', fill: 'var(--good)' }, labels);
  right.textContent = 'AURA LIEU';

  const clim = el('g', {}, svg);
  const trail = el('g', {}, svg);
  const needle = el('g', { filter: 'url(#vu-shadow)' }, svg);
  el('polygon', { points: `${C.x - 2.4},${C.y + 18} ${C.x + 2.4},${C.y + 18} ${C.x + 0.9},${C.y - 220} ${C.x - 0.9},${C.y - 220}`, fill: 'var(--needle)' }, needle);
  el('polygon', { points: `${C.x - 0.9},${C.y - 220} ${C.x + 0.9},${C.y - 220} ${C.x + 0.55},${C.y - R - 4} ${C.x - 0.55},${C.y - R - 4}`, fill: 'var(--needle-tip)' }, needle);

  // Bandeau inférieur (cache le pivot)
  el('rect', { x: 0, y: BEZEL_Y, width: W, height: H - BEZEL_Y, fill: 'var(--bezel)' }, svg);
  el('rect', { x: 0, y: BEZEL_Y, width: W, height: 1.5, fill: 'rgba(255,255,255,0.08)' }, svg);
  const bz = el('g', { fill: 'var(--bezel-ink)', 'font-family': 'system-ui, -apple-system, sans-serif', 'font-size': 12, 'letter-spacing': '1.5' }, svg);
  const b1 = el('text', { x: C.x, y: 338, 'text-anchor': 'middle', 'font-weight': 600 }, bz);
  b1.textContent = 'FLY MILLAU · 12 — 15 OCT. 2026';

  function paintBand() {
    band.replaceChildren();
    const bad = hexToRgb(css('--critical') || '#d03b3b');
    const good = hexToRgb(css('--good') || '#0ca30c');
    const mid = hexToRgb(css('--dial-soft').startsWith('#') ? css('--dial-soft') : '#b3a888');
    const n = 48;
    for (let i = 0; i < n; i++) {
      const a0 = -SWEEP + (2 * SWEEP * i) / n;
      const a1 = -SWEEP + (2 * SWEEP * (i + 1)) / n + 0.25;
      const f = (i + 0.5) / n;
      const c = f < 0.5 ? mix(bad, mid, f / 0.5) : mix(mid, good, (f - 0.5) / 0.5);
      el('path', { d: arcPath(a0, a1, R - 14, R - 4), fill: `rgb(${c.join(',')})` }, band);
    }
  }
  paintBand();

  let angle = angleOf(-180);
  let velocity = 0;
  let target = angle;
  let raf = null;
  let fallback = null;
  const render = () => needle.setAttribute('transform', `rotate(${angle} ${C.x} ${C.y})`);
  render();

  function step(last) {
    return (ts) => {
      const dt = Math.min(0.033, (ts - last) / 1000 || 0.016);
      const k = 55;
      const c = 8.5;
      velocity += (-k * (angle - target) - c * velocity) * dt;
      angle += velocity * dt;
      render();
      if (Math.abs(angle - target) < 0.02 && Math.abs(velocity) < 0.05) {
        angle = target;
        render();
        raf = null;
        return;
      }
      raf = requestAnimationFrame(step(ts));
    };
  }

  return {
    /** Place l'aiguille ; animée sauf si l'onglet est caché ou si le mouvement réduit est demandé. */
    set(score, { animate = true, from = null } = {}) {
      target = angleOf(score);
      if (from != null) angle = angleOf(from);
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(fallback);
      if (!animate || reduced || document.visibilityState === 'hidden') {
        angle = target;
        velocity = 0;
        render();
        return;
      }
      raf = requestAnimationFrame(step(performance.now()));
      // Si l'animation ne tourne pas (onglet en arrière-plan), l'aiguille finit quand même à sa place.
      fallback = setTimeout(() => {
        if (raf) cancelAnimationFrame(raf);
        raf = null;
        angle = target;
        velocity = 0;
        render();
      }, 4000);
    },
    /** Traînée : anciennes positions, de la plus ancienne à la plus récente. */
    setTrail(scores) {
      trail.replaceChildren();
      const n = scores.length;
      scores.forEach((s, i) => {
        const a = angleOf(s);
        const p0 = polar(a, 120);
        const p1 = polar(a, R - 18);
        el('line', { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, stroke: 'var(--needle)', 'stroke-width': 1.2, 'stroke-linecap': 'round', opacity: (0.06 + (0.3 * (i + 1)) / n).toFixed(3) }, trail);
      });
    },
    setClimatology(score) {
      clim.replaceChildren();
      if (score == null) return;
      const a = angleOf(score);
      const tip = polar(a, R - 16);
      const l = polar(a - 2.4, R - 30);
      const r = polar(a + 2.4, R - 30);
      el('polygon', { points: `${tip.x},${tip.y} ${l.x},${l.y} ${r.x},${r.y}`, fill: 'var(--dial-soft)' }, clim);
      const t = polar(a, R - 44);
      const txt = el('text', { x: t.x, y: t.y + 4, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--dial-soft)', 'font-family': 'system-ui, sans-serif', 'letter-spacing': '0.8' }, clim);
      txt.textContent = 'NORMALE';
    },
    setLabel(text) {
      svg.setAttribute('aria-label', text);
    },
    repaint: paintBand,
  };
}
