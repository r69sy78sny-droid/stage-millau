import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hourMargin, morningMargin, pFly, vectorMean, classifyRegime, stationEquivalent, quantiles, GUST_FROM_WIND, sector8,
} from '../engine/flyability.js';
import { leadWeight, poissonBinomial, combine, scoreFromP, clusters, systemWeight } from '../engine/combine.js';
import { parseMembers, evaluateDay, summarizeEnsemble, REGIME_CODES } from '../engine/process.js';
import { buildReport, verdict } from '../engine/report.js';
import { STAGE, ENSEMBLES } from '../engine/config.js';
import { calibrateFly, parseApi, summarizeParaglidable, firstAvailable } from '../engine/paraglidable.js';
import { mergeParaglidable } from '../scripts/paraglidable.mjs';

const calm = { rr: 0, ws: 8, wg: 15, wd: 270, rh: 60, ccl: 10, wc: 1, cape: 0, ws850: 20 };
const calib = { alpha: 0.7, beta: 2.3 };

test('une heure calme et sèche est volable, avec une marge positive', () => {
  const h = hourMargin(calm);
  assert.ok(h.m > 0);
});

test('chaque critère peut rendre une heure non volable', () => {
  assert.equal(hourMargin({ ...calm, rr: 1.5 }).lim, 'pluie');
  assert.equal(hourMargin({ ...calm, ws: 32, wg: 34 }).lim, 'vent');
  assert.equal(hourMargin({ ...calm, wg: 52 }).lim, 'rafales');
  assert.equal(hourMargin({ ...calm, wc: 95 }).lim, 'orage');
  assert.equal(hourMargin({ ...calm, ws850: 70 }).lim, 'ventMeteo');
  assert.equal(hourMargin({ ...calm, rh: 99, ccl: 100 }).lim, 'nuages');
  assert.equal(hourMargin({ rr: 0, ws: 10, wg: 16, vis: 800 }).lim, 'nuages');
  for (const s of [{ ...calm, rr: 1.5 }, { ...calm, ws: 32, wg: 34 }, { ...calm, wg: 52 }, { ...calm, wc: 95 }]) {
    assert.ok(hourMargin(s).m < 0, JSON.stringify(s));
  }
});

test("le vent d'est n'est un problème que s'il souffle (aucun décollage orienté NE-E)", () => {
  assert.ok(hourMargin({ ...calm, ws: 15, wg: 22, wd: 70 }).m < 0);
  assert.equal(hourMargin({ ...calm, ws: 15, wg: 22, wd: 70 }).lim, 'direction');
  assert.ok(hourMargin({ ...calm, ws: 5, wg: 9, wd: 70 }).m > 0); // calme : direction indifférente
  assert.ok(hourMargin({ ...calm, ws: 15, wg: 22, wd: 140 }).m > 0); // sud-est : Novis / Pic d'Andan
  assert.ok(hourMargin({ ...calm, ws: 15, wg: 22, wd: 0 }).m > 0); // nord : Brunas / Pouncho
});

test('la matinée vaut sa meilleure fenêtre de 2 h consécutives', () => {
  const ok = { m: 0.5, lim: 'pluie' };
  const bad = { m: -1, lim: 'rafales' };
  assert.equal(morningMargin([bad, ok, ok, bad]).M, 0.5);
  assert.equal(morningMargin([ok, bad, ok, bad]).M, -1);
  assert.equal(morningMargin([ok, bad, ok, bad]).lim, 'rafales');
  assert.equal(morningMargin([null, null, ok, ok]).start, 2);
  assert.equal(morningMargin([null, ok, null, ok]), null);
});

test('la probabilité calibrée croît avec la marge et s’aplatit avec l’échéance', () => {
  assert.ok(pFly(0.5, calib) > pFly(0, calib));
  assert.ok(pFly(0, calib) > pFly(-1, calib));
  assert.ok(pFly(0.5, calib, 3) < pFly(0.5, calib));
  assert.equal(pFly(null, calib), null);
});

test('rafale estimée quand le modèle ne la fournit pas, et jamais inférieure au vent moyen', () => {
  const s = stationEquivalent({ ws: 10 }, 'fine');
  assert.ok(s.gustEstimated);
  assert.equal(s.wg, GUST_FROM_WIND.a + GUST_FROM_WIND.b * 10);
  assert.equal(stationEquivalent({ ws: 20, wg: 10 }, 'fine').wg, 20);
  assert.ok(stationEquivalent({ ws: 10, wg: 20 }, 'coarse').ws > 10); // modèle grossier : vent relevé
});

test('direction moyenne vectorielle, secteurs et quantiles', () => {
  assert.ok(Math.abs(vectorMean([350, 10]).dir - 0) < 1e-6 || Math.abs(vectorMean([350, 10]).dir - 360) < 1e-6);
  assert.ok(vectorMean([0, 180]).R < 1e-9);
  assert.equal(sector8(44), 'NE');
  assert.equal(sector8(350), 'N');
  assert.deepEqual(quantiles([1, 2, 3, 4, 5], [0, 0.5, 1]), [1, 3, 5]);
});

test('régimes météo', () => {
  assert.equal(classifyRegime({ windDay: 10, dirDay: 140, precipDay: 25, mslp: 1008 }), 'cevenol');
  assert.equal(classifyRegime({ windDay: 10, dirDay: 270, precipDay: 8, mslp: 1008 }), 'perturbe');
  assert.equal(classifyRegime({ windDay: 25, dirDay: 150, precipDay: 0, mslp: 1012 }), 'sud');
  assert.equal(classifyRegime({ windDay: 25, dirDay: 330, precipDay: 0, mslp: 1022 }), 'nord');
  assert.equal(classifyRegime({ windDay: 25, dirDay: 60, precipDay: 0, mslp: 1025 }), 'est');
  assert.equal(classifyRegime({ windDay: 6, dirDay: 60, precipDay: 0, mslp: 1025 }), 'anticyclone');
  assert.equal(classifyRegime({ windDay: 6, dirDay: 60, precipDay: 0, mslp: 1010 }), 'marais');
});

test('poids de l’échéance et loi de Poisson-binomiale', () => {
  assert.ok(leadWeight(1) > 0.9);
  assert.ok(Math.abs(leadWeight(10) - 0.5) < 1e-9);
  assert.ok(leadWeight(20) < 0.05);
  assert.equal(leadWeight(null), 0);
  const d = poissonBinomial([0.9, 0.9, 0.9, 0.9]);
  assert.ok(Math.abs(d.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(Math.abs(d[3] + d[4] - (0.9 ** 4 + 4 * 0.9 ** 3 * 0.1)) < 1e-12);
  assert.equal(scoreFromP(0), -180);
  assert.equal(scoreFromP(0.5), 0);
  assert.equal(scoreFromP(1), 180);
  assert.equal(verdict(150).key, 'go');
  assert.equal(verdict(-150).key, 'non');
});

// --------------------------------------------------------------------------- données synthétiques
const DATES = STAGE.dates;
function hourlyFor(members, value) {
  // value(memberIndex, dateIndex, hour) → { t, rh, rr, ... } ; construit un objet `hourly` façon Open-Meteo.
  const time = [];
  const days = ['2026-10-11', ...DATES, '2026-10-16'];
  for (const d of days) for (let h = 0; h < 24; h++) time.push(`${d}T${String(h).padStart(2, '0')}:00`);
  const hourly = { time };
  const names = { t: 'temperature_2m', rh: 'relative_humidity_2m', rr: 'precipitation', cc: 'cloud_cover', ws: 'wind_speed_10m', wd: 'wind_direction_10m', wg: 'wind_gusts_10m', p: 'pressure_msl' };
  for (let m = 0; m < members; m++) {
    for (const [k, name] of Object.entries(names)) {
      const key = m === 0 ? name : `${name}_member${String(m).padStart(2, '0')}`;
      hourly[key] = time.map((t) => {
        const di = DATES.indexOf(t.slice(0, 10));
        return value(m, di, +t.slice(11, 13))[k];
      });
    }
  }
  return hourly;
}
const good = () => ({ t: 12, rh: 60, rr: 0, cc: 20, ws: 6, wd: 300, wg: 12, p: 1022 });
const rainy = () => ({ t: 10, rh: 95, rr: 2, cc: 100, ws: 15, wd: 150, wg: 40, p: 1005 });

test('lecture des membres d’une réponse Ensemble', () => {
  const parsed = parseMembers(hourlyFor(3, good), ['t', 'rh', 'rr', 'cc', 'ws', 'wd', 'wg', 'p', 'ccl']);
  assert.equal(parsed.members.length, 3);
  assert.deepEqual(parsed.missing, ['ccl']);
  assert.equal(parsed.members[2].ws[10], 6);
});

function fakeSystem(id, value, members = 10) {
  const sys = ENSEMBLES.find((s) => s.id === id);
  const parsed = parseMembers(hourlyFor(members, value), ['t', 'rh', 'rr', 'cc', 'ws', 'wd', 'wg', 'p']);
  return summarizeEnsemble(sys, parsed, null, { calib, elevation: 828, run: { init: '2026-10-11T00:00:00Z' } });
}

test('un ensemble sec et calme donne des matinées volables, un ensemble pluvieux non', () => {
  const g = fakeSystem('ecmwf_ens', good);
  const r = fakeSystem('ecmwf_ens', rainy);
  assert.ok(g.cover.every(Boolean));
  assert.ok(g.days.every((d) => d.p > 0.8));
  assert.ok(r.days.every((d) => d.p < 0.1));
  assert.equal(r.days[0].reg.cevenol, 1); // sud-est + pluie
  assert.ok(r.days[0].lim.pluie > 0.9);
  assert.equal(g.memberDays[0][0][1], REGIME_CODES.indexOf('anticyclone'));
});

const clim = { pMorning: 0.6, windows: [[1, 1, 1, 0], [0, 0, 1, 1], [1, 1, 1, 1], [0, 1, 0, 0]] };

test('sans prévision, la combinaison rend la climatologie', () => {
  const out = combine([], clim, { now: Date.parse('2026-09-27T00:00:00Z'), samples: 20000 });
  assert.ok(Math.abs(out.p - 0.5) < 0.02); // 2 fenêtres sur 4 ont au moins 3 matinées
  assert.ok(out.days.every((d) => d.a === 0 && d.p === 0.6));
});

test('à courte échéance, la combinaison suit les modèles ; résultat reproductible', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  const sysGood = fakeSystem('ecmwf_ens', good);
  const sysBad = fakeSystem('ecmwf_ens', rainy);
  const g = combine([sysGood], clim, { now });
  const b = combine([sysBad], clim, { now });
  assert.ok(g.p > 0.75, `p=${g.p}`);
  assert.ok(b.p < 0.1, `p=${b.p}`);
  assert.ok(g.score > b.score);
  assert.deepEqual(combine([sysGood], clim, { now }), g);
});

test('un système qui ne couvre pas un jour ne pèse pas ce jour-là', () => {
  const sys = fakeSystem('ecmwf_ens', good);
  sys.cover = [true, false, false, false];
  assert.equal(systemWeight(sys, 1, [sys]), 0);
  assert.ok(systemWeight(sys, 0, [sys]) > 0);
});

test('trajectoires : deux familles bien séparées sont retrouvées', () => {
  const mixed = fakeSystem('gefs', (m, d, h) => (m < 6 ? good() : rainy()), 12);
  const groups = clusters([mixed], { k: 2 });
  assert.equal(groups.length, 2);
  const pStages = groups.map((g) => g.pStage).sort();
  assert.ok(pStages[0] < 0.1 && pStages[1] > 0.8, JSON.stringify(pStages));
  assert.ok(Math.abs(groups[0].p + groups[1].p - 1) < 1e-6);
});

test('le rapport complet se construit et reste borné', () => {
  const climFull = {
    mornings: { pMorning: 0.6, windows: clim.windows, pAtLeast: [0.9, 0.75, 0.47, 0.2], dist4: [0.1, 0.15, 0.28, 0.27, 0.2], period: '1993-2025', window: '8-19 oct.', limiting: {}, pFlyAfterFly: 0.7, pFlyAfterNoFly: 0.43 },
    station: { alt: 712 }, strip: [], windRose: { calm: 0.4, sectors: [] },
    normals: { window: { tx: { mean: 16 }, tn: { mean: 9 } } },
    occurrences: { fog: 0.17, window: '8-19 oct.', period: '1991-2025' },
    valley: { dTx: 2.6, dTn: 0.8 }, era5: { mslp: { mean: 1017.6, sd: 6.2 }, period: '1993-2025' },
    upper: { z500: { mean: 5751, sd: 90 }, t850: { mean: 9.9, sd: 3.8 } }, aigoual: { p50: 0.02 },
    calibration: calib, gustFromWind: GUST_FROM_WIND, windScale: {},
  };
  const r = buildReport({ ens: [fakeSystem('ecmwf_ens', good), fakeSystem('gefs', rainy)], det: [], clim: climFull, now: Date.parse('2026-10-10T00:00:00Z') });
  assert.ok(r.score >= -180 && r.score <= 180);
  assert.equal(r.days.length, 4);
  assert.ok(r.analysis.summary.length >= 2);
  assert.ok(r.days[0].stats.tMax.length === 3);
  assert.equal(r.days[0].anom.normTx, 15.2); // normale de la station (16 °C à 712 m) ramenée à 828 m
  assert.equal(r.paraglidable, null);

  // Avec Paraglidable sur le premier jour : il entre dans le mélange sans diluer régimes ni critères limitants.
  const pg = { fetchedAt: '2026-10-10T00:00:00Z', changedAt: '2026-10-10T00:00:00Z', spot: { name: 'Millau' }, days: { '2026-10-12': { fly: 0.95, XC: 0.1 } }, history: [{ t: '2026-10-10T00:00:00Z', v: { '2026-10-12': 0.95 } }] };
  const r2 = buildReport({ ens: [fakeSystem('ecmwf_ens', good), fakeSystem('gefs', rainy)], det: [], clim: climFull, now: Date.parse('2026-10-10T00:00:00Z'), paraglidable: pg });
  assert.ok(r2.days[0].contrib.some((c) => c.id === 'paraglidable'));
  assert.ok(!r2.days[1].contrib.some((c) => c.id === 'paraglidable'));
  assert.ok(r2.days[0].pModel > r.days[0].pModel);
  assert.ok(Math.abs(r2.days[0].regimes.reduce((a, x) => a + x.p, 0) - 1) < 0.01);
  assert.equal(r2.days[0].paraglidable.fly, 0.95);
  assert.equal(r2.days[0].paraglidable.history.length, 1);
  assert.equal(r2.days[1].paraglidable.fly, null);
  assert.ok(r2.analysis.ia.length >= 1);
  assert.ok(r2.systems.some((s) => s.id === 'paraglidable' && s.kind === 'ia'));
});

test('Paraglidable : lecture de l’API, rapprochement de la normale, historique', () => {
  const api = { '2026-10-11': [{ lat: 44.1, lon: 3.07, name: 'Millau', forecast: { fly: 0.0667, XC: 0 } }], '2026-10-12': [{ lat: 44.1, lon: 3.07, name: 'Millau', forecast: { fly: 0.9059, XC: 0.1059 } }], junk: 3 };
  const { spot, days } = parseApi(api);
  assert.equal(spot.name, 'Millau');
  assert.deepEqual(Object.keys(days), ['2026-10-11', '2026-10-12']);
  // Monotone, rapproché de la normale, normale inchangée.
  assert.ok(Math.abs(calibrateFly(0.6, 0.6) - 0.6) < 1e-9);
  const hi = calibrateFly(0.95, 0.6);
  const lo = calibrateFly(0.05, 0.6);
  assert.ok(hi > 0.6 && hi < 0.95 && lo < 0.6 && lo > 0.05, `${hi} ${lo}`);
  assert.ok(calibrateFly(0.9, 0.6) > calibrateFly(0.8, 0.6));
  const sys = summarizeParaglidable({ days }, 0.6);
  assert.deepEqual(sys.cover, [true, false, false, false]);
  assert.equal(summarizeParaglidable({ days: { '2026-10-01': { fly: 0.5 } } }, 0.6), null);
  assert.equal(firstAvailable('2026-10-15'), '2026-10-06');
  // L'historique ne s'allonge que si un jour du stage change.
  const m1 = mergeParaglidable(null, { spot, days }, STAGE.dates, Date.parse('2026-10-03T10:00:00Z'));
  assert.ok(m1.changed);
  assert.equal(m1.data.history.length, 1);
  const days2 = { ...days, '2026-10-11': { fly: 0.5, XC: 0 } };
  const m2 = mergeParaglidable(m1.data, { spot, days: days2 }, STAGE.dates, Date.parse('2026-10-03T11:00:00Z'));
  assert.ok(!m2.changed);
  assert.equal(m2.data.history.length, 1);
  assert.equal(m2.data.changedAt, m1.data.changedAt);
  const m3 = mergeParaglidable(m2.data, { spot, days: { ...days2, '2026-10-13': { fly: 0.4, XC: 0 } } }, STAGE.dates, Date.parse('2026-10-03T12:00:00Z'));
  assert.ok(m3.changed);
  assert.equal(m3.data.history.length, 2);
});
