// Construit data/climatology.json : la référence « normale » de l'aiguille et la calibration des modèles.
//
// Sources (téléchargées dans .cache/, à lancer à la main, pas en CI) :
//  - Météo-France, données climatologiques de base horaires et quotidiennes, département 12
//    (Licence Ouverte 2.0, meteo.data.gouv.fr) : station 12145001 Millau (712 m) ;
//  - ERA5 (Copernicus / ECMWF) via l'API Historical Weather d'Open-Meteo (CC BY 4.0) ;
//  - analyses GFS 2021-2025 via l'API Historical Forecast d'Open-Meteo (géopotentiel 500 hPa, T 850 hPa).
//
// Usage : node scripts/build-climatology.mjs   (CLIMATO_CACHE=<dossier> pour réutiliser des fichiers)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { POINTS, STAGE } from '../engine/config.js';
import { stationEquivalent, hourMargin, morningMargin, sigmoid, round, quantiles, mean, sector8, SECTORS8 } from '../engine/flyability.js';

const CACHE = process.env.CLIMATO_CACHE || '.cache';
const MF = 'https://meteofrance.s3.sbg.io.cloud.ovh.net/data/synchro_ftp/BASE';
const STATION = '12145001';
const VALLEY = '12208004'; // Saint-Affrique (368 m), fond de vallée le plus proche avec températures
const HOURLY_FILES = ['1990-1999', '2000-2009', '2010-2019', 'previous-2020-2024', 'latest-2025-2026'].map((p) => `HOR/H_12_${p}.csv.gz`);
const DAILY_FILES = ['previous-1950-2024', 'latest-2025-2026'].flatMap((p) => [`QUOT/Q_12_${p}_RR-T-Vent.csv.gz`, `QUOT/Q_12_${p}_autres-parametres.csv.gz`]);
const YEARS = [1993, 2025]; // années complètes de données horaires (RR1, vent, rafales)
const WINDOW = [8, 19]; // matinées du 8 au 19 octobre : le stage ± 4 jours

fs.mkdirSync(CACHE, { recursive: true });

async function download(rel) {
  const file = path.join(CACHE, path.basename(rel));
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file;
  console.log('téléchargement', rel);
  const r = await fetch(`${MF}/${rel}`);
  if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

/** Lit un CSV Météo-France gzippé (latin-1, « ; ») et garde les lignes des postes demandés. */
async function readMF(file, stations, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()).setEncoding('latin1') });
  let header = null;
  for await (const line of rl) {
    if (!header) {
      header = line.split(';');
      continue;
    }
    const id = line.slice(0, 8);
    if (!stations.has(id)) continue;
    const cols = line.split(';');
    const row = {};
    header.forEach((h, i) => (row[h] = cols[i]));
    onRow(row);
  }
}

const num = (s) => (s === '' || s == null ? null : Number(s));

/** Dernier dimanche d'octobre : passage à l'heure d'hiver (UTC+1). */
const lastSundayOct = (y) => {
  const d = new Date(Date.UTC(y, 9, 31));
  return 31 - d.getUTCDay();
};
const utcOffset = (y, day) => (day >= lastSundayOct(y) ? 1 : 2);

async function openMeteo(url, cacheName) {
  const file = path.join(CACHE, cacheName);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  for (let k = 0; k < 5; k++) {
    const r = await fetch(url);
    const j = await r.json().catch(() => ({ error: true, reason: `HTTP ${r.status}` }));
    if (!j.error) {
      fs.writeFileSync(file, JSON.stringify(j));
      return j;
    }
    console.log('Open-Meteo :', j.reason, '→ nouvel essai');
    await new Promise((res) => setTimeout(res, 15000 * (k + 1)));
  }
  throw new Error(`Open-Meteo indisponible : ${url}`);
}

// ---------------------------------------------------------------- station horaire
console.log('Lecture des données horaires Météo-France…');
const hourly = new Map(); // "YYYYMMDDHH" (UTC) → obs
for (const rel of HOURLY_FILES) {
  const file = await download(rel);
  await readMF(file, new Set([STATION]), (r) => {
    const ts = r.AAAAMMJJHH;
    if (ts.slice(4, 6) !== '10') return;
    hourly.set(ts, {
      rr: num(r.RR1), ff: num(r.FF), dd: num(r.DD), fxi: num(r.FXI), vv: num(r.VV), t: num(r.T), u: num(r.U),
    });
  });
}
console.log(' ', hourly.size, 'heures d’octobre à la station', STATION);

const pad = (n) => String(n).padStart(2, '0');
/** Échantillon horaire de la station pour un créneau (heure locale de fin), à l'échelle station. */
function stationSample(y, day, localHour) {
  const utc = localHour - utcOffset(y, day);
  const o = hourly.get(`${y}10${pad(day)}${pad(utc)}`);
  if (!o || o.ff == null || o.rr == null) return null;
  return stationEquivalent({ rr: o.rr, ws: o.ff * 3.6, wg: o.fxi == null ? null : o.fxi * 3.6, wd: o.dd, vis: o.vv }, 'fine');
}
function stationMorning(y, day) {
  const hs = STAGE.morningSlots.map((h) => {
    const s = stationSample(y, day, h);
    return s ? hourMargin(s) : null;
  });
  if (hs.filter((h) => h == null).length > 0) return null;
  const mm = morningMargin(hs, STAGE.minConsecutiveSlots);
  return mm ? { ok: mm.M >= 0, M: mm.M, lim: mm.lim } : null;
}

const mornings = new Map(); // `${y}-${d}` → résultat
for (let y = YEARS[0]; y <= YEARS[1]; y++) for (let d = 1; d <= 31; d++) mornings.set(`${y}-${d}`, stationMorning(y, d));

// ---------------------------------------------------------------- ERA5 au point de la station
console.log('ERA5 (Open-Meteo)…');
const ERA_VARS = 'temperature_2m,relative_humidity_2m,precipitation,cloud_cover,cloud_cover_low,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cape,weather_code';
const era = {};
for (let y = YEARS[0]; y <= YEARS[1]; y++) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${POINTS.station.lat}&longitude=${POINTS.station.lon}&start_date=${y}-10-01&end_date=${y}-10-31&hourly=${ERA_VARS}&models=era5&timezone=GMT`;
  era[y] = (await openMeteo(url, `era5_station_${y}.json`)).hourly;
}
function eraSample(y, day, localHour, bias = 'coarse') {
  const H = era[y];
  const i = (day - 1) * 24 + localHour - utcOffset(y, day);
  if (H.wind_speed_10m[i] == null) return null;
  return stationEquivalent({
    rr: H.precipitation[i], ws: H.wind_speed_10m[i], wg: H.wind_gusts_10m[i], wd: H.wind_direction_10m[i],
    ccl: H.cloud_cover_low[i], cc: H.cloud_cover[i], rh: H.relative_humidity_2m[i], wc: H.weather_code[i], cape: H.cape[i],
  }, bias);
}
function eraMorning(y, day) {
  const hs = STAGE.morningSlots.map((h) => {
    const s = eraSample(y, day, h);
    return s ? hourMargin(s) : null;
  });
  const mm = morningMargin(hs, STAGE.minConsecutiveSlots);
  return mm?.M ?? null;
}

// ---------------------------------------------------------------- calibration logistique
const X = [];
const Y = [];
for (let y = YEARS[0]; y <= YEARS[1]; y++) {
  for (let d = 1; d <= 31; d++) {
    const s = mornings.get(`${y}-${d}`);
    const m = eraMorning(y, d);
    if (!s || m == null) continue;
    X.push(m);
    Y.push(s.ok ? 1 : 0);
  }
}
let alpha = 0;
let beta = 1;
for (let it = 0; it < 200; it++) {
  // Newton-Raphson
  let g0 = 0;
  let g1 = 0;
  let h00 = 0;
  let h01 = 0;
  let h11 = 0;
  for (let i = 0; i < X.length; i++) {
    const p = sigmoid(alpha + beta * X[i]);
    const w = p * (1 - p);
    g0 += p - Y[i];
    g1 += (p - Y[i]) * X[i];
    h00 += w;
    h01 += w * X[i];
    h11 += w * X[i] * X[i];
  }
  const det = h00 * h11 - h01 * h01;
  alpha -= (h11 * g0 - h01 * g1) / det;
  beta -= (h00 * g1 - h01 * g0) / det;
}
const pc = mean(Y);
const brier = mean(X.map((x, i) => (sigmoid(alpha + beta * x) - Y[i]) ** 2));
const brierClim = mean(Y.map((v) => (pc - v) ** 2));
const bins = new Map();
X.forEach((x, i) => {
  const b = Math.max(-2, Math.min(1, Math.round(x * 2) / 2));
  const e = bins.get(b) ?? { n: 0, obs: 0, pred: 0 };
  e.n++;
  e.obs += Y[i];
  e.pred += sigmoid(alpha + beta * x);
  bins.set(b, e);
});
const agreeTab = { vv: 0, vn: 0, nv: 0, nn: 0 };
X.forEach((x, i) => {
  const e = x >= 0;
  const s = Y[i] === 1;
  agreeTab[(s ? 'v' : 'n') + (e ? 'v' : 'n')]++;
});
console.log(`  calibration : alpha ${alpha.toFixed(3)} beta ${beta.toFixed(3)} (n=${X.length}, BSS ${(1 - brier / brierClim).toFixed(2)})`);

// ---------------------------------------------------------------- vent : échelle ERA5 ↔ station, rafales
const sFF = [];
const eFF = [];
const sFX = [];
const eFX = [];
const gustPairs = [];
for (let y = YEARS[0]; y <= YEARS[1]; y++) {
  for (let d = WINDOW[0]; d <= WINDOW[1]; d++) {
    for (const h of STAGE.morningSlots) {
      const o = hourly.get(`${y}10${pad(d)}${pad(h - utcOffset(y, d))}`);
      const i = (d - 1) * 24 + h - utcOffset(y, d);
      if (!o || o.ff == null || o.fxi == null) continue;
      sFF.push(o.ff * 3.6);
      sFX.push(o.fxi * 3.6);
      eFF.push(era[y].wind_speed_10m[i]);
      eFX.push(era[y].wind_gusts_10m[i]);
      gustPairs.push([o.ff * 3.6, o.fxi * 3.6]);
    }
  }
}
const exceed = (a, t) => a.filter((x) => x > t).length / a.length;
const qAt = (a, p) => quantiles(a, [p])[0];
const windMap = [16, 22, 28].map((t) => ({ station: t, era5: round(qAt(eFF, 1 - exceed(sFF, t)), 1) }));
const gustMap = [30, 35, 45].map((t) => ({ station: t, era5: round(qAt(eFX, 1 - exceed(sFX, t)), 1) }));
const gm = gustPairs.reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]).map((s) => s / gustPairs.length);
const gb = gustPairs.reduce((s, [x, y]) => s + (x - gm[0]) * (y - gm[1]), 0) / gustPairs.reduce((s, [x]) => s + (x - gm[0]) ** 2, 0);

// ---------------------------------------------------------------- climatologie des matinées
const winMornings = [];
const limCount = {};
for (let y = YEARS[0]; y <= YEARS[1]; y++) {
  for (let d = WINDOW[0]; d <= WINDOW[1]; d++) {
    const s = mornings.get(`${y}-${d}`);
    if (!s) continue;
    winMornings.push(s.ok ? 1 : 0);
    if (!s.ok) limCount[s.lim] = (limCount[s.lim] ?? 0) + 1;
  }
}
const pMorning = mean(winMornings);
const windows = [];
const pairs = [];
for (let y = YEARS[0]; y <= YEARS[1]; y++) {
  for (let d = WINDOW[0]; d + 3 <= WINDOW[1]; d++) {
    const w = [0, 1, 2, 3].map((k) => mornings.get(`${y}-${d + k}`));
    if (w.some((x) => !x)) continue;
    windows.push(w.map((x) => (x.ok ? 1 : 0)));
  }
  for (let d = WINDOW[0]; d < WINDOW[1]; d++) {
    const a = mornings.get(`${y}-${d}`);
    const b = mornings.get(`${y}-${d + 1}`);
    if (a && b) pairs.push([a.ok, b.ok]);
  }
}
const dist4 = [0, 1, 2, 3, 4].map((k) => windows.filter((w) => w.reduce((s, x) => s + x, 0) === k).length / windows.length);
const pFF = pairs.filter(([a, b]) => a && b).length / pairs.filter(([a]) => a).length;
const pNF = pairs.filter(([a, b]) => !a && b).length / pairs.filter(([a]) => !a).length;
const strip = [];
for (let y = YEARS[0]; y <= YEARS[1]; y++) {
  strip.push({
    year: y,
    days: [12, 13, 14, 15].map((d) => {
      const s = mornings.get(`${y}-${d}`);
      return s ? { ok: s.ok, lim: s.ok ? null : s.lim, M: round(s.M, 2) } : null;
    }),
  });
}

// Rose des vents des matinées (vent ≥ 8 km/h) et part des heures volables par secteur.
const rose = Object.fromEntries(SECTORS8.map((s) => [s, { n: 0, ws: 0, fly: 0 }]));
let roseTot = 0;
let calm = 0;
for (let y = YEARS[0]; y <= YEARS[1]; y++) {
  for (let d = WINDOW[0]; d <= WINDOW[1]; d++) {
    for (const h of STAGE.morningSlots) {
      const s = stationSample(y, d, h);
      if (!s) continue;
      roseTot++;
      if (s.ws < 8 || s.wd == null) {
        calm++;
        continue;
      }
      const e = rose[sector8(s.wd)];
      e.n++;
      e.ws += s.ws;
      e.fly += hourMargin(s).m >= 0 ? 1 : 0;
    }
  }
}

// ---------------------------------------------------------------- données quotidiennes
console.log('Lecture des données quotidiennes…');
const daily = { [STATION]: new Map(), [VALLEY]: new Map() };
const other = new Map();
for (const rel of DAILY_FILES) {
  const file = await download(rel);
  const isOther = rel.includes('autres');
  await readMF(file, new Set([STATION, VALLEY]), (r) => {
    const k = r.AAAAMMJJ;
    if (isOther) {
      if (r.NUM_POSTE === STATION) other.set(k, { brou: num(r.BROU), orag: num(r.ORAG), brume: num(r.BRUME), inst: num(r.INST) });
    } else {
      daily[r.NUM_POSTE].set(k, { rr: num(r.RR), tn: num(r.TN), tx: num(r.TX), ffm: num(r.FFM), fxi: num(r.FXI) });
    }
  });
}
const dsel = (st, y0, y1, days) => {
  const out = [];
  for (const [k, v] of daily[st]) {
    const y = +k.slice(0, 4);
    const m = +k.slice(4, 6);
    const d = +k.slice(6, 8);
    if (m !== 10 || y < y0 || y > y1) continue;
    if (days && (d < days[0] || d > days[1])) continue;
    out.push({ y, d, ...v });
  }
  return out;
};
const stats = (vals, d = 1) => {
  const v = vals.filter((x) => x != null);
  if (!v.length) return null;
  const m = mean(v);
  const sd = Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
  const [p10, p90] = quantiles(v, [0.1, 0.9]);
  return { mean: round(m, d), sd: round(sd, d), p10: round(p10, d), p90: round(p90, d), min: round(Math.min(...v), d), max: round(Math.max(...v), d), n: v.length };
};
function windowNormals(y0, y1, days) {
  const rows = dsel(STATION, y0, y1, days);
  const rr = rows.map((r) => r.rr).filter((x) => x != null);
  const fxi = rows.map((r) => r.fxi).filter((x) => x != null);
  return {
    period: `${y0}-${y1}`,
    days: days ? `${days[0]}-${days[1]} oct.` : 'octobre',
    tx: stats(rows.map((r) => r.tx)),
    tn: stats(rows.map((r) => r.tn)),
    rrPerDay: round(mean(rr), 2),
    rrMonth: days ? null : round(mean(rr) * 31, 1),
    pRain1: round(rr.filter((x) => x >= 1).length / rr.length, 3),
    pRain10: round(rr.filter((x) => x >= 10).length / rr.length, 3),
    rrP90: round(quantiles(rr, [0.9])[0], 1),
    ffm: round(mean(rows.map((r) => r.ffm)) * 3.6, 1),
    fxi: round(mean(fxi) * 3.6, 1),
    fxiP90: round(quantiles(fxi, [0.9])[0] * 3.6, 0),
    pGust58: round(fxi.filter((x) => x >= 16).length / fxi.length, 3),
  };
}
const recRows = dsel(STATION, 1900, 2100, [12, 15]);
const best = (rows, key, cmp) => rows.filter((r) => r[key] != null).reduce((a, b) => (cmp(b[key], a[key]) ? b : a));
const rec = (key, cmp, mult = 1) => {
  const r = best(recRows, key, cmp);
  return { value: round(r[key] * mult, 1), date: `${pad(r.d)}/10/${r.y}` };
};
const occ = { n: 0, brou: 0, orag: 0, brume: 0 };
for (const [k, v] of other) {
  const y = +k.slice(0, 4);
  const m = +k.slice(4, 6);
  const d = +k.slice(6, 8);
  if (m !== 10 || d < WINDOW[0] || d > WINDOW[1] || y < 1991) continue;
  if (v.brou == null && v.orag == null) continue;
  occ.n++;
  occ.brou += v.brou > 0 ? 1 : 0;
  occ.orag += v.orag > 0 ? 1 : 0;
  occ.brume += v.brume > 0 ? 1 : 0;
}
const vp = [];
for (const [k, v] of daily[VALLEY]) {
  if (+k.slice(4, 6) !== 10) continue;
  const w = daily[STATION].get(k);
  if (!w || [v.tx, v.tn, w.tx, w.tn].some((x) => x == null)) continue;
  vp.push({ y: +k.slice(0, 4), dtx: v.tx - w.tx, dtn: v.tn - w.tn });
}

// ---------------------------------------------------------------- ERA5 : pression, Aigoual ; GFS : altitude
const mslp = [];
for (let y = YEARS[0]; y <= YEARS[1]; y++) {
  for (let d = WINDOW[0]; d <= WINDOW[1]; d++) {
    const H = era[y];
    const vals = [];
    for (let h = 6; h <= 18; h++) vals.push(H.pressure_msl[(d - 1) * 24 + h - utcOffset(y, d)]);
    mslp.push(mean(vals));
  }
}
const aig = [];
for (let y = YEARS[0]; y <= YEARS[1]; y++) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${POINTS.aigoual.lat}&longitude=${POINTS.aigoual.lon}&start_date=${y}-10-01&end_date=${y}-10-31&daily=precipitation_sum&models=era5&timezone=Europe%2FParis`;
  aig.push(...(await openMeteo(url, `era5_aigoual_${y}.json`)).daily.precipitation_sum);
}
const z500 = [];
const t850 = [];
for (let y = 2021; y <= 2025; y++) {
  const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${POINTS.deco.lat}&longitude=${POINTS.deco.lon}&start_date=${y}-10-01&end_date=${y}-10-25&hourly=geopotential_height_500hPa,temperature_850hPa&models=gfs_global&timezone=Europe%2FParis`;
  const H = (await openMeteo(url, `gfs_upper_${y}.json`)).hourly;
  H.time.forEach((t, i) => {
    if (+t.slice(11, 13) !== 12) return;
    if (H.geopotential_height_500hPa[i] != null) z500.push(H.geopotential_height_500hPa[i]);
    if (H.temperature_850hPa[i] != null) t850.push(H.temperature_850hPa[i]);
  });
}

// ---------------------------------------------------------------- écriture
const out = {
  generatedAt: new Date().toISOString(),
  station: { id: STATION, name: 'Millau', lat: POINTS.station.lat, lon: POINTS.station.lon, alt: 712 },
  sources: {
    meteofrance: 'Météo-France, données climatologiques de base horaires et quotidiennes (Licence Ouverte 2.0) — meteo.data.gouv.fr',
    era5: 'ERA5 (Copernicus Climate Change Service / ECMWF) via Open-Meteo Historical Weather API (CC BY 4.0)',
    gfs: 'Analyses NOAA GFS via Open-Meteo Historical Forecast API',
  },
  calibration: {
    alpha: round(alpha, 3),
    beta: round(beta, 3),
    n: X.length,
    period: `octobre ${YEARS[0]}-${YEARS[1]}`,
    brier: round(brier, 3),
    brierClim: round(brierClim, 3),
    bss: round(1 - brier / brierClim, 2),
    agreement: round((agreeTab.vv + agreeTab.nn) / X.length, 3),
    pStationGivenModelFly: round(agreeTab.vv / (agreeTab.vv + agreeTab.nv), 3),
    pStationGivenModelNoFly: round(agreeTab.vn / (agreeTab.vn + agreeTab.nn), 3),
    reliability: [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([b, e]) => ({ bin: b, n: e.n, obs: round(e.obs / e.n, 3), pred: round(e.pred / e.n, 3) })),
  },
  windScale: {
    note: 'Seuils station ↔ seuils ERA5 à fréquence de dépassement égale (matinées 8-19 oct.)',
    wind: windMap,
    gust: gustMap,
    corrWind: null,
  },
  gustFromWind: { a: round(gm[1] - gb * gm[0], 2), b: round(gb, 2), n: gustPairs.length },
  mornings: {
    period: `${YEARS[0]}-${YEARS[1]}`,
    window: `${WINDOW[0]}-${WINDOW[1]} oct.`,
    n: winMornings.length,
    pMorning: round(pMorning, 4),
    limiting: Object.fromEntries(Object.entries(limCount).map(([k, v]) => [k, round(v / winMornings.length, 3)])),
    windowsN: windows.length,
    dist4: dist4.map((x) => round(x, 4)),
    pAtLeast: [1, 2, 3, 4].map((k) => round(dist4.slice(k).reduce((s, x) => s + x, 0), 4)),
    pFlyAfterFly: round(pFF, 3),
    pFlyAfterNoFly: round(pNF, 3),
    windows,
  },
  strip,
  windRose: {
    calm: round(calm / roseTot, 3),
    sectors: SECTORS8.map((s) => ({ sector: s, freq: round(rose[s].n / roseTot, 3), ws: round(rose[s].n ? rose[s].ws / rose[s].n : null, 1), fly: round(rose[s].n ? rose[s].fly / rose[s].n : null, 2) })),
  },
  normals: {
    october: windowNormals(1991, 2020, null),
    window: windowNormals(1991, 2020, [12, 15]),
    windowRecent: windowNormals(1996, 2025, [12, 15]),
    records: {
      since: Math.min(...recRows.map((r) => r.y)),
      txMax: rec('tx', (a, b) => a > b),
      tnMin: rec('tn', (a, b) => a < b),
      rrMax: rec('rr', (a, b) => a > b),
      fxiMax: rec('fxi', (a, b) => a > b, 3.6),
    },
  },
  occurrences: { period: '1991-2025', window: `${WINDOW[0]}-${WINDOW[1]} oct.`, n: occ.n, fog: round(occ.brou / occ.n, 3), thunder: round(occ.orag / occ.n, 3), mist: round(occ.brume / occ.n, 3) },
  valley: {
    station: 'Saint-Affrique (368 m)',
    id: VALLEY,
    years: vp.length ? `${Math.min(...vp.map((x) => x.y))}-${Math.max(...vp.map((x) => x.y))}` : null,
    n: vp.length,
    dTx: round(mean(vp.map((x) => x.dtx)), 1),
    dTn: round(mean(vp.map((x) => x.dtn)), 1),
    pInversion: round(vp.filter((x) => x.dtn < 0).length / vp.length, 3),
  },
  era5: { mslp: stats(mslp), period: `${YEARS[0]}-${YEARS[1]}`, window: `${WINDOW[0]}-${WINDOW[1]} oct.` },
  upper: { z500: stats(z500, 0), t850: stats(t850, 1), ref: 'analyses GFS de 12 h locale, 1er-25 octobre 2021-2025 (référence courte)' },
  aigoual: {
    period: `octobre ${YEARS[0]}-${YEARS[1]} (ERA5)`,
    p50: round(aig.filter((x) => x >= 50).length / aig.length, 4),
    p100: round(aig.filter((x) => x >= 100).length / aig.length, 4),
    mean: round(mean(aig), 1),
  },
};
fs.writeFileSync('data/climatology.json', JSON.stringify(out));
console.log('data/climatology.json écrit :', {
  pMorning: out.mornings.pMorning,
  pAtLeast3: out.mornings.pAtLeast[2],
  calibration: [out.calibration.alpha, out.calibration.beta, out.calibration.bss],
  gustFromWind: out.gustFromWind,
  windScale: out.windScale.wind,
  gustScale: out.windScale.gust,
  normals: out.normals.window.tx,
});
