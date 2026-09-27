// Fonctions pures : « marge de vol » d'une heure et d'une matinée, calibration en probabilité,
// grandeurs dérivées (ressenti, point de rosée, base des nuages) et régime météo d'une journée.
// Utilisées à l'identique par le script de mise à jour (Node) et par la page (navigateur).

import { LIMITS, BIAS } from './config.js';

/** Rafale estimée quand un modèle n'en fournit pas (régression sur les matinées d'octobre à la station). */
export const GUST_FROM_WIND = { a: 4.8, b: 1.56 };

export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const angDist = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
export const sigmoid = (x) => 1 / (1 + Math.exp(-x));
export const round = (x, d = 0) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Ramène le vent d'un modèle à l'échelle de la station ; estime la rafale si elle manque. */
export function stationEquivalent(s, biasKey = 'coarse') {
  const f = BIAS[biasKey] ?? BIAS.coarse;
  const ws = s.ws == null ? null : s.ws * f.wind;
  let wg = s.wg == null ? null : s.wg * f.gust;
  const gustEstimated = wg == null && ws != null;
  if (gustEstimated) wg = GUST_FROM_WIND.a + GUST_FROM_WIND.b * ws;
  if (wg != null && ws != null && wg < ws) wg = ws;
  return { ...s, ws, wg, gustEstimated };
}

/**
 * Marge de vol d'une heure : 0 = à la limite, > 0 = volable (1 = confortable), < 0 = non volable.
 * `s` contient des valeurs déjà ramenées à l'échelle de la station (km/h, mm, %, m).
 * Renvoie la marge la plus défavorable et le critère qui la fixe.
 */
export function hourMargin(s, lim = LIMITS) {
  const parts = {};
  if (s.rr != null) parts.pluie = (lim.rain - s.rr) / 0.4;
  if (s.ws != null) parts.vent = (lim.wind - s.ws) / 8;
  if (s.wg != null) parts.rafales = (lim.gust - s.wg) / 12;
  if (s.wd != null && s.ws != null) {
    const inForbidden = s.ws >= lim.calm && angDist(s.wd, lim.forbidden.center) < lim.forbidden.halfWidth;
    parts.direction = inForbidden ? -Math.min(1.5, 0.25 + (s.ws - lim.calm) / 6) : 1;
  }
  // Déco dans le nuage ou le brouillard : visibilité si on l'a, sinon humidité + nuages bas.
  let fog = null;
  if (s.vis != null) fog = clamp((3000 - s.vis) / 2000);
  if (s.rh != null && (s.ccl != null || s.cc != null)) {
    const cover = s.ccl != null ? clamp((s.ccl - 70) / 30) : clamp((s.cc - 85) / 15);
    const f2 = clamp((s.rh - 92) / 6) * cover;
    fog = fog == null ? f2 : Math.max(fog, f2);
  } else if (s.ccl != null) {
    // Modèles IA sans humidité : seule une couche basse totale fait douter (plafond inconnu).
    const f3 = 0.5 * clamp((s.ccl - 90) / 10);
    fog = fog == null ? f3 : Math.max(fog, f3);
  }
  if (fog != null) parts.nuages = 0.5 - 1.5 * fog;
  if (s.wc != null && s.wc >= 95) parts.orage = -2;
  else if (s.cape != null && s.cape >= lim.cape && (s.rr ?? 0) > 0.1) parts.orage = -1;
  if (s.ws850 != null) parts.ventMeteo = (lim.wind850 - s.ws850) / 12;

  let m = Infinity;
  let limiting = null;
  for (const [k, v] of Object.entries(parts)) {
    if (v < m) {
      m = v;
      limiting = k;
    }
  }
  if (m === Infinity) return { m: null, lim: null };
  return { m: clamp(m, -2, 1), lim: limiting };
}

/**
 * Marge d'une matinée : meilleure fenêtre de `need` créneaux consécutifs, chaque fenêtre valant son
 * créneau le plus défavorable. Renvoie null si aucune fenêtre complète n'est disponible.
 */
export function morningMargin(hours, need = 2) {
  let best = null;
  for (let i = 0; i + need <= hours.length; i++) {
    const win = hours.slice(i, i + need);
    if (win.some((h) => h == null || h.m == null)) continue;
    let worst = win[0];
    for (const h of win) if (h.m < worst.m) worst = h;
    if (!best || worst.m > best.M) best = { M: worst.m, lim: worst.lim, start: i };
  }
  return best;
}

/**
 * Probabilité que la matinée soit réellement volable (calibrée sur la station de Millau).
 * `flatten` > 1 élargit l'incertitude d'une prévision déterministe lointaine.
 */
export function pFly(M, calib, flatten = 1) {
  if (M == null) return null;
  return sigmoid(calib.alpha + (calib.beta * M) / flatten);
}

/** Direction moyenne vectorielle (d'où vient le vent) et constance R (0 = dispersé, 1 = constant). */
export function vectorMean(dirs, speeds) {
  let u = 0;
  let v = 0;
  let w = 0;
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    if (d == null) continue;
    const s = speeds ? speeds[i] ?? 1 : 1;
    const r = (d * Math.PI) / 180;
    u += s * Math.sin(r);
    v += s * Math.cos(r);
    w += s;
  }
  if (w === 0) return { dir: null, R: null };
  const dir = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
  return { dir, R: Math.sqrt(u * u + v * v) / w };
}

export const SECTORS8 = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
export const sector8 = (d) => (d == null ? null : SECTORS8[Math.floor(((d + 22.5) % 360) / 45)]);

/** Quantiles (interpolation linéaire) d'un tableau, valeurs nulles ignorées. */
export function quantiles(values, ps = [0.1, 0.5, 0.9]) {
  const a = values.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return ps.map(() => null);
  return ps.map((p) => {
    const i = p * (a.length - 1);
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return a[lo] + (a[hi] - a[lo]) * (i - lo);
  });
}

export const mean = (values) => {
  const a = values.filter((x) => x != null && !Number.isNaN(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
};

/** Point de rosée (Magnus). */
export function dewPoint(t, rh) {
  if (t == null || rh == null || rh <= 0) return null;
  const g = Math.log(rh / 100) + (17.62 * t) / (243.12 + t);
  return (243.12 * g) / (17.62 - g);
}

/** Température ressentie (formule de Steadman utilisée par Open-Meteo), vent en km/h. */
export function apparentTemperature(t, rh, wsKmh) {
  if (t == null || rh == null || wsKmh == null) return null;
  const e = (rh / 100) * 6.105 * Math.exp((17.27 * t) / (237.7 + t));
  return t + 0.33 * e - 0.7 * (wsKmh / 3.6) - 4.0;
}

/** Refroidissement éolien (JAG/TI) sous voile, vitesse air en km/h ; indicatif au-delà de 10 °C. */
export function windChill(t, vKmh = 35) {
  if (t == null) return null;
  const p = vKmh ** 0.16;
  return 13.12 + 0.6215 * t - 11.37 * p + 0.3965 * t * p;
}

/** Hauteur de la base des cumulus / du point de condensation au-dessus du sol (m). */
export const lclHeight = (t, td) => (t == null || td == null ? null : Math.max(0, 125 * (t - td)));

const inSector = (d, from, to) => (from <= to ? d >= from && d < to : d >= from || d < to);

/**
 * Régime météo d'une journée pour un membre, à partir d'agrégats 6 h-18 h (vent à l'échelle station).
 * a = { windDay, dirDay, precipDay, mslp, capeMax, showersShare, aigoual }
 */
export function classifyRegime(a) {
  const dir = a.dirDay;
  const ws = a.windDay ?? 0;
  const rr = a.precipDay ?? 0;
  const se = dir != null && inSector(dir, 100, 200);
  const convective = (a.capeMax ?? 0) >= 300 || (a.showersShare ?? 0) >= 0.6;
  if (se && (rr >= 10 || (a.aigoual ?? 0) >= 40)) return 'cevenol';
  if (rr >= 5) return convective ? 'instable' : 'perturbe';
  if (ws >= 15 && dir != null) {
    if (se) return 'sud';
    if (inSector(dir, 290, 30)) return 'nord';
    if (inSector(dir, 200, 290)) return 'ouest';
    return 'est';
  }
  if (rr >= 1 && convective) return 'instable';
  if ((a.mslp ?? 1015) >= 1018) return 'anticyclone';
  return 'marais';
}

/** Risque de brouillard de vallée au lever du jour (0-1) : nuit claire, air humide, vent faible. */
export function fogRisk({ rhMorning, wsEarly, ccNight }) {
  if (rhMorning == null || wsEarly == null) return null;
  const clear = ccNight == null ? 0.5 : clamp((70 - ccNight) / 50);
  return clamp((rhMorning - 75) / 20) * clamp((12 - wsEarly) / 8) * clear;
}
