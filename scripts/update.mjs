// Mise à jour de l'aiguille, lancée par GitHub Actions toutes les 20 minutes (ou à la main).
//
// 1. lit l'heure du dernier run de chaque modèle (métadonnées Open-Meteo, requêtes gratuites) ;
// 2. ne retélécharge que les systèmes dont un nouveau run atteint les matinées du stage ;
// 3. recombine tout (data/systems/*.json + data/deterministic.json) en data/latest.json ;
// 4. ajoute un point à data/history.json et commente l'issue d'alertes si l'aiguille a bougé de ±30.
//
// Options : --force (tout retélécharger), --rebuild (recalculer sans télécharger), --dry (pas d'alerte).

import fs from 'node:fs';
import { STAGE, POINTS, ENSEMBLES, DETERMINISTIC, DET_VARS, DET_VARS_VALLEY, ENGINE_VERSION, ALERT } from '../engine/config.js';
import { parseMembers, parseDeterministic, summarizeEnsemble, summarizeDeterministic } from '../engine/process.js';
import { buildReport } from '../engine/report.js';
import { getJson, getMeta, ensembleUrl, forecastRange, forecastUrl } from './openmeteo.mjs';

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const REBUILD = args.has('--rebuild');
const RECOMBINE = args.has('--recombine'); // cherche les nouveaux runs, puis recombine même sans nouveauté
const DRY = args.has('--dry');
const now = Date.now();
const SITE_URL = process.env.SITE_URL ?? 'https://r69sy78sny-droid.github.io/stage-millau/';

const readJson = (f, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
const log = (...a) => console.log(...a);
function output(changed, summary = '') {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nsummary=${summary.replace(/\n/g, ' ')}\n`);
}
const runLabel = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}z ${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const clim = readJson('data/climatology.json');
if (!clim) throw new Error('data/climatology.json manquant : lancer d’abord node scripts/build-climatology.mjs');
const calib = { alpha: clim.calibration.alpha, beta: clim.calibration.beta };
const state = readJson('data/state.json', { systems: {}, det: null, lastScore: null, lastAlertScore: null, lastAlertDays: null, updates: 0 });
fs.mkdirSync('data/systems', { recursive: true });

if (now > Date.parse(`${STAGE.dates.at(-1)}T20:00:00Z`) && !FORCE && !REBUILD && !RECOMBINE) {
  log('Le stage est terminé : plus de mise à jour.');
  output(false);
  process.exit(0);
}

// ---------------------------------------------------------------- 1. heures des derniers runs
const domains = new Set([...ENSEMBLES.flatMap((s) => s.meta), ...DETERMINISTIC.map((s) => s.meta).filter(Boolean)]);
const metas = {};
await Promise.all([...domains].map(async (d) => (metas[d] = await getMeta(d))));
const windowStart = Date.parse(`${STAGE.dates[0]}T07:00:00Z`); // 9 h locale le premier jour
const latestMeta = (list) => list.map((d) => metas[d]).filter(Boolean).sort((a, b) => Date.parse(b.init) - Date.parse(a.init))[0] ?? null;
/** Run qui a produit les données du stage : le dernier s'il atteint la fenêtre, sinon le précédent. */
const windowRun = (m, prevInit) => {
  if (!m) return prevInit ?? null;
  const reaches = !m.end || Date.parse(m.end) >= windowStart;
  if (reaches) return m.init;
  return prevInit ?? new Date(Date.parse(m.init) - (m.interval ?? 21600) * 1000).toISOString();
};

const refreshed = [];
const triggers = [];
const errors = [];

// ---------------------------------------------------------------- 2. ensembles
if (!REBUILD) {
  for (const sys of ENSEMBLES) {
    const file = `data/systems/${sys.id}.json`;
    const prev = state.systems[sys.id];
    const m = latestMeta(sys.meta);
    const runInit = windowRun(m, prev?.init);
    const stale = !fs.existsSync(file) || prev?.engine !== ENGINE_VERSION;
    const newRun = runInit && (!prev?.init || Date.parse(runInit) > Date.parse(prev.init));
    if (!(FORCE || stale || newRun)) continue;
    try {
      const main = await getJson(ensembleUrl(sys, POINTS.deco), { label: sys.label });
      const parsed = parseMembers(main.hourly, sys.vars);
      let aig = null;
      try {
        const a = await getJson(ensembleUrl(sys, POINTS.aigoual, ['rr']), { label: `${sys.label} (Aigoual)` });
        aig = parseMembers(a.hourly, ['rr']);
      } catch (e) {
        errors.push(e.message);
      }
      const summary = summarizeEnsemble(sys, parsed, aig, {
        calib,
        elevation: POINTS.deco.elevation,
        run: { init: runInit, available: m?.available ?? null, end: m?.end ?? null },
      });
      summary.fetchedAt = new Date(now).toISOString();
      writeJson(file, summary);
      state.systems[sys.id] = { init: runInit, engine: ENGINE_VERSION, fetchedAt: summary.fetchedAt };
      refreshed.push(sys.id);
      if (newRun && summary.cover.some(Boolean)) triggers.push(`${sys.short} ${runLabel(runInit)}`);
      log(`✓ ${sys.label} run ${runLabel(runInit)} — ${parsed.members.length} membres, matinées couvertes ${summary.cover.map((c) => (c ? '■' : '□')).join('')}, p = ${summary.days.map((d) => (d.p == null ? '—' : Math.round(d.p * 100))).join(' / ')}`);
    } catch (e) {
      errors.push(`${sys.label} : ${e.message}`);
      log(`✗ ${sys.label} : ${e.message}`);
    }
  }

  // -------------------------------------------------------------- 3. modèles déterministes
  const range = forecastRange(now);
  const detFile = 'data/deterministic.json';
  const prevDet = state.det;
  const inits = Object.fromEntries(DETERMINISTIC.map((s) => [s.id, windowRun(s.meta ? metas[s.meta] : null, prevDet?.inits?.[s.id])]));
  const changedDet = DETERMINISTIC.filter((s) => inits[s.id] && (!prevDet?.inits?.[s.id] || Date.parse(inits[s.id]) > Date.parse(prevDet.inits[s.id])));
  const detStale = !fs.existsSync(detFile) || prevDet?.engine !== ENGINE_VERSION;
  if (range && (FORCE || detStale || changedDet.length)) {
    try {
      const models = DETERMINISTIC.map((s) => s.model);
      const deco = await getJson(forecastUrl(models, POINTS.deco, DET_VARS, range), { label: 'modèles déterministes (déco)' });
      const valley = await getJson(forecastUrl(models, POINTS.atterro, DET_VARS_VALLEY, range), { label: 'modèles déterministes (vallée)' });
      const pd = parseDeterministic(deco.hourly, models, DET_VARS);
      const pv = parseDeterministic(valley.hourly, models, DET_VARS_VALLEY);
      const dets = DETERMINISTIC.map((s) => {
        const m = s.meta ? metas[s.meta] : null;
        return summarizeDeterministic(s, pd[s.model], pv[s.model], deco.hourly.time, {
          calib,
          elevation: POINTS.deco.elevation,
          valleyElevation: POINTS.atterro.elevation,
          run: { init: inits[s.id], available: m?.available ?? null },
        });
      });
      writeJson(detFile, { fetchedAt: new Date(now).toISOString(), models: dets });
      state.det = { engine: ENGINE_VERSION, fetchedAt: new Date(now).toISOString(), inits };
      refreshed.push('deterministic');
      for (const s of changedDet) {
        const d = dets.find((x) => x.id === s.id);
        if (d?.cover.some(Boolean)) triggers.push(`${s.label} ${runLabel(inits[s.id])}`);
      }
      log(`✓ déterministes : ${dets.filter((d) => d.cover.some(Boolean)).map((d) => d.label).join(', ') || 'aucun ne couvre encore le stage'}`);
    } catch (e) {
      errors.push(e.message);
      log(`✗ déterministes : ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------- 4. combinaison
if (!refreshed.length && !FORCE && !REBUILD && !RECOMBINE && fs.existsSync('data/latest.json')) {
  log('Aucun nouveau run utile : rien à publier.');
  output(false);
  process.exit(0);
}
const ens = ENSEMBLES.map((s) => readJson(`data/systems/${s.id}.json`)).filter((x) => x && x.engine === ENGINE_VERSION);
const det = (readJson('data/deterministic.json', { models: [] }).models ?? []).filter((x) => x.engine === ENGINE_VERSION);
if (!ens.length) {
  log('Aucun résumé d’ensemble disponible.', errors);
  output(false);
  process.exit(errors.length ? 1 : 0);
}
const observed = readJson('data/observed.json', {});
const report = buildReport({ ens, det, clim, now, metas, refreshed, observed });
report.errors = errors;
report.triggers = triggers;
writeJson('data/latest.json', report);

// ---------------------------------------------------------------- 5. historique
const history = readJson('data/history.json', []);
const last = history.at(-1);
const entry = {
  t: report.generatedAt,
  score: report.score,
  p: report.p,
  pDays: report.days.map((d) => d.p),
  a: report.days.map((d) => d.a),
  expected: report.expected,
  trigger: triggers.length ? triggers : process.env.TRIGGER_LABEL ? [process.env.TRIGGER_LABEL] : ['recalcul'],
};
const onlyRecalc = !triggers.length && last && last.score === entry.score;
if (!onlyRecalc) history.push(entry);
writeJson('data/history.json', history);

// ---------------------------------------------------------------- 6. alerte GitHub
async function github(method, path, body) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'stage-millau',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`GitHub ${method} ${path} : HTTP ${r.status} ${await r.text()}`);
  return r.json();
}
const fmtScore = (s) => `${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(s)}`;
async function postAlert(prevScore) {
  const repo = process.env.GITHUB_REPOSITORY;
  const owner = process.env.GITHUB_REPOSITORY_OWNER ?? repo.split('/')[0];
  const issues = await github('GET', `/repos/${repo}/issues?state=all&per_page=100`);
  let issue = issues.find((i) => i.title === ALERT.issueTitle && !i.pull_request);
  if (!issue) {
    issue = await github('POST', `/repos/${repo}/issues`, {
      title: ALERT.issueTitle,
      body: `Chaque fois que l'aiguille bouge d'au moins ${ALERT.threshold} points, un commentaire est ajouté ici (tu en es notifié par mail et dans l'app GitHub).\n\nSite : ${SITE_URL}`,
    });
  } else if (issue.state === 'closed') {
    await github('PATCH', `/repos/${repo}/issues/${issue.number}`, { state: 'open' });
  }
  const delta = report.score - prevScore;
  const prevDays = state.lastAlertDays ?? [];
  const rows = report.days.map((d, i) => {
    const before = prevDays[i];
    const dd = before == null ? '' : ` (${fmtScore(Math.round((d.p - before) * 100))} pts)`;
    return `| ${d.label} | ${Math.round(d.p * 100)} %${dd} |`;
  });
  const body = [
    `@${owner} l'aiguille est passée de **${fmtScore(prevScore)}** à **${fmtScore(report.score)}** (${fmtScore(delta)} points).`,
    '',
    `**Probabilité que tes ${STAGE.sessionsNeeded} matinées volent : ${Math.round(report.p * 100)} %** — ${report.verdict.label}.`,
    '',
    '| Matinée | Volable |',
    '|---|---|',
    ...rows,
    '',
    `Déclencheur : ${triggers.join(', ') || 'recalcul'}.`,
    '',
    `→ ${SITE_URL}`,
  ].join('\n');
  await github('POST', `/repos/${repo}/issues/${issue.number}/comments`, { body });
  log(`🔔 alerte publiée sur l'issue #${issue.number}`);
}
if (state.lastAlertScore == null) {
  state.lastAlertScore = report.score;
  state.lastAlertDays = report.days.map((d) => d.p);
} else if (Math.abs(report.score - state.lastAlertScore) >= ALERT.threshold) {
  if (!DRY && process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
    try {
      await postAlert(state.lastAlertScore);
      state.lastAlertScore = report.score;
      state.lastAlertDays = report.days.map((d) => d.p);
    } catch (e) {
      errors.push(e.message);
      log(`✗ alerte : ${e.message}`);
    }
  } else {
    log(`(alerte non envoyée hors GitHub Actions : ${fmtScore(state.lastAlertScore)} → ${fmtScore(report.score)})`);
  }
}

state.lastScore = report.score;
state.updates = (state.updates ?? 0) + 1;
state.lastUpdate = report.generatedAt;
writeJson('data/state.json', state);

const summary = `🎯 ${last ? `${fmtScore(last.score)} → ` : ''}${fmtScore(report.score)} (${Math.round(report.p * 100)} %) · ${triggers.join(', ') || process.env.TRIGGER_LABEL || 'recalcul'}`;
log(summary);
log('Matinées :', report.days.map((d) => `${d.label} ${Math.round(d.p * 100)} % (a=${d.a})`).join(' | '));
if (errors.length) log('Avertissements :', errors);
output(true, summary);
