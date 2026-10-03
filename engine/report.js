// Assemble data/latest.json : l'aiguille, les probabilités par matinée, les statistiques combinées
// de tous les systèmes, les écarts entre centres, les scénarios et l'analyse rédigée.

import { STAGE, SITES, LIMITS, ENSEMBLES, DETERMINISTIC, EXPERTS, REGIMES, POINTS, ALERT } from './config.js';
import { summarizeParaglidable, firstAvailable } from './paraglidable.js';
import { combine, blendRegimes, clusters, blendQuantiles, blendValue, systemWeight } from './combine.js';
import { round, vectorMean, sector8 } from './flyability.js';

const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
export const dayLabel = (date) => {
  const d = new Date(`${date}T12:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} octobre`;
};

export function verdict(score) {
  if (score >= 120) return { key: 'go', label: 'Le stage devrait avoir lieu' };
  if (score >= 45) return { key: 'bon', label: 'Plutôt favorable' };
  if (score > -45) return { key: 'incertain', label: 'Incertain' };
  if (score > -120) return { key: 'mauvais', label: 'Plutôt défavorable' };
  return { key: 'non', label: 'Très compromis' };
}

const CFG = Object.fromEntries([...ENSEMBLES, ...DETERMINISTIC, ...EXPERTS].map((s) => [s.id, s]));
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)} %`);
const fr = (x, d = 0) => (x == null ? '—' : x.toFixed(d).replace('.', ','));
const signed = (x, d = 0) => (x == null ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${fr(Math.abs(x), d)}`);
const dirName = (d) => (d == null ? '—' : sector8(d));

/** Moment où un système commencera à couvrir la première puis toutes les matinées du stage. */
function entry(cfg, meta) {
  const H = cfg.horizonHours;
  if (!H) return null;
  const delay = meta ? (Date.parse(meta.available) - Date.parse(meta.init)) / 3600000 : 6;
  const at = (date) => new Date(Date.parse(`${date}T11:00:00Z`) - H * 3600000 + delay * 3600000).toISOString();
  return { first: at(STAGE.dates[0]), all: at(STAGE.dates.at(-1)) };
}

function nextUpdate(meta) {
  if (!meta?.interval) return null;
  return new Date(Date.parse(meta.available) + meta.interval * 1000).toISOString();
}

/** Moyenne pondérée des systèmes météo seuls (sans les avis IA), pour comparer les deux approches. */
function meteoOnly(contrib) {
  const list = contrib.filter((c) => CFG[c.id] && !EXPERTS.some((e) => e.id === c.id));
  const w = list.reduce((a, c) => a + c.w, 0);
  return w ? round(list.reduce((a, c) => a + c.w * c.p, 0) / w, 4) : null;
}

export function buildReport({ ens, det, clim, now = Date.now(), metas = {}, refreshed = [], observed = {}, paraglidable = null }) {
  const pgSys = summarizeParaglidable(paraglidable, clim.mornings.pMorning);
  const ia = pgSys ? [pgSys] : [];
  const systems = [...ens, ...det, ...ia];
  const comb = combine(systems, { pMorning: clim.mornings.pMorning, windows: clim.mornings.windows }, { now, observed });
  const regimes = blendRegimes(systems);
  const scen = clusters(systems);
  const perSys = Object.fromEntries(comb.perSystem.map((x) => [x.id, x]));

  const days = STAGE.dates.map((date, d) => {
    const cd = comb.days[d];
    const items = ens.map((s) => ({ s, w: systemWeight(s, d, systems) })).filter((x) => x.w > 0 && x.s.days[d].cover);
    const bq = (key) => blendQuantiles(items.map(({ s, w }) => ({ q: s.days[d][key], w })));
    const bv = (key, dd = 3) => round(blendValue(items.map(({ s, w }) => ({ v: s.days[d][key], w }))), dd);
    const bdir = (get) => {
      const vm = vectorMean(items.map(({ s }) => get(s.days[d])), items.map(({ w }) => w));
      return round(vm.dir, 0);
    };
    const period = (name) => ({
      ws: blendQuantiles(items.map(({ s, w }) => ({ q: s.days[d][name].ws, w }))),
      wg: blendQuantiles(items.map(({ s, w }) => ({ q: s.days[d][name].wg, w }))),
      wd: bdir((x) => x[name].wd),
      R: round(blendValue(items.map(({ s, w }) => ({ v: s.days[d][name].R, w }))), 2),
      rr: blendQuantiles(items.map(({ s, w }) => ({ q: s.days[d][name].rr, w }))),
    });
    // Critère limitant : part pondérée des trajectoires où chaque critère fixe la marge de la matinée.
    const limiting = {};
    let limW = 0;
    for (const s of systems) {
      const w = systemWeight(s, d, systems);
      if (!w || s.kind === 'ia') continue;
      const lim = s.kind === 'det' ? (s.days[d].lim ? { [s.days[d].lim]: 1 } : {}) : s.days[d].lim ?? {};
      limW += w;
      for (const [k, v] of Object.entries(lim)) limiting[k] = (limiting[k] ?? 0) + w * v;
    }
    for (const k of Object.keys(limiting)) limiting[k] = round(limiting[k] / limW, 3);
    const rose = {};
    const roseW = items.reduce((a, { w }) => a + w, 0);
    for (const { s, w } of items) for (const [k, v] of Object.entries(s.days[d].rose ?? {})) rose[k] = (rose[k] ?? 0) + (w * v) / roseW;
    for (const k of Object.keys(rose)) rose[k] = round(rose[k], 3);

    // Heure par heure : quantiles combinés des ensembles.
    const hourly = { hours: ens[0]?.hourly?.hours ?? [] };
    const hitems = items.filter(({ s }) => s.hourly?.days?.[d]);
    for (const key of ['t', 'at', 'rr', 'ws', 'wg', 'cc', 'ccl', 'rh', 'cape', 'ws850']) {
      hourly[key] = hourly.hours.map((_, j) => blendQuantiles(hitems.map(({ s, w }) => ({ q: s.hourly.days[d][key]?.[j], w }))));
    }
    for (const key of ['pRain', 'pFly']) {
      hourly[key] = hourly.hours.map((_, j) => round(blendValue(hitems.map(({ s, w }) => ({ v: s.hourly.days[d][key]?.[j], w }))), 3));
    }
    hourly.wd = hourly.hours.map((_, j) => {
      const vm = vectorMean(hitems.map(({ s }) => s.hourly.days[d].wd?.[j]?.[0]), hitems.map(({ s, w }) => w * (s.hourly.days[d].wd?.[j]?.[1] ?? 1)));
      return round(vm.dir, 0);
    });

    const stats = {
      tMax: bq('tMax'), tMin: bq('tMin'), t10: bq('t10'), at10: bq('at10'), at15: bq('at15'), chill10: bq('chill10'),
      base10: bq('base10'), rrDay: bq('rrDay'), rrMorning: bq('rrMorning'), pRainMorning: bv('pRainMorning'),
      pRain1: bv('pRain1'), pRain10: bv('pRain10'), shShare: bv('shShare', 2), capeMax: bq('capeMax'),
      ccMorning: bq('ccMorning'), cclMorning: bq('cclMorning'), fog: bv('fog'), mslp: bq('mslp'), z500: bq('z500'),
      t850: bq('t850'), ws850: bq('ws850'), wd850: bdir((x) => x.wd850), aigoual: bq('aigoual'), pAig50: bv('pAig50'),
      pSE20: bv('pSE20'), pN20: bv('pN20'),
      morning: period('morning'), afternoon: period('afternoon'), evening: period('evening'),
    };
    const n = clim.normals.window;
    // Normales de la station (712 m) ramenées à l'altitude du déco avec le gradient standard.
    const dT = -0.0065 * (POINTS.deco.elevation - clim.station.alt);
    const anom = {
      normTx: round(n.tx.mean + dT, 1),
      normTn: round(n.tn.mean + dT, 1),
      tMax: stats.tMax ? round(stats.tMax[1] - (n.tx.mean + dT), 1) : null,
      tMin: stats.tMin ? round(stats.tMin[1] - (n.tn.mean + dT), 1) : null,
      mslp: stats.mslp ? round(stats.mslp[1] - clim.era5.mslp.mean, 1) : null,
      z500: stats.z500 ? round(stats.z500[1] - clim.upper.z500.mean, 0) : null,
      t850: stats.t850 ? round(stats.t850[1] - clim.upper.t850.mean, 1) : null,
    };
    anom.mslpSigma = anom.mslp == null ? null : round(anom.mslp / clim.era5.mslp.sd, 2);
    anom.z500Sigma = anom.z500 == null ? null : round(anom.z500 / clim.upper.z500.sd, 2);

    const detRows = det
      .filter((s) => s.days[d].tMax != null || s.days[d].cover)
      .map((s) => ({ id: s.id, label: s.label, provider: s.provider, res: s.res, run: s.run?.init ?? null, ...s.days[d], hourly: undefined }));
    // Fond de vallée : déterministes fins s'ils sont disponibles, sinon écart climatologique St-Affrique/Millau.
    const fine = detRows.find((r) => ['arome_hd', 'arome', 'icon_d2'].includes(r.id) && r.tValley15 != null);
    const valley = {
      tMax: stats.tMax ? round(stats.tMax[1] + clim.valley.dTx, 1) : null,
      tMin: stats.tMin ? round(stats.tMin[1] + clim.valley.dTn, 1) : null,
      source: fine ? fine.label : 'écart climatologique vallée/plateau',
      gradient15: fine?.gradient15 ?? round((-clim.valley.dTx / (712 - 368)) * 100, 2),
      fogHours: fine?.valleyFogHours ?? null,
    };

    let confidence = 'faible';
    if (cd.a >= 0.7 && (cd.spreadInter ?? 0) <= 0.12) confidence = 'bonne';
    else if (cd.a >= 0.3) confidence = 'moyenne';

    return {
      ...cd,
      label: dayLabel(date),
      contrib: cd.contrib.map((c) => ({ ...c, label: CFG[c.id]?.short ?? CFG[c.id]?.label ?? c.id })),
      regimes: regimes[d],
      limiting,
      rose,
      stats,
      hourly,
      anom,
      valley,
      det: detRows,
      confidence,
      cevenol: { pRegime: regimes[d].find((r) => r.id === 'cevenol')?.p ?? 0, pAig50: stats.pAig50, pSE20: stats.pSE20 },
      paraglidable: {
        pMeteo: meteoOnly(cd.contrib),
        fly: pgSys?.days[d].fly ?? null,
        XC: pgSys?.days[d].XC ?? null,
        p: pgSys?.days[d].p ?? null,
        from: firstAvailable(date),
        history: (paraglidable?.history ?? []).filter((e) => e.v?.[date] != null).map((e) => [e.t, e.v[date]]),
      },
    };
  });

  const sysList = systems.map((s) => {
    const cfg = CFG[s.id];
    const meta = (Array.isArray(cfg.meta) ? cfg.meta : [cfg.meta]).map((m) => metas[m]).filter(Boolean)
      .sort((a, b) => Date.parse(b.init) - Date.parse(a.init))[0];
    return {
      id: s.id, kind: s.kind, label: s.label, short: cfg.short ?? s.label, provider: s.provider, res: s.res,
      horizon: s.horizon, members: s.nMembers, run: s.run, cover: s.cover, missing: s.missing ?? [],
      pDays: perSys[s.id]?.pDays ?? s.cover.map(() => null), pStage: perSys[s.id]?.pStage ?? null,
      weight: perSys[s.id]?.weight ?? 0, nextUpdate: nextUpdate(meta), entry: entry(cfg, meta),
      refreshed: refreshed.includes(s.id),
    };
  });

  const report = {
    generatedAt: new Date(now).toISOString(),
    stage: { ...STAGE, sites: SITES, limits: LIMITS, points: POINTS, alertThreshold: ALERT.threshold },
    score: comb.score,
    p: comb.p,
    verdict: verdict(comb.score),
    dist: comb.dist,
    expected: comb.expected,
    patterns: comb.patterns,
    samples: comb.samples,
    days,
    systems: sysList,
    scenarios: scen,
    paraglidable: paraglidable
      ? { fetchedAt: paraglidable.fetchedAt, changedAt: paraglidable.changedAt, spot: paraglidable.spot, series: paraglidable.days, active: !!pgSys }
      : null,
    climatology: {
      pMorning: clim.mornings.pMorning,
      pAtLeast: clim.mornings.pAtLeast,
      dist4: clim.mornings.dist4,
      period: clim.mornings.period,
      window: clim.mornings.window,
      limiting: clim.mornings.limiting,
      pFlyAfterFly: clim.mornings.pFlyAfterFly,
      pFlyAfterNoFly: clim.mornings.pFlyAfterNoFly,
      strip: clim.strip,
      windRose: clim.windRose,
      normals: clim.normals,
      occurrences: clim.occurrences,
      valley: clim.valley,
      era5: clim.era5,
      upper: clim.upper,
      aigoual: clim.aigoual,
      calibration: clim.calibration,
      gustFromWind: clim.gustFromWind,
      windScale: clim.windScale,
      scoreClim: Math.round(360 * clim.mornings.pAtLeast[STAGE.sessionsNeeded - 1] - 180),
    },
  };
  report.analysis = writeAnalysis(report);
  return report;
}

// ---------------------------------------------------------------------------- analyse rédigée

function topRegimes(day, k = 3) {
  return day.regimes.slice(0, k).filter((r) => r.p >= 0.05).map((r) => `${REGIMES[r.id]?.label.toLowerCase() ?? r.id} ${pct(r.p)}`);
}

export function writeAnalysis(r) {
  const out = { summary: [], synoptic: [], wind: [], rain: [], clouds: [], temps: [], spread: [], ia: [], next: [] };
  const c = r.climatology;
  const aMean = r.days.reduce((s, d) => s + d.a, 0) / r.days.length;
  const leadMin = Math.min(...r.days.map((d) => d.lead ?? 99));
  const active = r.systems.filter((s) => s.cover.some(Boolean));

  // Synthèse
  const need = r.stage.sessionsNeeded;
  out.summary.push(
    `Probabilité que tes ${need} matinées de vol tiennent entre le 12 et le 15 octobre : ${pct(r.p)} ` +
    `(aiguille ${signed(r.score)}). En moyenne ${fr(r.expected, 1)} matinée(s) volable(s) sur 4 attendue(s). ` +
    `Référence climatologique à Millau (${c.period}, ${c.window}) : ${pct(c.pAtLeast[need - 1])}, soit ${signed(c.scoreClim)} sur l'aiguille.`,
  );
  if (aMean < 0.25) {
    out.summary.push(
      `À cette échéance (${leadMin < 99 ? `${fr(leadMin, 0)} jours et plus` : 'hors de portée des modèles'}), les prévisions ne pèsent encore que ` +
      `${pct(aMean)} en moyenne face à la climatologie : l'aiguille bougera surtout quand ECMWF ENS, GEFS et les autres ensembles ` +
      `couvriront toute la période. ${active.length} système(s) atteignent déjà au moins une matinée.`,
    );
  } else if (aMean < 0.7) {
    out.summary.push(`Échéance moyenne : les prévisions pèsent ${pct(aMean)} face à la climatologie ; la tendance devient exploitable mais reste révisable.`);
  } else {
    out.summary.push(`Courte échéance : les prévisions pèsent ${pct(aMean)} ; l'aiguille reflète désormais surtout les modèles.`);
  }
  const best = [...r.days].sort((a, b) => b.p - a.p)[0];
  const worst = [...r.days].sort((a, b) => a.p - b.p)[0];
  out.summary.push(`Matinée la plus favorable : ${best.label} (${pct(best.p)}). La plus fragile : ${worst.label} (${pct(worst.p)}).`);

  // Situation synoptique
  for (const d of r.days) {
    const s = d.stats;
    if (!s.mslp) {
      out.synoptic.push(`${cap(d.label)} : aucun ensemble ne couvre encore cette matinée — climatologie seule.`);
      continue;
    }
    const regs = topRegimes(d);
    let txt = `${cap(d.label)} : pression réduite au niveau de la mer ${fr(s.mslp[1], 0)} hPa (P10-P90 ${fr(s.mslp[0], 0)}-${fr(s.mslp[2], 0)}), ` +
      `anomalie ${signed(d.anom.mslp, 1)} hPa (${signed(d.anom.mslpSigma, 1)} σ vs ERA5 ${c.era5.period})`;
    if (s.z500) txt += ` ; géopotentiel 500 hPa ${fr(s.z500[1], 0)} m (${signed(d.anom.z500)} m vs réf. GFS 2021-2025)`;
    if (s.t850) txt += ` ; T 850 hPa ${fr(s.t850[1], 1)} °C (${signed(d.anom.t850, 1)} °C)`;
    txt += '.';
    if (regs.length) txt += ` Régimes : ${regs.join(', ')}.`;
    out.synoptic.push(txt);
  }

  // Vent
  for (const d of r.days) {
    const m = d.stats.morning;
    if (!m?.ws) continue;
    const sectors = Object.entries(d.rose ?? {}).filter(([k]) => k !== 'calme').sort((a, b) => b[1] - a[1]);
    const dirTxt = m.R != null && m.R < 0.5
      ? `pas de secteur dominant (calme ${pct(d.rose?.calme)}, puis ${sectors.slice(0, 3).map(([k, v]) => `${k} ${pct(v)}`).join(', ')})`
      : `secteur ${dirName(m.wd)} (calme ${pct(d.rose?.calme)})`;
    let txt = `${cap(d.label)}, matinée : vent ${fr(m.ws[1], 0)} km/h (P10-P90 ${fr(m.ws[0], 0)}-${fr(m.ws[2], 0)}), rafales ${fr(m.wg[1], 0)} km/h ` +
      `(P90 ${fr(m.wg[2], 0)}), ${dirTxt}.`;
    const east = (d.rose?.NE ?? 0) + (d.rose?.E ?? 0);
    if (east >= 0.15) txt += ` Vent d'est à nord-est dans ${pct(east)} des trajectoires : aucun décollage de l'école n'y est orienté.`;
    if (d.stats.pSE20 >= 0.15) txt += ` Flux de sud-est soutenu (≥ 20 km/h en moyenne diurne) : ${pct(d.stats.pSE20)} — vent du Midi / marin, effet de foehn possible sous le vent des Cévennes, décollages Novis ou Pic d'Andan.`;
    if (d.stats.pN20 >= 0.15) txt += ` Flux de nord à nord-ouest soutenu : ${pct(d.stats.pN20)} — Brunas ou Pouncho nord, turbulence sous le vent des causses.`;
    if (d.stats.ws850) txt += ` Vent à 850 hPa (~1 500 m) : ${fr(d.stats.ws850[1], 0)} km/h du ${dirName(d.stats.wd850)}.`;
    out.wind.push(txt);
  }

  // Précipitations
  for (const d of r.days) {
    const s = d.stats;
    if (!s.rrDay) continue;
    let txt = `${cap(d.label)} : pluie pendant la matinée ${pct(s.pRainMorning)} ; journée ≥ 1 mm ${pct(s.pRain1)}, ≥ 10 mm ${pct(s.pRain10)} ; ` +
      `cumul médian ${fr(s.rrDay[1], 1)} mm (P90 ${fr(s.rrDay[2], 1)} mm).`;
    if (s.shShare != null) txt += ` Part convective (averses) ${pct(s.shShare)}${s.capeMax ? `, CAPE max médiane ${fr(s.capeMax[1], 0)} J/kg` : ''}.`;
    if ((d.cevenol.pAig50 ?? 0) >= 0.05 || d.cevenol.pRegime >= 0.05) {
      txt += ` Signal cévenol : ${pct(d.cevenol.pAig50)} des trajectoires donnent ≥ 50 mm/24 h sur l'Aigoual (climatologie ERA5 d'octobre : ${pct(c.aigoual.p50)}).`;
    }
    out.rain.push(txt);
  }

  // Nuages, brouillard
  for (const d of r.days) {
    const s = d.stats;
    if (!s.ccMorning) continue;
    let txt = `${cap(d.label)} : nébulosité totale le matin ${fr(s.ccMorning[1], 0)} %`;
    if (s.cclMorning) txt += `, nuages bas ${fr(s.cclMorning[1], 0)} %`;
    if (s.base10) txt += ` ; base des nuages (condensation) vers ${fr(s.base10[1], 0)} m à 10 h`;
    txt += `. Risque de brouillard de vallée au lever du jour : ${pct(s.fog)} (brouillard noté ${pct(c.occurrences.fog)} des jours du ${c.occurrences.window} à la station, ${c.occurrences.period}).`;
    if (d.valley.fogHours != null) txt += ` ${d.valley.source} : ${d.valley.fogHours} h de brouillard probable à Millau-Plage entre 7 h et 11 h.`;
    out.clouds.push(txt);
  }

  // Températures
  const n = c.normals.window;
  for (const d of r.days) {
    const s = d.stats;
    if (!s.tMax) continue;
    out.temps.push(
      `${cap(d.label)} : déco (828 m) mini ${fr(s.tMin[1], 1)} °C / maxi ${fr(s.tMax[1], 1)} °C (normales de la station ramenées à 828 m : ${fr(d.anom.normTn, 1)} / ${fr(d.anom.normTx, 1)} °C ; ` +
      `anomalie ${signed(d.anom.tMin, 1)} / ${signed(d.anom.tMax, 1)} °C). Fond de vallée estimé ${fr(d.valley.tMin, 1)} / ${fr(d.valley.tMax, 1)} °C (${d.valley.source}). ` +
      `Ressenti à 10 h ${fr(s.at10?.[1], 1)} °C, sous voile à 35 km/h ${fr(s.chill10?.[1], 1)} °C.`,
    );
  }

  // Dispersion et écarts entre centres
  for (const d of r.days) {
    if (d.contrib.length < 2) continue;
    const sorted = [...d.contrib].sort((a, b) => b.p - a.p);
    out.spread.push(
      `${cap(d.label)} : ${d.contrib.length} systèmes, du plus optimiste (${sorted[0].label} ${pct(sorted[0].p)}) au plus pessimiste ` +
      `(${sorted.at(-1).label} ${pct(sorted.at(-1).p)}) ; écart-type pondéré ${pct(d.spreadInter)}.`,
    );
  }
  r.scenarios.forEach((sc, i) => {
    const seq = sc.days.map((x) => REGIMES[x.regime]?.label.toLowerCase() ?? x.regime);
    out.spread.push(
      `Trajectoire ${'ABCD'[i]} (${pct(sc.p)} du poids des ensembles couvrant les 4 jours) : ${seq.join(' → ')} ; ` +
      `${need} matinées volables dans ${pct(sc.pStage)} des cas (matinées : ${sc.days.map((x) => pct(x.p)).join(' / ')}).`,
    );
  });

  // Deuxième avis : Paraglidable (réseau de neurones entraîné sur les vols déclarés)
  if (r.paraglidable) {
    for (const d of r.days) {
      const g = d.paraglidable;
      if (g.fly == null) {
        if (!d.past) out.ia.push(`${cap(d.label)} : pas encore publié par Paraglidable (il prévoit 10 jours, donc à partir du ${frDay(g.from)}).`);
        continue;
      }
      let txt = `${cap(d.label)} : Paraglidable donne ${pct(g.fly)} de chances que des pilotes volent à Millau dans la journée` +
        `${g.XC != null ? ` (potentiel de cross ${pct(g.XC)})` : ''}, soit ${pct(g.p)} une fois ramené à une matinée d'élève.`;
      if (g.pMeteo != null) {
        const gap = g.p - g.pMeteo;
        txt += ` Les modèles météo seuls donnent ${pct(g.pMeteo)} : ` +
          (Math.abs(gap) < 0.1 ? 'les deux approches concordent.' : gap > 0 ? `Paraglidable est plus optimiste (${signed(gap * 100)} points).` : `Paraglidable est plus pessimiste (${signed(gap * 100)} points).`);
      }
      if (g.history.length > 1) {
        const first = g.history[0];
        txt += ` Son avis est passé de ${pct(first[1])} (${frDate(first[0])}) à ${pct(g.fly)} en ${g.history.length - 1} révision(s).`;
      }
      out.ia.push(txt);
    }
  }

  // Ce qui peut faire bouger l'aiguille
  const future = r.systems
    .filter((s) => s.entry && !s.cover.every(Boolean) && Date.parse(s.entry.first) > Date.parse(r.generatedAt))
    .sort((a, b) => Date.parse(a.entry.first) - Date.parse(b.entry.first))
    .slice(0, 6);
  for (const s of future) {
    out.next.push(`${s.label} (${s.res}) : commencera à couvrir le stage vers le ${frDate(s.entry.first)}, toute la période vers le ${frDate(s.entry.all)}.`);
  }
  return out;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const frDay = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const frDate = (iso) => {
  const d = new Date(iso);
  return d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
