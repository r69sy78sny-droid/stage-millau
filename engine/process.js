// Transforme les réponses Open-Meteo (ensembles et modèles déterministes) en résultats par membre et
// par jour : marge de vol de la matinée, probabilité calibrée, agrégats et régime. Fonctions pures.

import { STAGE, VARS, ENGINE_VERSION, REGIMES } from './config.js';
import {
  stationEquivalent, hourMargin, morningMargin, pFly, vectorMean, quantiles, mean, dewPoint,
  apparentTemperature, windChill, lclHeight, classifyRegime, fogRisk, round, sector8,
} from './flyability.js';

export const REGIME_CODES = Object.keys(REGIMES);
export const LIM_CODES = ['pluie', 'vent', 'rafales', 'direction', 'nuages', 'orage', 'ventMeteo'];

const pad = (n) => String(n).padStart(2, '0');
const nextDate = (date) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Index horaire : (date, heure 0-24) → position dans le tableau `time` d'Open-Meteo (heure locale). */
export function makeIndex(times) {
  const map = new Map(times.map((t, i) => [t, i]));
  return (date, h) => (h >= 24 ? map.get(`${nextDate(date)}T${pad(h - 24)}:00`) : map.get(`${date}T${pad(h)}:00`));
}

const allNull = (arr) => !arr || arr.every((x) => x == null);

/** Sépare les membres d'une réponse de l'API Ensemble. Membre 0 = contrôle (clé sans suffixe). */
export function parseMembers(hourly, keys) {
  const first = VARS[keys.find((k) => hourly[VARS[k]])] ?? VARS[keys[0]];
  const ids = Object.keys(hourly)
    .filter((k) => k === first || k.startsWith(`${first}_member`))
    .map((k) => (k === first ? 0 : Number(k.slice(first.length + 7))))
    .sort((a, b) => a - b);
  const missing = keys.filter((k) => allNull(hourly[VARS[k]]));
  const members = ids.map((id) => {
    const o = {};
    for (const k of keys) {
      if (missing.includes(k)) {
        o[k] = null;
        continue;
      }
      const name = VARS[k];
      o[k] = hourly[id === 0 ? name : `${name}_member${pad(id)}`] ?? null;
    }
    return o;
  });
  return { times: hourly.time, members, missing };
}

/** Sépare les modèles d'une réponse multi-modèles de l'API Forecast (suffixe `_<modèle>`). */
export function parseDeterministic(hourly, modelIds, varNames) {
  const out = {};
  for (const model of modelIds) {
    const o = {};
    for (const v of varNames) {
      const arr = hourly[`${v}_${model}`] ?? (modelIds.length === 1 ? hourly[v] : undefined);
      o[v] = allNull(arr) ? null : arr;
    }
    out[model] = o;
  }
  return out;
}

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const sum = (a) => {
  const v = a.filter((x) => x != null);
  return v.length ? v.reduce((s, x) => s + x, 0) : null;
};
const max = (a) => {
  const v = a.filter((x) => x != null);
  return v.length ? Math.max(...v) : null;
};
const min = (a) => {
  const v = a.filter((x) => x != null);
  return v.length ? Math.min(...v) : null;
};

/**
 * Évalue une journée pour une trajectoire (membre d'ensemble ou modèle déterministe).
 * `get(k, h)` renvoie la valeur brute de la variable k (clé courte de VARS) à l'heure locale h (0-24).
 */
export function evaluateDay(get, { bias, calib, flatten = 1, elevation, aigoual = null }) {
  const S = [];
  for (let h = 0; h <= 24; h++) {
    S[h] = stationEquivalent(
      {
        t: get('t', h), rh: get('rh', h), rr: get('rr', h), sh: get('sh', h), cc: get('cc', h), ccl: get('ccl', h),
        wc: get('wc', h), vis: get('vis', h), ws: get('ws', h), wd: get('wd', h), wg: get('wg', h), cape: get('cape', h),
        p: get('p', h), t850: get('t850', h), ws850: get('ws850', h), wd850: get('wd850', h), z500: get('z500', h),
      },
      bias,
    );
  }
  const pick = (k, hs) => hs.map((h) => S[h]?.[k] ?? null);
  const hours = STAGE.morningSlots.map((h) => (S[h].ws == null || S[h].rr == null ? null : hourMargin(S[h])));
  const cover = hours.every((h) => h && h.m != null);
  const mm = cover ? morningMargin(hours, STAGE.minConsecutiveSlots) : null;
  const P = mm ? pFly(mm.M, calib, flatten) : null;

  const period = (hs) => {
    const vm = vectorMean(pick('wd', hs), pick('ws', hs));
    return { ws: mean(pick('ws', hs)), wg: max(pick('wg', hs)), wd: vm.dir, R: vm.R, rr: sum(pick('rr', hs)) };
  };
  const rrDay = sum(pick('rr', range(1, 24)));
  const shDay = sum(pick('sh', range(1, 24)));
  const day = vectorMean(pick('wd', range(6, 18)), pick('ws', range(6, 18)));
  const d850 = vectorMean(pick('wd850', range(6, 18)), pick('ws850', range(6, 18)));
  const t10 = S[10].t;
  const rh10 = S[10].rh;
  const td10 = dewPoint(t10, rh10);
  const agg = {
    tMax: max(pick('t', range(10, 18))),
    tMin: min(pick('t', range(3, 9))),
    rrDay,
    rrMorning: sum(pick('rr', STAGE.morningSlots)),
    shShare: rrDay != null && shDay != null && rrDay >= 0.5 ? shDay / rrDay : null,
    morning: period(range(9, 13)),
    afternoon: period(range(14, 18)),
    evening: period(range(19, 21)),
    windDay: mean(pick('ws', range(6, 18))),
    dirDay: day.dir,
    mslp: mean(pick('p', range(6, 18))),
    z500: mean(pick('z500', range(6, 18))),
    t850: mean(pick('t850', range(6, 18))),
    ws850: mean(pick('ws850', range(6, 18))),
    wd850: d850.dir,
    capeMax: max(pick('cape', range(10, 18))),
    ccMorning: mean(pick('cc', range(9, 13))),
    cclMorning: mean(pick('ccl', range(9, 13))),
    rhMorning: mean(pick('rh', range(7, 9))),
    wsEarly: mean(pick('ws', range(6, 9))),
    ccNight: mean(pick('cc', range(2, 6))),
    t10,
    t15: S[15].t,
    base10: td10 == null ? null : elevation + lclHeight(t10, td10),
    at10: apparentTemperature(t10, rh10, S[10].ws),
    at15: apparentTemperature(S[15].t, S[15].rh, S[15].ws),
    chill10: windChill(t10, 35),
    aigoual,
  };
  agg.fog = fogRisk(agg);
  agg.regime = classifyRegime({
    windDay: agg.windDay, dirDay: agg.dirDay, precipDay: rrDay, mslp: agg.mslp, capeMax: agg.capeMax,
    showersShare: agg.shShare, aigoual,
  });
  return { cover, P, M: mm?.M ?? null, lim: mm?.lim ?? null, start: mm?.start ?? null, hours, S, agg };
}

const HOURLY_RANGE = range(6, 21);
const HOURLY_KEYS = ['t', 'at', 'rr', 'ws', 'wg', 'cc', 'ccl', 'rh', 'cape', 'ws850'];

const q3 = (vals, d = 1) => quantiles(vals).map((x) => round(x, d));
const frac = (vals, test) => {
  const v = vals.filter((x) => x != null);
  return v.length ? round(v.filter(test).length / v.length, 3) : null;
};

/**
 * Résume un ensemble : évalue chaque membre chaque jour, puis agrège (quantiles, fractions, régimes).
 * `parsed` = parseMembers(), `aig` = parseMembers() du point Aigoual (précipitations) ou null.
 */
export function summarizeEnsemble(sys, parsed, aig, { calib, elevation, run }) {
  const idx = makeIndex(parsed.times);
  const aigIdx = aig ? makeIndex(aig.times) : null;
  const n = parsed.members.length;
  const evals = parsed.members.map((mem, mi) =>
    STAGE.dates.map((date) => {
      const get = (k, h) => {
        const arr = mem[k];
        if (!arr) return null;
        const i = idx(date, h);
        return i == null ? null : arr[i] ?? null;
      };
      let aigoual = null;
      if (aig?.members[mi]?.rr) {
        const a = aig.members[mi].rr;
        aigoual = sum(range(1, 24).map((h) => {
          const i = aigIdx(date, h);
          return i == null ? null : a[i];
        }));
      }
      return evaluateDay(get, { bias: sys.bias, calib, elevation, aigoual });
    }),
  );
  const days = STAGE.dates.map((date, d) => summarizeDay(evals.map((e) => e[d]), date));
  const hourly = STAGE.dates.map((date, d) => summarizeHourly(evals.map((e) => e[d])));
  return {
    id: sys.id, kind: 'ens', label: sys.label, short: sys.short, provider: sys.provider, res: sys.res, horizon: sys.horizon,
    model: sys.model, engine: ENGINE_VERSION, run, nMembers: n, missing: parsed.missing,
    cover: days.map((x) => x.cover),
    // Par membre et par jour : [P, régime, pression, vent diurne, direction, pluie du jour] (regroupement en trajectoires).
    memberDays: evals.map((e) => e.map((x) => [
      x.P == null ? null : round(x.P, 3), REGIME_CODES.indexOf(x.agg.regime), round(x.agg.mslp, 1),
      round(x.agg.windDay, 1), round(x.agg.dirDay, 0), round(x.agg.rrDay, 1),
    ])),
    days,
    hourly: { hours: HOURLY_RANGE, days: hourly },
  };
}

/** Agrégats d'une journée sur un ensemble de trajectoires évaluées. */
export function summarizeDay(evs, date) {
  const ok = evs.filter((e) => e.cover && e.P != null);
  const cover = ok.length >= Math.max(1, Math.ceil(evs.length * 0.8));
  const pMean = mean(ok.map((e) => e.P));
  const A = (f) => evs.map((e) => f(e.agg));
  // Causes de non-vol : part des trajectoires dont la matinée est non volable, par critère limitant.
  const lim = {};
  for (const e of ok) if (e.M < 0) lim[e.lim] = (lim[e.lim] ?? 0) + 1 / ok.length;
  // Rose des vents de la matinée (vent moyen 9 h-13 h ≥ 8 km/h), part de calme.
  const rose = { calme: 0 };
  for (const e of evs) {
    const m = e.agg.morning;
    if (m.ws == null) continue;
    const k = m.ws < 8 || m.wd == null ? 'calme' : sector8(m.wd);
    rose[k] = (rose[k] ?? 0) + 1 / evs.length;
  }
  const reg = {};
  for (const e of evs) reg[e.agg.regime] = (reg[e.agg.regime] ?? 0) + 1 / evs.length;
  const regFly = {};
  for (const r of Object.keys(reg)) regFly[r] = round(mean(ok.filter((e) => e.agg.regime === r).map((e) => e.P)), 3);
  const per = (name) => ({
    ws: q3(A((a) => a[name].ws)),
    wg: q3(A((a) => a[name].wg)),
    wd: round(vectorMean(A((a) => a[name].wd), A((a) => a[name].ws)).dir, 0),
    R: round(vectorMean(A((a) => a[name].wd), A((a) => a[name].ws)).R, 2),
    rr: q3(A((a) => a[name].rr)),
  });
  return {
    date,
    cover,
    n: evs.length,
    p: cover ? round(pMean, 4) : null,
    pBin: cover ? frac(ok.map((e) => e.M), (m) => m >= 0) : null,
    spread: cover ? round(Math.sqrt(mean(ok.map((e) => (e.P - pMean) ** 2))), 3) : null,
    lim: Object.fromEntries(Object.entries(lim).map(([k, v]) => [k, round(v, 3)])),
    rose: Object.fromEntries(Object.entries(rose).map(([k, v]) => [k, round(v, 3)])),
    reg: Object.fromEntries(Object.entries(reg).map(([k, v]) => [k, round(v, 3)])),
    regFly,
    tMax: q3(A((a) => a.tMax)),
    tMin: q3(A((a) => a.tMin)),
    t10: q3(A((a) => a.t10)),
    at10: q3(A((a) => a.at10)),
    at15: q3(A((a) => a.at15)),
    chill10: q3(A((a) => a.chill10)),
    base10: q3(A((a) => a.base10), 0),
    rrDay: q3(A((a) => a.rrDay)),
    rrMorning: q3(A((a) => a.rrMorning)),
    pRainMorning: frac(A((a) => a.rrMorning), (x) => x >= 0.2),
    pRain1: frac(A((a) => a.rrDay), (x) => x >= 1),
    pRain10: frac(A((a) => a.rrDay), (x) => x >= 10),
    shShare: round(mean(A((a) => a.shShare)), 2),
    capeMax: q3(A((a) => a.capeMax), 0),
    ccMorning: q3(A((a) => a.ccMorning), 0),
    cclMorning: q3(A((a) => a.cclMorning), 0),
    fog: round(mean(A((a) => a.fog)), 3),
    mslp: q3(A((a) => a.mslp)),
    z500: q3(A((a) => a.z500), 0),
    t850: q3(A((a) => a.t850)),
    ws850: q3(A((a) => a.ws850)),
    wd850: round(vectorMean(A((a) => a.wd850), A((a) => a.ws850)).dir, 0),
    aigoual: q3(A((a) => a.aigoual)),
    pAig50: frac(A((a) => a.aigoual), (x) => x >= 50),
    pSE20: frac(evs.map((e) => (e.agg.dirDay != null && e.agg.dirDay >= 100 && e.agg.dirDay < 200 ? e.agg.windDay : 0)), (x) => x >= 20),
    pN20: frac(evs.map((e) => (e.agg.dirDay != null && (e.agg.dirDay >= 290 || e.agg.dirDay < 30) ? e.agg.windDay : 0)), (x) => x >= 20),
    morning: per('morning'),
    afternoon: per('afternoon'),
    evening: per('evening'),
  };
}

function summarizeHourly(evs) {
  const out = {};
  for (const k of HOURLY_KEYS) {
    out[k] = HOURLY_RANGE.map((h) =>
      q3(evs.map((e) => {
        const s = e.S[h];
        if (k === 'at') return apparentTemperature(s.t, s.rh, s.ws);
        return s[k];
      }), k === 'cape' ? 0 : 1),
    );
  }
  out.pRain = HOURLY_RANGE.map((h) => frac(evs.map((e) => e.S[h].rr), (x) => x >= 0.2));
  out.wd = HOURLY_RANGE.map((h) => {
    const vm = vectorMean(evs.map((e) => e.S[h].wd), evs.map((e) => e.S[h].ws));
    return [round(vm.dir, 0), round(vm.R, 2)];
  });
  out.pFly = HOURLY_RANGE.map((h) => frac(evs.map((e) => {
    const s = e.S[h];
    return s.ws == null || s.rr == null ? null : hourMargin(s).m;
  }), (m) => m >= 0));
  return out;
}

const DET_SHORT = {
  t: 'temperature_2m', rh: 'relative_humidity_2m', rr: 'precipitation', sh: 'showers', cc: 'cloud_cover', ccl: 'cloud_cover_low',
  wc: 'weather_code', vis: 'visibility', ws: 'wind_speed_10m', wd: 'wind_direction_10m', wg: 'wind_gusts_10m', cape: 'cape',
  p: 'pressure_msl', t850: 'temperature_850hPa', ws850: 'wind_speed_850hPa', wd850: 'wind_direction_850hPa',
  z500: 'geopotential_height_500hPa',
};

/**
 * Résume un modèle déterministe. `deco` et `valley` = séries par nom de variable Open-Meteo,
 * `times` = axe horaire commun. La probabilité est aplatie avec l'échéance (pas de dispersion).
 */
export function summarizeDeterministic(sys, deco, valley, times, { calib, elevation, run, valleyElevation }) {
  const idx = makeIndex(times);
  const init = run?.init ? Date.parse(run.init) : null;
  const raw = (series, name, date, h) => {
    const arr = series?.[name];
    if (!arr) return null;
    const i = idx(date, h);
    return i == null ? null : arr[i] ?? null;
  };
  const days = STAGE.dates.map((date) => {
    const target = Date.parse(`${date}T09:00:00Z`); // 11 h locale
    const lead = init ? Math.max(0, (target - init) / 86400000) : 3;
    const flatten = 1 + lead / 3;
    const get = (k, h) => raw(deco, DET_SHORT[k], date, h);
    const e = evaluateDay(get, { bias: sys.bias, calib, flatten, elevation });
    const r = (name, h) => raw(deco, name, date, h);
    // Profil vertical à 9 h : gradient déco → 850 hPa, inversion, sommet de la couche humide.
    const t9 = r('temperature_2m', 9);
    const t850 = r('temperature_850hPa', 9);
    const z850 = r('geopotential_height_850hPa', 9);
    const lapse = t9 != null && t850 != null && z850 != null ? ((t850 - t9) / (z850 - elevation)) * 100 : null;
    const levels = [
      ['925', r('relative_humidity_925hPa', 9), r('geopotential_height_925hPa', 9)],
      ['850', r('relative_humidity_850hPa', 9), z850],
      ['700', r('relative_humidity_700hPa', 9), r('geopotential_height_700hPa', 9)],
    ].filter(([, rh, z]) => rh != null && z != null && z > elevation - 150);
    let moistTop = null;
    for (const [, rh, z] of levels) {
      if (rh >= 90) moistTop = z;
      else if (moistTop != null) break;
    }
    // Vallée (atterrissage) : brouillard au lever du jour, écart de température avec le déco.
    const v = (name, h) => raw(valley, name, date, h);
    const fogHours = [7, 8, 9, 10].filter((h) => {
      const vis = v('visibility', h);
      const rh = v('relative_humidity_2m', h);
      const ws = v('wind_speed_10m', h);
      const wc = v('weather_code', h);
      return (vis != null && vis < 1000) || wc === 45 || wc === 48 || (rh != null && rh >= 97 && (ws ?? 0) < 6);
    });
    const tv7 = v('temperature_2m', 7);
    const tv15 = v('temperature_2m', 15);
    const td7 = r('temperature_2m', 7);
    const td15 = r('temperature_2m', 15);
    const dz = elevation - valleyElevation;
    return {
      date,
      cover: e.cover,
      lead: round(lead, 1),
      P: e.P == null ? null : round(e.P, 3),
      M: round(e.M, 2),
      lim: e.M != null && e.M < 0 ? e.lim : null,
      start: e.start,
      regime: e.agg.regime,
      tMax: round(e.agg.tMax, 1),
      tMin: round(e.agg.tMin, 1),
      at10: round(e.agg.at10, 1),
      chill10: round(e.agg.chill10, 1),
      rrDay: round(e.agg.rrDay, 1),
      rrMorning: round(e.agg.rrMorning, 1),
      shShare: round(e.agg.shShare, 2),
      capeMax: round(e.agg.capeMax, 0),
      ccMorning: round(e.agg.ccMorning, 0),
      cclMorning: round(e.agg.cclMorning, 0),
      base10: round(e.agg.base10, 0),
      moistTop: round(moistTop, 0),
      blh14: round(r('boundary_layer_height', 14), 0),
      mslp: round(e.agg.mslp, 1),
      z500: round(e.agg.z500, 0),
      t850: round(e.agg.t850, 1),
      ws850: round(e.agg.ws850, 0),
      wd850: round(e.agg.wd850, 0),
      lapse9: round(lapse, 2),
      valleyFogHours: valley ? fogHours.length : null,
      gradient7: tv7 != null && td7 != null ? round(((td7 - tv7) / dz) * 100, 2) : null,
      gradient15: tv15 != null && td15 != null ? round(((td15 - tv15) / dz) * 100, 2) : null,
      tValley7: round(tv7, 1),
      tValley15: round(tv15, 1),
      morning: roundPeriod(e.agg.morning),
      afternoon: roundPeriod(e.agg.afternoon),
      evening: roundPeriod(e.agg.evening),
      fog: round(e.agg.fog, 2),
      hourly: HOURLY_RANGE.map((h) => {
        const s = e.S[h];
        return [round(s.t, 1), round(s.rr, 1), round(s.cc, 0), round(s.ccl, 0), round(s.ws, 0), round(s.wg, 0), round(s.wd, 0), s.vis == null ? null : round(s.vis / 1000, 1), round(s.cape, 0)];
      }),
    };
  });
  return {
    id: sys.id, kind: 'det', label: sys.label, provider: sys.provider, res: sys.res, horizon: sys.horizon, model: sys.model,
    engine: ENGINE_VERSION, run, nMembers: 1, cover: days.map((d) => d.cover),
    memberDays: [days.map((d) => [d.P, REGIME_CODES.indexOf(d.regime), d.mslp, null, null, d.rrDay])],
    days,
  };
}

const roundPeriod = (p) => ({ ws: round(p.ws, 0), wg: round(p.wg, 0), wd: round(p.wd, 0), rr: round(p.rr, 1) });
