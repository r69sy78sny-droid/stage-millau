// Combinaison des systèmes de prévision et de la climatologie : probabilité par matinée, puis
// probabilité que les 3 séances volent (au moins 3 matinées volables sur 4), et position de l'aiguille.

import { LEAD, STAGE, ENSEMBLES, DETERMINISTIC } from './config.js';
import { REGIME_CODES } from './process.js';
import { round } from './flyability.js';

const DAY_MS = 86400000;

/** Poids de la prévision face à la climatologie selon l'échéance en jours. */
export const leadWeight = (L, p = LEAD) => (L == null ? 0 : 1 / (1 + Math.exp((L - p.l50) / p.scale)));

/** Aiguille : probabilité 0 → −180 (impossible), 0,5 → 0, 1 → +180 (le stage aura lieu). */
export const scoreFromP = (p) => Math.round(360 * p - 180);

/** Générateur pseudo-aléatoire déterministe : mêmes données → même aiguille. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Loi du nombre de succès pour des épreuves indépendantes de probabilités `ps` (Poisson-binomiale). */
export function poissonBinomial(ps) {
  let dist = [1];
  for (const p of ps) {
    const next = new Array(dist.length + 1).fill(0);
    for (let k = 0; k < dist.length; k++) {
      next[k] += dist[k] * (1 - p);
      next[k + 1] += dist[k] * p;
    }
    dist = next;
  }
  return dist;
}

const atLeast = (dist, k) => dist.slice(k).reduce((s, x) => s + x, 0);

const CONFIG_BY_ID = Object.fromEntries([...ENSEMBLES, ...DETERMINISTIC].map((s) => [s.id, s]));

/** Poids d'un système pour un jour donné (0 si le jour n'est pas couvert). */
export function systemWeight(sys, d, all) {
  if (!sys.cover?.[d]) return 0;
  const cfg = CONFIG_BY_ID[sys.id] ?? {};
  let w = cfg.weight ?? 1;
  if (cfg.coveredBy) {
    const ref = all.find((s) => s.id === cfg.coveredBy);
    if (ref?.cover?.[d]) w = cfg.weightWhenCovered ?? w;
  }
  // Variables manquantes : rafales estimées, pas d'humidité → un peu moins de poids.
  const missing = sys.missing ?? [];
  if (missing.includes('wg')) w *= 0.85;
  if (missing.includes('rh')) w *= 0.9;
  return w;
}

/**
 * Combine systèmes et climatologie.
 * systems : résumés (summarizeEnsemble / summarizeDeterministic) ; clim : { pMorning, windows: [[0/1 ×4]] }.
 * now : horodatage (ms). Renvoie les probabilités par jour, la loi du nombre de matinées volables,
 * la probabilité que les séances volent, l'aiguille et les scénarios les plus probables.
 */
export function combine(systems, clim, { now = Date.now(), sessions = STAGE.sessionsNeeded, samples = 40000, observed = {} } = {}) {
  const nd = STAGE.dates.length;
  const W = systems.map((s) => STAGE.dates.map((_, d) => systemWeight(s, d, systems)));
  const days = STAGE.dates.map((date, d) => {
    const target = Date.parse(`${date}T09:00:00Z`); // 11 h, heure de Paris
    const past = now > Date.parse(`${date}T11:00:00Z`); // matinée terminée (13 h locale)
    let wSum = 0;
    let pSum = 0;
    let freshest = null;
    const contrib = [];
    systems.forEach((s, i) => {
      const w = W[i][d];
      const p = s.days?.[d]?.p ?? s.days?.[d]?.P ?? null;
      if (!w || p == null) return;
      wSum += w;
      pSum += w * p;
      contrib.push({ id: s.id, p: round(p, 3), w: round(w, 2) });
      const init = s.run?.init ? Date.parse(s.run.init) : null;
      if (init && w >= 1 && (freshest == null || init > freshest)) freshest = init;
    });
    const pModel = wSum ? pSum / wSum : null;
    const lead = freshest ? Math.max(0, (target - freshest) / DAY_MS) : null;
    const obs = observed[date];
    const a = obs != null ? 1 : pModel == null ? 0 : leadWeight(lead);
    let p = pModel == null ? clim.pMorning : a * pModel + (1 - a) * clim.pMorning;
    if (obs != null) p = obs ? 1 : 0; // matinée déjà passée, signalée dans l'issue d'alertes
    const spreadInter = contrib.length > 1
      ? Math.sqrt(contrib.reduce((s, c) => s + c.w * (c.p - pModel) ** 2, 0) / wSum)
      : null;
    return { date, past, observed: obs ?? null, lead: round(lead, 2), a: round(a, 3), pModel: round(pModel, 4), pClim: round(clim.pMorning, 4), p: round(p, 4), spreadInter: round(spreadInter, 3), contrib };
  });

  // Tirage de trajectoires : on choisit un système (au prorata de son poids moyen), un membre,
  // et une fenêtre climatologique de 4 matinées observées à Millau. Un seul tirage u par trajectoire
  // décide jour par jour si l'on suit le modèle (u < a(L)) : comme a décroît avec l'échéance, un modèle
  // jugé utile au jour 4 l'est aussi aux jours précédents, et la persistance du temps est conservée.
  const sysW = W.map((row) => row.reduce((s, x) => s + x, 0) / nd);
  const totW = sysW.reduce((s, x) => s + x, 0);
  const seed = hashString(JSON.stringify([days.map((x) => x.p), sysW, systems.map((s) => s.run?.init)]));
  const rng = mulberry32(seed);
  const counts = new Array(nd + 1).fill(0);
  const patterns = new Map();
  const cum = [];
  let acc = 0;
  for (const w of sysW) {
    acc += w;
    cum.push(acc);
  }
  const pbar = days.map((x) => x.pModel ?? clim.pMorning);
  for (let k = 0; k < samples; k++) {
    const u = rng();
    let sys = null;
    let mem = null;
    if (totW > 0) {
      const r = rng() * totW;
      let i = cum.findIndex((c) => r < c);
      if (i < 0) i = systems.length - 1;
      sys = systems[i];
      mem = sys.memberDays[Math.floor(rng() * sys.memberDays.length)];
    }
    const win = clim.windows[Math.floor(rng() * clim.windows.length)];
    let n = 0;
    let code = '';
    for (let d = 0; d < nd; d++) {
      let ok;
      if (days[d].observed != null) {
        ok = days[d].observed;
      } else if (sys && u < days[d].a) {
        const P = sys.cover[d] ? mem?.[d]?.[0] ?? pbar[d] : pbar[d];
        ok = rng() < P;
      } else {
        ok = win[d] === 1;
      }
      n += ok ? 1 : 0;
      code += ok ? '1' : '0';
    }
    counts[n]++;
    patterns.set(code, (patterns.get(code) ?? 0) + 1);
  }
  const dist = counts.map((c) => c / samples);
  const p = atLeast(dist, sessions);
  const topPatterns = [...patterns.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 8)
    .map(([code, c]) => ({ code, p: round(c / samples, 4) }));

  // Chaque système seul, sans climatologie (seulement s'il couvre les 4 matinées).
  const perSystem = systems.map((s, i) => {
    const full = s.cover.every(Boolean);
    let pStage = null;
    if (full) {
      const vals = s.memberDays.map((md) => atLeast(poissonBinomial(md.map((x) => x[0] ?? 0)), sessions));
      pStage = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    return { id: s.id, weight: round(sysW[i], 2), pStage: round(pStage, 4), pDays: s.days.map((x) => round(x.p ?? x.P ?? null, 3)) };
  });

  return {
    days,
    dist: dist.map((x) => round(x, 4)),
    expected: round(dist.reduce((s, x, k) => s + k * x, 0), 2),
    p: round(p, 4),
    score: scoreFromP(p),
    patterns: topPatterns,
    perSystem,
    samples,
  };
}

/** Répartition des régimes par jour, pondérée par système, et probabilité de vol de chaque régime. */
export function blendRegimes(systems) {
  return STAGE.dates.map((_, d) => {
    const acc = {};
    const fly = {};
    let tot = 0;
    systems.forEach((s) => {
      const w = systemWeight(s, d, systems);
      if (!w) return;
      tot += w;
      const reg = s.kind === 'det' ? { [s.days[d].regime]: 1 } : s.days[d].reg ?? {};
      const rf = s.kind === 'det' ? { [s.days[d].regime]: s.days[d].P } : s.days[d].regFly ?? {};
      for (const [r, f] of Object.entries(reg)) {
        acc[r] = (acc[r] ?? 0) + w * f;
        if (rf[r] != null) {
          fly[r] = fly[r] ?? { s: 0, w: 0 };
          fly[r].s += w * f * rf[r];
          fly[r].w += w * f;
        }
      }
    });
    return Object.entries(acc)
      .map(([id, v]) => ({ id, p: round(v / tot, 3), pFly: fly[id]?.w ? round(fly[id].s / fly[id].w, 3) : null }))
      .sort((a, b) => b.p - a.p);
  });
}

/**
 * Trajectoires : regroupement (k-moyennes pondérées) des membres des ensembles qui couvrent les 4 jours,
 * sur la pression, le vent (composantes u, v) et la pluie de chaque journée, variables centrées-réduites.
 * Chaque groupe reçoit le poids de ses membres (poids du système réparti sur ses membres).
 */
export function clusters(systems, { sessions = STAGE.sessionsNeeded, k = 4, seed = 12345 } = {}) {
  const pts = [];
  systems.forEach((s) => {
    if (s.kind !== 'ens' || !s.cover.every(Boolean)) return;
    const w = STAGE.dates.reduce((acc, _, d) => acc + systemWeight(s, d, systems), 0) / STAGE.dates.length;
    for (const md of s.memberDays) {
      if (md.some((x) => x[0] == null || x[2] == null || x[3] == null)) continue;
      const f = [];
      for (const [, , p, ws, wd, rr] of md) {
        const r = ((wd ?? 0) * Math.PI) / 180;
        f.push(p, -ws * Math.sin(r), -ws * Math.cos(r), Math.log1p(rr ?? 0) * 4);
      }
      pts.push({ f, w: w / s.memberDays.length, md, sys: s.id });
    }
  });
  if (pts.length < k * 3) return [];
  const dim = pts[0].f.length;
  const tw = pts.reduce((a, p) => a + p.w, 0);
  const mu = Array.from({ length: dim }, (_, j) => pts.reduce((a, p) => a + p.w * p.f[j], 0) / tw);
  const sd = Array.from({ length: dim }, (_, j) => Math.sqrt(pts.reduce((a, p) => a + p.w * (p.f[j] - mu[j]) ** 2, 0) / tw) || 1);
  for (const p of pts) p.z = p.f.map((x, j) => (x - mu[j]) / sd[j]);
  const dist2 = (a, b) => a.reduce((acc, x, j) => acc + (x - b[j]) ** 2, 0);
  // Initialisation k-means++ déterministe.
  const rng = mulberry32(seed);
  const cent = [pts[Math.floor(rng() * pts.length)].z.slice()];
  while (cent.length < k) {
    const d2 = pts.map((p) => p.w * Math.min(...cent.map((c) => dist2(p.z, c))));
    let r = rng() * d2.reduce((a, x) => a + x, 0);
    let i = 0;
    while (i < pts.length - 1 && (r -= d2[i]) > 0) i++;
    cent.push(pts[i].z.slice());
  }
  let assign = new Array(pts.length).fill(0);
  for (let it = 0; it < 60; it++) {
    const next = pts.map((p) => {
      let best = 0;
      let bd = Infinity;
      cent.forEach((c, ci) => {
        const d = dist2(p.z, c);
        if (d < bd) {
          bd = d;
          best = ci;
        }
      });
      return best;
    });
    const same = next.every((x, i) => x === assign[i]);
    assign = next;
    for (let ci = 0; ci < k; ci++) {
      const mem = pts.filter((_, i) => assign[i] === ci);
      const w = mem.reduce((a, p) => a + p.w, 0);
      if (w > 0) cent[ci] = Array.from({ length: dim }, (_, j) => mem.reduce((a, p) => a + p.w * p.z[j], 0) / w);
    }
    if (same && it > 0) break;
  }
  const out = [];
  for (let ci = 0; ci < k; ci++) {
    const mem = pts.filter((_, i) => assign[i] === ci);
    const w = mem.reduce((a, p) => a + p.w, 0);
    if (!w) continue;
    const days = STAGE.dates.map((_, d) => {
      const reg = {};
      let p = 0;
      let mslp = 0;
      let rr = 0;
      let u = 0;
      let v = 0;
      let ws = 0;
      for (const m of mem) {
        const [P, rc, pr, wsd, wd, rrd] = m.md[d];
        const code = REGIME_CODES[rc] ?? '?';
        reg[code] = (reg[code] ?? 0) + m.w;
        p += m.w * P;
        mslp += m.w * pr;
        rr += m.w * (rrd ?? 0);
        ws += m.w * wsd;
        const r = ((wd ?? 0) * Math.PI) / 180;
        u += m.w * wsd * Math.sin(r);
        v += m.w * wsd * Math.cos(r);
      }
      const regs = Object.entries(reg).sort((a, b) => b[1] - a[1]).map(([id, x]) => ({ id, p: round(x / w, 2) }));
      return {
        regime: regs[0].id,
        regimes: regs.slice(0, 3),
        p: round(p / w, 3),
        mslp: round(mslp / w, 1),
        rr: round(rr / w, 1),
        ws: round(ws / w, 0),
        wd: round(((Math.atan2(u, v) * 180) / Math.PI + 360) % 360, 0),
      };
    });
    const pStage = mem.reduce((a, m) => a + m.w * atLeast(poissonBinomial(m.md.map((x) => x[0])), sessions), 0) / w;
    const bySys = {};
    for (const m of mem) bySys[m.sys] = round((bySys[m.sys] ?? 0) + m.w / w, 3);
    out.push({ p: round(w / tw, 4), pStage: round(pStage, 3), days, systems: bySys, n: mem.length });
  }
  return out.sort((a, b) => b.p - a.p);
}

/** Moyenne pondérée de quantiles (« vincentisation ») : combine les distributions de plusieurs systèmes. */
export function blendQuantiles(items) {
  const valid = items.filter((it) => it.q && it.q.every((x) => x != null) && it.w > 0);
  if (!valid.length) return null;
  const tw = valid.reduce((s, it) => s + it.w, 0);
  return valid[0].q.map((_, j) => round(valid.reduce((s, it) => s + it.w * it.q[j], 0) / tw, 1));
}

export function blendValue(items) {
  const valid = items.filter((it) => it.v != null && it.w > 0);
  if (!valid.length) return null;
  const tw = valid.reduce((s, it) => s + it.w, 0);
  return valid.reduce((s, it) => s + it.w * it.v, 0) / tw;
}
