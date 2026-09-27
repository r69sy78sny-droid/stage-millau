// Page du VU-mètre : lit data/latest.json et data/history.json, dessine l'aiguille et le détail,
// puis revérifie toutes les 5 minutes pour faire bouger l'aiguille dès qu'une mise à jour est publiée.

import { createGauge } from './gauge.js';
import { h, heat, fmtPct, fmtScore, historyChart, distChart, regimeBars, windRose, reliabilityChart } from './charts.js';
import { REGIMES, LIMITS, SITES, ENSEMBLES, DETERMINISTIC, LEAD } from '../engine/config.js';

const POLL_MS = 5 * 60 * 1000;
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* stockage indisponible : sans conséquence */
    }
  },
};

/** Familles de régimes pour les barres empilées (5 teintes validées pour le daltonisme, ordre fixe). */
const FAMILIES = {
  pluie: { label: 'Pluie, perturbation ou épisode méditerranéen', short: 'Pluie', color: '--reg-1', ink: '#fff', members: ['cevenol', 'perturbe', 'instable'] },
  sud: { label: 'Flux de sud-est (vent du Midi, marin)', short: 'Sud-est', color: '--reg-2', ink: '#fff', members: ['sud'] },
  nord: { label: 'Flux de nord à ouest (tramontane, flux atlantique)', short: 'Nord-ouest', color: '--reg-3', ink: '#0b0b0b', members: ['nord', 'ouest'] },
  calme: { label: 'Calme : anticyclone ou marais barométrique', short: 'Calme', color: '--reg-4', ink: '#0b0b0b', members: ['anticyclone', 'marais'] },
  est: { label: "Vent d'est à nord-est", short: 'Est', color: '--reg-5', ink: '#0b0b0b', members: ['est'] },
};
const FAMILY_OF = Object.fromEntries(Object.entries(FAMILIES).flatMap(([f, v]) => v.members.map((m) => [m, f])));
const LIM_LABEL = {
  pluie: 'pluie',
  vent: 'vent moyen trop fort',
  rafales: 'rafales',
  direction: "vent d'est (aucun déco)",
  nuages: 'nuages bas ou brouillard au déco',
  orage: 'orage',
  ventMeteo: 'vent fort en altitude',
};
const LIM_SHORT = { pluie: 'pluie', vent: 'vent', rafales: 'rafales', direction: 'vent E', nuages: 'nuages', orage: 'orage', ventMeteo: 'vent alt.' };
const CONF_LABEL = { faible: 'Fiabilité faible', moyenne: 'Fiabilité moyenne', bonne: 'Bonne fiabilité' };

const $ = (id) => document.getElementById(id);
const fr = (x, d = 0) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d).replace('.', ',').replace('-', '−'));
const fmtWhen = (iso, opts = {}) => (iso ? new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...opts }) : '—');
const shortDay = (label) => label.replace(' octobre', '');
const q = (arr, d = 0, unit = '') => (arr ? `${fr(arr[1], d)}${unit}` : '—');
const qr = (arr, d = 0, unit = '') => (arr ? `${fr(arr[1], d)}${unit} (${fr(arr[0], d)} à ${fr(arr[2], d)})` : '—');
const SECT = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const sector = (deg) => (deg == null ? '—' : SECT[Math.floor(((deg + 22.5) % 360) / 45)]);

let report = null;
let history = [];
let selectedDay = null;
let gauge = null;

// ---------------------------------------------------------------- chargement
async function load() {
  const bust = `?t=${Date.now()}`;
  const [r, hist] = await Promise.all([
    fetch(`data/latest.json${bust}`, { cache: 'no-store' }).then((x) => x.json()),
    fetch(`data/history.json${bust}`, { cache: 'no-store' }).then((x) => x.json()).catch(() => []),
  ]);
  return { r, hist };
}

async function refresh(initial = false) {
  let data;
  try {
    data = await load();
  } catch (e) {
    if (initial) $('verdict').textContent = 'Données indisponibles pour le moment';
    return;
  }
  const changed = !report || data.r.generatedAt !== report.generatedAt;
  if (!changed) return;
  const previous = report;
  report = data.r;
  history = data.hist;
  if (selectedDay == null) {
    const firstFuture = report.days.findIndex((d) => !d.past);
    selectedDay = firstFuture < 0 ? 0 : firstFuture;
  }
  renderAll({ previous, initial });
}

function renderAll({ previous, initial }) {
  renderHero(previous, initial);
  renderDays();
  renderDist();
  renderHistory();
  renderDayDetail();
  renderAnalysis();
  renderModels();
  renderClimatology();
  renderMethod();
}

// ---------------------------------------------------------------- héros
function renderHero(previous, initial) {
  const r = report;
  if (!gauge) gauge = createGauge($('gauge'));
  const lastSeen = Number(store.get('lastScore'));
  const from = previous ? previous.score : initial && !Number.isNaN(lastSeen) && store.get('lastScore') != null ? lastSeen : -180;
  gauge.setClimatology(r.climatology.scoreClim);
  gauge.setTrail(history.slice(-13, -1).map((e) => e.score));
  gauge.set(r.score, { from });
  gauge.setLabel(`Aiguille à ${fmtScore(r.score)} sur une échelle de −180 (impossible) à +180 (le stage aura lieu) : ${r.verdict.label}.`);
  $('score').textContent = fmtScore(r.score);
  $('verdict').textContent = r.verdict.label;
  $('proba').replaceChildren(
    'Probabilité que tes ', h('b', {}, `${r.stage.sessionsNeeded} matinées`), ' volent : ', h('b', {}, fmtPct(r.p)),
    ` · ${fr(r.expected, 1)} matinée(s) volable(s) attendue(s) sur 4`,
  );
  const need = r.stage.sessionsNeeded;
  $('clim').textContent = `Normale à Millau (${r.climatology.period}) : ${fmtPct(r.climatology.pAtLeast[need - 1])}, soit ${fmtScore(r.climatology.scoreClim)} sur l'aiguille.`;
  $('summary').textContent = r.analysis.summary.slice(1).join(' ');
  const ageH = (Date.now() - Date.parse(r.generatedAt)) / 3600e3;
  const delta = previous ? r.score - previous.score : lastSeenDelta(lastSeen, r.score);
  $('updated').replaceChildren(...[
    h('span', { class: `badge ${ageH < 12 ? 'live' : ''}` }, h('i', { class: 'dot' }), ageH < 12 ? 'Suivi en direct' : 'Suivi en pause'),
    h('span', {}, `Données modifiées ${fmtWhen(r.generatedAt)}`),
    r.triggers?.length ? h('span', {}, `après ${r.triggers.join(', ')}`) : null,
    delta ? h('span', {}, `${fmtScore(delta)} depuis ta dernière visite`) : null,
    h('span', { id: 'lastcheck' }),
  ].filter(Boolean));
  showLastCheck();
  store.set('lastScore', String(r.score));
  if (previous && previous.score !== r.score) toast(`Nouvelle mise à jour : ${fmtScore(previous.score)} → ${fmtScore(r.score)}`);
}
const lastSeenDelta = (lastSeen, score) => (store.get('lastScore') == null || Number.isNaN(lastSeen) ? 0 : score - lastSeen);

// Dernière vérification du robot (même sans nouveauté) : lue dans l'API publique de GitHub Actions.
let lastCheck = null;
async function fetchLastCheck() {
  try {
    const r = await fetch('https://api.github.com/repos/r69sy78sny-droid/stage-millau/actions/workflows/aiguille.yml/runs?per_page=1&status=success', { cache: 'no-store' });
    const run = (await r.json()).workflow_runs?.[0];
    if (run) lastCheck = run.updated_at;
  } catch {
    /* API indisponible ou quota atteint : on garde la dernière valeur */
  }
  showLastCheck();
}
function showLastCheck() {
  const el = $('lastcheck');
  if (!el || !report) return;
  if (!lastCheck) return (el.textContent = '');
  const newer = Date.parse(lastCheck) > Date.parse(report.generatedAt) + 60000;
  el.textContent = newer
    ? `Dernière vérification ${fmtWhen(lastCheck)} (pas de modification depuis ${fmtWhen(report.generatedAt)})`
    : `Dernière vérification ${fmtWhen(lastCheck)}`;
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 6000);
}

// ---------------------------------------------------------------- cartes des jours
function familyShares(regimes) {
  const out = {};
  for (const reg of regimes ?? []) {
    const f = FAMILY_OF[reg.id] ?? 'calme';
    out[f] = out[f] ?? { p: 0, fly: 0, w: 0 };
    out[f].p += reg.p;
    if (reg.pFly != null) {
      out[f].fly += reg.p * reg.pFly;
      out[f].w += reg.p;
    }
  }
  return Object.keys(FAMILIES).map((id) => ({ id, p: out[id]?.p ?? 0, pFly: out[id]?.w ? out[id].fly / out[id].w : null }));
}

function topRisk(day) {
  const entries = Object.entries(day.limiting ?? {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  return { label: LIM_LABEL[entries[0][0]] ?? entries[0][0], p: entries[0][1] };
}

function renderDays() {
  const box = $('days');
  box.replaceChildren();
  report.days.forEach((d, i) => {
    const s = d.stats;
    const risk = topRisk(d);
    const fams = familyShares(d.regimes).filter((f) => f.p >= 0.08).sort((a, b) => b.p - a.p).slice(0, 3);
    const card = h('button', { class: 'card day', type: 'button', 'aria-pressed': String(i === selectedDay), onclick: () => selectDay(i) },
      h('div', { class: 'dname' }, shortDay(d.label), d.observed != null ? h('span', { class: 'muted' }, d.observed ? ' · volée ✔' : ' · pas volée') : d.past ? h('span', { class: 'muted' }, ' · passée') : null),
      h('div', { class: 'dp' }, fmtPct(d.p), h('small', {}, ' volable')),
      h('div', { class: 'meter', title: `Normale : ${fmtPct(d.pClim)}` },
        h('i', { style: `width:${Math.round(d.p * 100)}%` }),
        h('b', { style: `left:calc(${Math.round(d.pClim * 100)}% - 1px)` })),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Vent matin'), h('dd', {}, s.morning?.ws ? `${fr(s.morning.ws[1])} km/h, raf. ${fr(s.morning.wg[1])}` : '—'),
        h('dt', {}, 'Pluie matin'), h('dd', {}, fmtPct(s.pRainMorning)),
        h('dt', {}, 'Déco'), h('dd', {}, s.tMin ? `${fr(s.tMin[1])} → ${fr(s.tMax[1])} °C` : '—'),
        h('dt', {}, 'Risque n°1'), h('dd', {}, risk ? `${risk.label} ${fmtPct(risk.p)}` : '—')),
      fams.length ? h('div', { class: 'chips' }, fams.map((f) => h('span', { class: 'chip' }, h('i', { style: `background:var(${FAMILIES[f.id].color})` }), `${FAMILIES[f.id].short} ${fmtPct(f.p)}`))) : null,
      h('div', { class: 'conf' }, `${CONF_LABEL[d.confidence]} · modèles ${fmtPct(d.a)} / normale ${fmtPct(1 - d.a)}`),
    );
    box.appendChild(card);
  });
}

function selectDay(i) {
  selectedDay = i;
  renderDays();
  renderDayDetail();
  activateTab('t-jour');
  $('p-jour').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- loi du nombre de matinées, historique
function renderDist() {
  const r = report;
  const need = r.stage.sessionsNeeded;
  $('dist-cap').replaceChildren(h('b', {}, 'Combien de matinées volables ?'), ` Il en faut ${need} sur 4 : ${fmtPct(r.p)} (normale ${fmtPct(r.climatology.pAtLeast[need - 1])}).`);
  distChart($('dist'), r.dist, r.climatology.dist4, need);
  $('dist-table').replaceChildren(table(['Matinées volables', 'Prévision', 'Climatologie'], r.dist.map((p, k) => [k, fmtPct(p), fmtPct(r.climatology.dist4[k])]), [false, true, true]));
}

function renderHistory() {
  const r = report;
  historyChart($('history'), history, { climScore: r.climatology.scoreClim, stageStart: `${r.stage.dates[0]}T07:00:00Z`, stageEnd: `${r.stage.dates.at(-1)}T11:00:00Z` });
  const rows = [...history].reverse().map((e) => [fmtWhen(e.t), fmtScore(e.score), fmtPct(e.p), e.pDays.map((p) => fmtPct(p)).join(' · '), (e.trigger ?? []).join(', ')]);
  $('history-table').replaceChildren(table(['Date', 'Aiguille', 'Proba', 'Matinées 12 · 13 · 14 · 15', 'Déclencheur'], rows, [false, true, true, false, false]));
}

function table(headers, rows, numeric = []) {
  return h('table', {},
    h('thead', {}, h('tr', {}, headers.map((x, i) => h('th', { class: numeric[i] ? 'n' : null }, x)))),
    h('tbody', {}, rows.map((row) => h('tr', {}, row.map((c, i) => (c instanceof Node ? h('td', { class: numeric[i] ? 'n' : null }, c) : h('td', { class: numeric[i] ? 'n' : null }, String(c ?? '—'))))))));
}

// ---------------------------------------------------------------- onglets
function activateTab(id) {
  for (const b of document.querySelectorAll('#tabs [role=tab]')) {
    const on = b.id === id;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    $(b.getAttribute('aria-controls')).hidden = !on;
  }
  // Les graphiques d'un onglet caché ont été dessinés à largeur nulle : on les redessine.
  if (report) {
    if (id === 't-modeles') renderModels();
    if (id === 't-clim') renderClimatology();
    if (id === 't-methode') renderMethod();
  }
}
function setupTabs() {
  const tabs = [...document.querySelectorAll('#tabs [role=tab]')];
  tabs.forEach((b, i) => {
    b.addEventListener('click', () => activateTab(b.id));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      activateTab(n.id);
      n.focus();
    });
  });
}

// ---------------------------------------------------------------- jour par jour
function statCard(title, rows, note) {
  return h('div', { class: 'card' },
    h('h3', {}, title),
    h('dl', { class: 'kv', style: 'margin-top:8px' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    note ? h('p', { class: 'small muted' }, note) : null);
}

function cellClass(value, limit) {
  if (value == null) return null;
  if (value > limit) return 'bad-cell';
  if (value > limit * 0.8) return 'warn-cell';
  return null;
}

function meteogram(d) {
  const hr = d.hourly;
  if (!hr?.hours?.length || !hr.pFly?.some((x) => x != null)) return h('p', { class: 'muted' }, 'Aucun ensemble ne couvre encore cette journée heure par heure.');
  const win = (hh) => hh >= 9 && hh <= 13;
  const head = h('tr', {}, h('th', {}, 'Heure'), hr.hours.map((hh) => h('th', { class: `h ${win(hh) ? 'win' : ''}` }, `${hh} h`)));
  const row = (label, cells, title) => h('tr', {}, h('th', { title }, label), cells);
  const rows = [
    row('Heure volable', hr.hours.map((hh, j) => {
      const p = hr.pFly[j];
      const c = heat(p);
      return h('td', { class: 'heat', style: `background:${c.bg};color:${c.fg}` }, p == null ? '—' : fr(p * 100));
    }), 'Part des trajectoires où l’heure est volable (%)'),
    row('Vent moyen', hr.hours.map((hh, j) => h('td', { class: `${cellClass(hr.ws[j]?.[1], LIMITS.wind) ?? ''} ${win(hh) ? 'win' : ''}`, title: hr.ws[j] ? `P10 ${fr(hr.ws[j][0])} · P90 ${fr(hr.ws[j][2])} km/h` : null }, fr(hr.ws[j]?.[1]))), 'Médiane, km/h, échelle station'),
    row('Rafales', hr.hours.map((hh, j) => h('td', { class: `${cellClass(hr.wg[j]?.[1], LIMITS.gust) ?? ''} ${win(hh) ? 'win' : ''}`, title: hr.wg[j] ? `P90 ${fr(hr.wg[j][2])} km/h` : null }, fr(hr.wg[j]?.[1]))), 'Médiane, km/h'),
    row('Direction', hr.hours.map((hh, j) => {
      const dir = hr.wd[j];
      return h('td', { class: win(hh) ? 'win' : null, title: dir == null ? null : `vent de ${sector(dir)} (${dir}°)` }, dir == null ? '—' : h('span', { class: 'arrow', style: `transform:rotate(${dir}deg)` }, '↓'));
    }), 'Flèche = sens vers lequel souffle le vent'),
    row('Pluie', hr.hours.map((hh, j) => h('td', { class: win(hh) ? 'win' : null }, hr.pRain[j] == null ? '—' : `${fr(hr.pRain[j] * 100)}`)), 'Probabilité de pluie ≥ 0,2 mm (%)'),
    row('Nuages', hr.hours.map((hh, j) => h('td', { class: win(hh) ? 'win' : null }, fr(hr.cc[j]?.[1]))), 'Nébulosité totale médiane (%)'),
    row('Nuages bas', hr.hours.map((hh, j) => h('td', { class: win(hh) ? 'win' : null }, fr(hr.ccl[j]?.[1]))), 'Médiane (%) — modèles qui la fournissent'),
    row('Température', hr.hours.map((hh, j) => h('td', { class: win(hh) ? 'win' : null }, fr(hr.t[j]?.[1]))), '°C au déco (828 m)'),
    row('Ressenti', hr.hours.map((hh, j) => h('td', { class: win(hh) ? 'win' : null }, fr(hr.at[j]?.[1]))), '°C'),
    row('Vent 850 hPa', hr.hours.map((hh, j) => h('td', { class: `${cellClass(hr.ws850[j]?.[1], LIMITS.wind850) ?? ''} ${win(hh) ? 'win' : ''}` }, fr(hr.ws850[j]?.[1]))), 'Vers 1 500 m, km/h'),
  ];
  return h('div', { class: 'scroll-x' }, h('table', { class: 'meteogram' }, h('thead', {}, head), h('tbody', {}, rows)));
}

function detTable(d) {
  const rows = d.det.filter((m) => m.cover || m.tMax != null);
  if (!rows.length) return h('p', { class: 'muted' }, 'Aucun modèle déterministe n’atteint encore cette journée (AROME : 42 h, ARPEGE : 4 j, ICON : 7,5 j, ECMWF et GFS : 15-16 j).');
  return h('div', { class: 'scroll-x' }, table(
    ['Modèle', 'Run', 'Matinée', 'T mini / maxi', 'Vent matin', 'Rafales', 'Pluie matin / jour', 'Nuages bas', 'Base', 'Sommet couche humide', 'Couche limite 14 h', 'Pression', 'Z500', 'T850', 'Vent 850', 'Gradient 9 h', 'Brouillard vallée', 'Cause'],
    rows.map((m) => [
      `${m.label} (${m.res})`,
      m.run ? fmtWhen(m.run, { weekday: undefined, hour: '2-digit' }) : '—',
      m.P == null ? 'hors portée' : fmtPct(m.P),
      `${fr(m.tMin, 1)} / ${fr(m.tMax, 1)} °C`,
      m.morning?.ws == null ? '—' : `${fr(m.morning.ws)} km/h ${sector(m.morning.wd)}`,
      m.morning?.wg == null ? '—' : `${fr(m.morning.wg)} km/h`,
      `${fr(m.rrMorning, 1)} / ${fr(m.rrDay, 1)} mm`,
      m.cclMorning == null ? '—' : `${fr(m.cclMorning)} %`,
      m.base10 == null ? '—' : `${fr(m.base10)} m`,
      m.moistTop == null ? '—' : `${fr(m.moistTop)} m`,
      m.blh14 == null ? '—' : `${fr(m.blh14)} m sol`,
      m.mslp == null ? '—' : `${fr(m.mslp)} hPa`,
      m.z500 == null ? '—' : `${fr(m.z500)} m`,
      m.t850 == null ? '—' : `${fr(m.t850, 1)} °C`,
      m.ws850 == null ? '—' : `${fr(m.ws850)} km/h ${sector(m.wd850)}`,
      m.lapse9 == null ? '—' : `${fr(m.lapse9, 2)} °C/100 m${m.lapse9 > 0 ? ' (inversion)' : ''}`,
      m.valleyFogHours == null ? '—' : `${m.valleyFogHours} h`,
      m.lim ? LIM_LABEL[m.lim] : m.P == null ? '—' : 'volable',
    ]),
    [false, false, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, false],
  ));
}

function renderDayDetail() {
  const r = report;
  const d = r.days[selectedDay];
  const s = d.stats;
  const c = r.climatology;
  const n = c.normals.window;
  const box = $('p-jour');
  const risks = Object.entries(d.limiting ?? {}).sort((a, b) => b[1] - a[1]);
  const fams = familyShares(d.regimes).filter((f) => f.p > 0).sort((a, b) => b.p - a.p);
  box.replaceChildren(
    h('div', { class: 'chips', style: 'margin-bottom:12px' }, r.days.map((x, i) => h('button', { class: 'theme-btn', type: 'button', 'aria-pressed': String(i === selectedDay), style: i === selectedDay ? 'border-color:var(--accent);color:var(--ink)' : '', onclick: () => selectDay(i) }, shortDay(x.label)))),
    h('h3', { style: 'font-size:1.25rem' }, `${d.label.charAt(0).toUpperCase()}${d.label.slice(1)} — ${fmtPct(d.p)} de chances de voler le matin`),
    h('p', { class: 'ink2' }, d.observed != null
      ? `Matinée signalée dans l'issue d'alertes : ${d.observed ? 'volée' : 'pas volée'}. Elle compte pour ${d.observed ? '1' : '0'} dans le calcul.`
      : d.pModel == null
      ? `Aucun modèle ne couvre encore cette matinée : c'est la climatologie (${fmtPct(d.pClim)}) qui parle.`
      : `Modèles ${fmtPct(d.pModel)} (poids ${fmtPct(d.a)}, échéance ${fr(d.lead, 1)} j) combinés à la normale ${fmtPct(d.pClim)}. ${d.contrib.length} système(s) : ${d.contrib.map((x) => `${x.label} ${fmtPct(x.p)}`).join(', ')}.`),
    h('div', { class: 'grid-3', style: 'margin-top:12px' },
      statCard('Températures', [
        ['Déco mini / maxi', s.tMin ? `${qr(s.tMin, 1, ' °C')} / ${qr(s.tMax, 1, ' °C')}` : '—'],
        ['Normales à 828 m', `${fr(d.anom.normTn, 1)} / ${fr(d.anom.normTx, 1)} °C`],
        ['Écart à la normale', d.anom.tMax == null ? '—' : `${d.anom.tMin > 0 ? '+' : ''}${fr(d.anom.tMin, 1)} / ${d.anom.tMax > 0 ? '+' : ''}${fr(d.anom.tMax, 1)} °C`],
        ['Vallée (Millau-Plage)', d.valley.tMin == null ? '—' : `${fr(d.valley.tMin, 1)} / ${fr(d.valley.tMax, 1)} °C`],
        ['Gradient vallée → déco', d.valley.gradient15 == null ? '—' : `${fr(d.valley.gradient15, 2)} °C/100 m l'après-midi`],
        ['Ressenti 10 h / 15 h', `${q(s.at10, 1, ' °C')} / ${q(s.at15, 1, ' °C')}`],
        ['Sous voile à 35 km/h', q(s.chill10, 1, ' °C')],
      ], `Vallée : ${d.valley.source}.`),
      statCard('Nuages et brouillard', [
        ['Nébulosité le matin', q(s.ccMorning, 0, ' %')],
        ['Nuages bas le matin', q(s.cclMorning, 0, ' %')],
        ['Base des nuages à 10 h', s.base10 ? `${qr(s.base10, 0, ' m')}` : '—'],
        ['Brouillard de vallée', fmtPct(s.fog)],
        ['Normale brouillard (station)', `${fmtPct(c.occurrences.fog)} des jours`],
      ], 'Base = altitude du niveau de condensation calculé au déco (125 m par degré d’écart T − Td). Le brouillard de vallée retarde surtout le début de séance.'),
      statCard('Précipitations', [
        ['Pluie pendant la matinée', fmtPct(s.pRainMorning)],
        ['Journée ≥ 1 mm / ≥ 10 mm', `${fmtPct(s.pRain1)} / ${fmtPct(s.pRain10)}`],
        ['Cumul du jour', s.rrDay ? `${fr(s.rrDay[1], 1)} mm (P90 ${fr(s.rrDay[2], 1)})` : '—'],
        ['Part convective', s.shShare == null ? '—' : fmtPct(s.shShare)],
        ['CAPE max (médiane / P90)', s.capeMax ? `${fr(s.capeMax[1])} / ${fr(s.capeMax[2])} J/kg` : '—'],
        ['Aigoual ≥ 50 mm/24 h', fmtPct(s.pAig50)],
        ['Normale : jours ≥ 1 mm', fmtPct(n.pRain1)],
      ], 'Signal cévenol = pluies intenses sur l’Aigoual en flux de sud-est.'),
    ),
    h('div', { class: 'grid-2', style: 'margin-top:12px' },
      h('div', { class: 'card' },
        h('h3', {}, 'Vent par période'),
        h('div', { class: 'scroll-x' }, table(['Période', 'Vent moyen', 'Rafales (méd. / P90)', 'Direction', 'Pluie'],
          [['Matin', 'morning'], ['Après-midi', 'afternoon'], ['Soir', 'evening']].map(([lab, key]) => {
            const p = s[key];
            return [lab, p?.ws ? `${fr(p.ws[1])} km/h (${fr(p.ws[0])}-${fr(p.ws[2])})` : '—', p?.wg ? `${fr(p.wg[1])} / ${fr(p.wg[2])} km/h` : '—', p?.wd == null ? '—' : `${sector(p.wd)}${p.R != null && p.R < 0.5 ? ' (dispersé)' : ''}`, p?.rr ? `${fr(p.rr[1], 1)} mm (P90 ${fr(p.rr[2], 1)})` : '—'];
          }), [false, true, true, false, true])),
        h('p', { class: 'small muted' }, `Matin 9-13 h, après-midi 13-18 h, soir 18-21 h. Rose du matin : ${Object.entries(d.rose ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmtPct(v)}`).join(' · ') || '—'}. Vent à 850 hPa : ${q(s.ws850, 0, ' km/h')} du ${sector(s.wd850)}.`),
        h('p', { class: 'small muted' }, `Limites « élèves » (échelle station) : vent ≤ ${LIMITS.wind} km/h, rafales ≤ ${LIMITS.gust} km/h, pas de vent d'est au-delà de ${LIMITS.calm} km/h, vent à 1 500 m ≤ ${LIMITS.wind850} km/h.`)),
      h('div', { class: 'card' },
        h('h3', {}, 'Ce qui peut empêcher de voler'),
        risks.length ? h('dl', { class: 'kv', style: 'margin-top:8px' }, risks.flatMap(([k, v]) => [h('dt', {}, LIM_LABEL[k] ?? k), h('dd', {}, fmtPct(v))])) : h('p', { class: 'muted' }, 'Aucune trajectoire non volable.'),
        h('p', { class: 'small muted' }, 'Part des trajectoires où la matinée est non volable, par cause principale.'),
        h('h3', { style: 'margin-top:12px' }, 'Situations possibles'),
        h('div', { class: 'chips', style: 'margin-top:6px' }, fams.map((f) => h('span', { class: 'chip' }, h('i', { style: `background:var(${FAMILIES[f.id].color})` }), `${FAMILIES[f.id].label} ${fmtPct(f.p)}${f.pFly != null ? ` · vol ${fmtPct(f.pFly)}` : ''}`)))),
    ),
    h('h3', { style: 'margin:20px 0 8px' }, 'Heure par heure — ensembles combinés'),
    h('p', { class: 'small muted' }, 'Médianes pondérées de tous les ensembles qui couvrent la journée ; vent et rafales ramenés à l’échelle de la station. Colonnes teintées : la matinée de vol. Survole une case pour les quantiles.'),
    meteogram(d),
    h('h3', { style: 'margin:20px 0 8px' }, 'Modèles déterministes'),
    detTable(d),
  );
}

// ---------------------------------------------------------------- analyse
const STATIC_AEROLOGY = [
  ['Relief', "Millau est au confluent du Tarn et de la Dourbie, vers 350-370 m, encaissé de 400 à 500 m sous les Grands Causses : Causse Noir à l'est (Pouncho d'Agast, 828 m), Larzac au sud (Brunas), Causse de Sauveterre au nord (Novis). La station Météo-France de Millau est sur le plateau, à 712 m."],
  ['Les décollages de l\'école', "Pouncho d'Agast : décollages sud, ouest, nord-ouest et nord sur la rupture de pente du Causse Noir, atterrissage à Millau-Plage (500 m de dénivelé). Brunas : vent du nord. Novis et Pic d'Andan : vent de sud-est soutenu. Aucun décollage n'est orienté nord-est à est : c'est le seul secteur rédhibitoire dès que le vent souffle."],
  ['Matinées d\'octobre', "Après une nuit claire, l'air froid s'accumule au fond du Tarn : inversion, parfois brouillard ou stratus qui se lèvent en fin de matinée. Le déco peut être au soleil au-dessus d'une mer de nuages alors que l'atterrissage est bouché : cela retarde la séance plus qu'il ne l'annule. Les thermiques restent faibles le matin, ce qui convient bien au perfectionnement."],
  ['Flux de sud-est (vent du Midi, marin)', "C'est le vent le plus fréquent le matin à la station (environ un quart des heures du 8 au 19 octobre, 24 km/h en moyenne). L'air méditerranéen monte sur les Cévennes et l'Aigoual, où il se décharge de son humidité ; Millau, sous le vent, reste souvent sec mais venté et turbulent (effet de foehn, parenté avec le vent d'autan du Tarn et du Lauragais). Au-delà d'une vingtaine de km/h, la séance élève devient improbable ; en dessous, Novis et le Pic d'Andan sont pratiqués."],
  ['Épisodes méditerranéens et cévenols', "Septembre à novembre est leur saison de pointe : un flux de sud à sud-est chaud et humide bute sur les Cévennes et déverse des cumuls extrêmes côté Gard, Lozère et Hérault. Millau, côté atlantique du Larzac, est moins arrosé, mais les pluies et les nuages bas débordent sur les causses et le vent de sud-est y souffle fort : journée perdue dans les deux cas. Le site suit la part des trajectoires qui donnent plus de 50 mm en 24 h sur l'Aigoual."],
  ['Flux de nord à nord-ouest', "Tramontane et mistral côté Languedoc : air sec, ciel limpide, mais vent fort et rafaleux sur les plateaux, rotors sous le vent des rebords de causse. Brunas et le Pouncho nord fonctionnent tant que le vent reste modéré."],
  ['Flux d\'ouest à sud-ouest', "Vent de face au Pouncho ouest, dynamique sur la falaise, mais souvent associé au passage des perturbations atlantiques : pluie et plafonds bas."],
];

function renderAnalysis() {
  const a = report.analysis;
  const sec = (title, paras) => (paras?.length ? [h('h3', {}, title), ...paras.map((p) => h('p', {}, p))] : []);
  $('p-analyse').replaceChildren(h('div', { class: 'prose' },
    h('p', { class: 'small muted' }, `Analyse rédigée automatiquement à partir des données de la dernière mise à jour (${fmtWhen(report.generatedAt)}).`),
    ...sec('Synthèse', a.summary),
    ...sec('Situation synoptique et anomalies', a.synoptic),
    ...sec('Vent', a.wind),
    ...sec('Précipitations', a.rain),
    ...sec('Nuages, plafonds et brouillard', a.clouds),
    ...sec('Températures et gradient vallée-plateau', a.temps),
    ...sec('Dispersion et écarts entre centres', a.spread),
    ...sec('Ce qui fera bouger l’aiguille', a.next),
    h('h3', {}, 'Aérologie locale : Causses et vallée du Tarn'),
    ...STATIC_AEROLOGY.map(([t, p]) => h('p', {}, h('b', {}, `${t}. `), p)),
  ));
}

// ---------------------------------------------------------------- ensembles et modèles
function coverNote(s) {
  const day = (iso) => fmtWhen(iso, { hour: undefined, minute: undefined });
  const future = (iso) => iso && Date.parse(iso) > Date.now();
  if (s.cover.every(Boolean)) {
    if (!s.nextUpdate) return 'couvre tout le stage';
    return future(s.nextUpdate) ? `prochain run vers ${fmtWhen(s.nextUpdate, { weekday: undefined })}` : 'nouveau run attendu';
  }
  if (!s.entry) return '';
  if (!s.cover[0] && future(s.entry.first)) return `atteindra le 12 vers le ${day(s.entry.first)}, tout le stage vers le ${day(s.entry.all)}`;
  if (future(s.entry.all)) return `tout le stage vers le ${day(s.entry.all)}`;
  return 'couverture imminente';
}

function renderModels() {
  const r = report;
  const box = $('p-modeles');
  const ens = r.systems.filter((s) => s.kind === 'ens');
  const det = r.systems.filter((s) => s.kind === 'det');
  const sysTable = (list) => h('div', { class: 'scroll-x' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Système', 'Membres', 'Dernier run utile', ...r.days.map((d) => shortDay(d.label)), '3 matinées (seul)', 'Poids', 'Suite'].map((x, i) => h('th', { class: i >= 3 && i < 7 ? 'n' : null }, x)))),
    h('tbody', {}, list.map((s) => h('tr', {},
      h('td', {}, h('b', {}, s.label), h('br'), h('span', { class: 'small muted' }, `${s.provider} · ${s.res} · ${s.horizon}`)),
      h('td', { class: 'n' }, String(s.members ?? 1)),
      h('td', {}, s.run?.init ? fmtWhen(s.run.init, { weekday: undefined }) : '—'),
      ...s.pDays.map((p, i) => {
        if (!s.cover[i] || p == null) return h('td', { class: 'heat muted' }, '·');
        const c = heat(p);
        return h('td', { class: 'heat', style: `background:${c.bg};color:${c.fg}` }, fmtPct(p));
      }),
      h('td', { class: 'n' }, s.pStage == null ? '—' : fmtPct(s.pStage)),
      h('td', { class: 'n' }, s.weight ? fr(s.weight, 2) : '—'),
      h('td', { class: 'small' }, coverNote(s))),
    ))));
  const regimeRows = r.days.map((d) => ({ label: shortDay(d.label), parts: d.regimes.length ? familyShares(d.regimes) : [] }));
  const regBox = h('div');
  const clusters = r.scenarios.map((sc, i) => h('div', { class: 'card cluster' },
    h('div', { class: 'small muted' }, `Trajectoire ${'ABCD'[i]}`),
    h('div', { class: 'cw' }, fmtPct(sc.p), h('span', { class: 'small muted', style: 'font-weight:400' }, ' des membres')),
    h('div', { class: 'cells4' }, sc.days.map((x, j) => {
      const c = heat(x.p);
      return h('div', { style: `background:${c.bg};color:${c.fg}`, title: `${REGIMES[x.regime]?.label} · ${x.mslp} hPa · ${x.ws} km/h ${sector(x.wd)} · ${x.rr} mm` }, h('b', {}, shortDay(r.days[j].label).split(' ')[0].slice(0, 3)), h('br'), fmtPct(x.p));
    })),
    h('div', { class: 'small' }, sc.days.map((x) => REGIMES[x.regime]?.label ?? x.regime).join(' → ')),
    h('div', { class: 'small ink2' }, `${r.stage.sessionsNeeded} matinées volables : ${fmtPct(sc.pStage)} · ${Object.entries(sc.systems).map(([k, v]) => `${r.systems.find((s) => s.id === k)?.short ?? k} ${fmtPct(v)}`).join(', ')}`),
  ));
  const patterns = r.patterns.map((p) => [p.code.split('').map((x) => (x === '1' ? '✔' : '✘')).join(' '), p.code.split('').filter((x) => x === '1').length, fmtPct(p.p)]);
  box.replaceChildren(
    h('p', { class: 'ink2' }, `${ens.filter((s) => s.cover.some(Boolean)).length} ensembles et ${det.filter((s) => s.cover.some(Boolean)).length} modèles déterministes couvrent au moins une matinée. Chaque case donne la probabilité de matinée volable selon ce système seul, avant mélange avec la climatologie.`),
    h('h3', { style: 'margin:14px 0 8px' }, 'Ensembles'),
    sysTable(ens),
    h('h3', { style: 'margin:18px 0 8px' }, 'Modèles déterministes'),
    sysTable(det),
    h('div', { class: 'card chart', style: 'margin-top:18px' },
      h('figure', {},
        h('figcaption', {}, h('b', {}, 'Régimes météo par journée'), ' — part pondérée des trajectoires de tous les systèmes.'),
        regBox,
        h('div', { class: 'legend' }, Object.values(FAMILIES).map((f) => h('span', {}, h('i', { style: `background:var(${f.color})` }), f.label))),
        h('details', { class: 'table-view' }, h('summary', {}, 'Voir en tableau'), table(['Journée', ...Object.values(FAMILIES).map((f) => f.label)], regimeRows.map((row) => [row.label, ...Object.keys(FAMILIES).map((id) => fmtPct(row.parts.find((p) => p.id === id)?.p ?? null))]))))),
    h('h3', { style: 'margin:18px 0 6px' }, 'Trajectoires (regroupement des membres)'),
    h('p', { class: 'small muted' }, 'Membres des ensembles couvrant les 4 jours, regroupés par k-moyennes sur la pression, le vent et la pluie de chaque journée. Couleur des cases = probabilité de matinée volable.'),
    r.scenarios.length ? h('div', { class: 'grid-2' }, clusters) : h('p', { class: 'muted' }, 'Pas encore assez d’ensembles couvrant les 4 jours.'),
    h('h3', { style: 'margin:18px 0 6px' }, 'Combinaisons les plus probables (12 · 13 · 14 · 15)'),
    table(['Matinées', 'Volables', 'Probabilité'], patterns, [false, true, true]),
  );
  regimeBars(regBox, regimeRows, FAMILIES);
}

// ---------------------------------------------------------------- climatologie
function renderClimatology() {
  const c = report.climatology;
  const box = $('p-clim');
  const norm = (x) => [x.days === 'octobre' ? `Octobre ${x.period}` : `${x.days} ${x.period}`, `${fr(x.tx.mean, 1)} °C (σ ${fr(x.tx.sd, 1)})`, `${fr(x.tn.mean, 1)} °C (σ ${fr(x.tn.sd, 1)})`, `${fr(x.tx.p10, 1)} / ${fr(x.tx.p90, 1)}`, fmtPct(x.pRain1), fmtPct(x.pRain10), `${fr(x.ffm)} km/h`, `${fr(x.fxi)} km/h`, fmtPct(x.pGust58)];
  const roseBox = h('div');
  const strip = h('div', { class: 'strip', role: 'table', 'aria-label': 'Matinées du 12 au 15 octobre, 1993-2025' },
    h('div', { class: 'y' }), ...['12', '13', '14', '15'].map((d) => h('div', { class: 'muted' }, d)),
    ...[...c.strip].reverse().flatMap((row) => [
      h('div', { class: 'y' }, String(row.year)),
      ...row.days.map((x) => (x == null ? h('div', { class: 'na' }, '?') : h('div', { class: x.ok ? 'ok' : 'ko', title: x.ok ? 'volable' : `non volable : ${LIM_LABEL[x.lim] ?? x.lim}` }, x.ok ? '✔' : LIM_SHORT[x.lim] ?? '✘'))),
    ]));
  const yearsOk = c.strip.filter((r) => r.days.filter((x) => x?.ok).length >= report.stage.sessionsNeeded).length;
  box.replaceChildren(
    h('p', { class: 'ink2' }, `Station Météo-France de Millau (12145001, 712 m, 44°07′N 3°01′E), données ouvertes. Matinée volable = au moins 2 h d'affilée volables entre 9 h et 13 h selon les mêmes critères que les prévisions. Sur ${c.period}, ${c.window} : ${fmtPct(c.pMorning)} des matinées sont volables, et 3 matinées sur 4 consécutives le sont ${fmtPct(c.pAtLeast[2])} du temps. Le temps persiste : après une matinée volable, la suivante l'est à ${fmtPct(c.pFlyAfterFly)}, contre ${fmtPct(c.pFlyAfterNoFly)} après une matinée perdue.`),
    h('div', { class: 'grid-2', style: 'margin-top:12px' },
      h('div', { class: 'card' },
        h('h3', {}, `Les 12-15 octobre de ${c.strip[0].year} à ${c.strip.at(-1).year}`),
        h('p', { class: 'small muted' }, `Tes ${report.stage.sessionsNeeded} séances auraient pu voler ${yearsOk} années sur ${c.strip.length}. Case bleue = matinée volable ; sinon, la cause principale.`),
        strip),
      h('div', { class: 'card chart' },
        h('figure', {},
          h('figcaption', {}, h('b', {}, 'Rose des vents des matinées'), ` (9-13 h, ${c.window}, ${c.period}) : longueur = fréquence du secteur, partie foncée = heures volables.`),
          roseBox,
          h('details', { class: 'table-view' }, h('summary', {}, 'Voir en tableau'), table(['Secteur', 'Fréquence', 'Vent moyen', 'Volables'], c.windRose.sectors.map((s) => [s.sector, fmtPct(s.freq), `${fr(s.ws)} km/h`, fmtPct(s.fly)]), [false, true, true, true]))))),
    h('h3', { style: 'margin:18px 0 8px' }, 'Normales de la station (données quotidiennes)'),
    h('div', { class: 'scroll-x' }, table(['Période', 'T maxi', 'T mini', 'T maxi P10 / P90', 'Jours ≥ 1 mm', 'Jours ≥ 10 mm', 'Vent moyen', 'Rafale max moy.', 'Rafales ≥ 58 km/h'], [norm(c.normals.october), norm(c.normals.window), norm(c.normals.windowRecent)], [false, true, true, true, true, true, true, true, true])),
    h('p', { class: 'small muted' }, `Octobre 1991-2020 : ${fr(c.normals.october.rrMonth, 1)} mm en moyenne. Records du 12 au 15 octobre depuis ${c.normals.records.since} : ${fr(c.normals.records.txMax.value, 1)} °C (${c.normals.records.txMax.date}), ${fr(c.normals.records.tnMin.value, 1)} °C (${c.normals.records.tnMin.date}), ${fr(c.normals.records.rrMax.value, 1)} mm en 24 h (${c.normals.records.rrMax.date}), rafale ${fr(c.normals.records.fxiMax.value)} km/h (${c.normals.records.fxiMax.date}). Ces calculs retrouvent les valeurs de la fiche climatologique officielle (Tx 15,8 °C, Tn 8,4 °C, 74,4 mm en octobre).`),
    h('div', { class: 'grid-3', style: 'margin-top:12px' },
      statCard('Vallée ou plateau', [
        ['Station de vallée', `${c.valley.station}`],
        ['Maxi vallée − plateau', `+${fr(c.valley.dTx, 1)} °C`],
        ['Mini vallée − plateau', `+${fr(c.valley.dTn, 1)} °C`],
        ['Matins d’inversion', fmtPct(c.valley.pInversion)],
      ], `Octobre ${c.valley.years}, ${c.valley.n} jours communs : l'après-midi suit le gradient standard (−${fr((c.valley.dTx / 344) * 100, 2)} °C/100 m), le matin l'inversion l'annule souvent.`),
      statCard('Phénomènes (8-19 oct.)', [
        ['Brouillard', fmtPct(c.occurrences.fog)],
        ['Brume', fmtPct(c.occurrences.mist)],
        ['Orage', fmtPct(c.occurrences.thunder)],
        ['Aigoual ≥ 50 mm/24 h (octobre)', fmtPct(c.aigoual.p50)],
      ], `Station de Millau, ${c.occurrences.period} ; Aigoual : ${c.aigoual.period}, cumuls extrêmes sous-estimés par ERA5.`),
      statCard('Références d’altitude', [
        ['Pression mer (ERA5)', `${fr(c.era5.mslp.mean, 1)} hPa (σ ${fr(c.era5.mslp.sd, 1)})`],
        ['Géopotentiel 500 hPa', `${fr(c.upper.z500.mean)} m (σ ${fr(c.upper.z500.sd)})`],
        ['T 850 hPa', `${fr(c.upper.t850.mean, 1)} °C (σ ${fr(c.upper.t850.sd, 1)})`],
      ], `Pression : ${c.era5.window} ${c.era5.period}. Altitude : ${c.upper.ref}.`),
    ),
  );
  windRose(roseBox, c.windRose.sectors, c.windRose.calm);
}

// ---------------------------------------------------------------- méthode et sources
function renderMethod() {
  const c = report.climatology;
  const cal = c.calibration;
  const relBox = h('div');
  const weights = [...ENSEMBLES, ...DETERMINISTIC].map((s) => [s.label, s.provider, s.res, s.horizon, fr(s.weight, 1) + (s.weightWhenCovered ? ` (${fr(s.weightWhenCovered, 1)} quand l'ENS couvre)` : '')]);
  const aRows = [1, 3, 5, 7, 9, 10, 11, 13, 15, 17].map((L) => [`${L} j`, fmtPct(1 / (1 + Math.exp((L - LEAD.l50) / LEAD.scale)))]);
  const link = (href, text) => h('a', { href, rel: 'noopener' }, text);
  {
    $('p-methode').replaceChildren(h('div', { class: 'prose' },
      h('h3', {}, '1. Qu’est-ce qu’une matinée volable ?'),
      h('p', {}, `Fly Millau vole le matin : une matinée compte si au moins 2 heures d'affilée sont volables entre 9 h et 13 h. Une heure est volable si : pluie < ${fr(LIMITS.rain, 1)} mm, vent moyen ≤ ${LIMITS.wind} km/h, rafales ≤ ${LIMITS.gust} km/h, pas de vent de nord-est à est au-delà de ${LIMITS.calm} km/h (aucun décollage orienté ainsi), pas de nuage ni de brouillard au déco, pas d'orage, vent à 850 hPa ≤ ${LIMITS.wind850} km/h. Ces seuils « élèves en perfectionnement » sont exprimés à l'échelle de l'anémomètre de la station de Millau ; ils restent à valider avec un moniteur.`),
      h('p', {}, `Sites de l'école pris en compte : ${SITES.map((s) => `${s.name} (${s.alt} m, ${s.orient.join('/')})`).join(', ')}.`),
      h('h3', {}, '2. Des vents de modèles aux vents de la station'),
      h('p', {}, `Un modèle à 25 km lisse le relief : ERA5 ne dépasse 18,6 km/h qu'aussi souvent que la station dépasse 22 km/h. Les vents des modèles grossiers sont multipliés par 1,18 et leurs rafales par 0,89 (appariement des quantiles sur les matinées d'octobre 1993-2025) ; les modèles fins (≤ 2,5 km) ne sont pas corrigés. Sans rafale fournie (AIFS, WeatherNext, AI-GEFS, GEPS), elle est estimée à ${fr(c.gustFromWind.a, 1)} + ${fr(c.gustFromWind.b, 2)} × vent (régression sur ${c.gustFromWind.n} heures d'observation).`),
      h('h3', {}, '3. Calibration sur 33 ans d’observations'),
      h('p', {}, `Chaque trajectoire reçoit une « marge de vol » (0 = à la limite). Une régression logistique apprise sur ${cal.n} matinées d'octobre (${cal.period}) transforme la marge calculée sur ERA5 en probabilité que la station ait réellement été volable : α = ${fr(cal.alpha, 3)}, β = ${fr(cal.beta, 3)}. Score de Brier ${fr(cal.brier, 3)} contre ${fr(cal.brierClim, 3)} pour la climatologie (gain ${fmtPct(cal.bss)}). Même une prévision parfaite à 25 km ne dit pas tout : quand ERA5 annonce une matinée volable, la station l'a été ${fmtPct(cal.pStationGivenModelFly)} du temps.`),
      h('div', { class: 'card chart', style: 'max-width:340px' }, h('figure', {}, h('figcaption', {}, h('b', {}, 'Fiabilité de la calibration'), ' : prévu contre observé, taille = nombre de matinées.'), relBox)),
      h('h3', {}, '4. Mélange avec la climatologie selon l’échéance'),
      h('p', {}, `Au-delà d'une dizaine de jours, les modèles n'ont presque plus de compétence pour une matinée donnée. Pour chaque matinée, probabilité = a(L) × modèles + (1 − a(L)) × normale, avec a(L) = 1 / (1 + e^((L − ${LEAD.l50}) / ${LEAD.scale})), L = échéance du run le plus récent.`),
      table(['Échéance', 'Poids des modèles'], aRows, [false, true]),
      h('h3', {}, '5. Pondération des systèmes'),
      h('div', { class: 'scroll-x' }, table(['Système', 'Centre', 'Résolution', 'Portée', 'Poids'], weights, [false, false, false, false, true])),
      h('p', { class: 'small muted' }, 'Poids réduit de 15 % sans rafales fournies et de 10 % sans humidité. Un système ne pèse que les jours où il couvre toute la matinée.'),
      h('h3', {}, '6. Des matinées au stage'),
      h('p', {}, `${report.samples.toLocaleString('fr-FR')} trajectoires de 4 matinées sont tirées : un système (au prorata de son poids), un de ses membres, et une fenêtre de 4 matinées réellement observées à Millau. Un seul tirage décide, jour par jour, si l'on suit le modèle ou la climatologie, ce qui conserve la persistance du temps. L'aiguille vaut 360 × P − 180, où P est la part des trajectoires qui donnent au moins ${report.stage.sessionsNeeded} matinées volables.`),
      h('h3', {}, '7. Mises à jour et alertes'),
      h('p', {}, `Toutes les 20 minutes, GitHub Actions lit l'heure du dernier run de chaque modèle sur Open-Meteo. Dès qu'un nouveau run atteint le stage, le système est retéléchargé, tout est recombiné, l'aiguille bouge et un point s'ajoute à l'historique. Si l'aiguille a bougé d'au moins ${report.stage.alertThreshold} points depuis la dernière alerte, un commentaire est posté sur l'issue d'alertes du dépôt (notification GitHub). Cette page revérifie toute seule toutes les 5 minutes.`),
      h('h3', {}, 'Sources'),
      h('ul', {},
        h('li', {}, link('https://open-meteo.com/en/docs/ensemble-api', 'Open-Meteo Ensemble API'), ' : ECMWF IFS ENS et AIFS ENS (', link('https://www.ecmwf.int/en/forecasts/datasets/open-data', 'données ouvertes ECMWF'), ', CC BY 4.0), ECMWF EC46, NOAA GEFS et AI-GEFS, ECCC GEPS, DWD ICON-EPS/EU-EPS/D2-EPS, UKMO MOGREPS-G, MeteoSwiss ICON-CH1/CH2-EPS, Google WeatherNext 2.'),
        h('li', {}, link('https://open-meteo.com/en/docs', 'Open-Meteo Forecast API'), ' : AROME HD et AROME, ARPEGE (Météo-France), ICON-D2 et ICON-EU (DWD), ECMWF IFS HRES et AIFS, GFS, GEM, UKMO, JMA.'),
        h('li', {}, link('https://www.data.gouv.fr/fr/datasets/donnees-climatologiques-de-base-horaires/', 'Météo-France, données climatologiques de base horaires'), ' et ', link('https://www.data.gouv.fr/fr/datasets/donnees-climatologiques-de-base-quotidiennes/', 'quotidiennes'), ' (Licence Ouverte 2.0) : station 12145001 Millau et 12208004 Saint-Affrique ; ', link('https://donneespubliques.meteofrance.fr/FichesClim/FICHECLIM_12145001.pdf', 'fiche climatologique de Millau'), '.'),
        h('li', {}, link('https://open-meteo.com/en/docs/historical-weather-api', 'ERA5 (Copernicus / ECMWF)'), ' via Open-Meteo : calibration, pression de référence, Aigoual ; ', link('https://open-meteo.com/en/docs/historical-forecast-api', 'analyses GFS 2021-2025'), ' pour le géopotentiel et T 850 hPa.'),
        h('li', {}, link('https://www.fly-millau-parapente.com/stage-perfectionnement-parapente-millau-12', 'Fly Millau : stage perfectionnement'), ' (3 ou 5 matinées) et ', link('https://www.fly-millau-parapente.com/', 'sites de vol'), ' ; FFVL : ', link('https://federation.ffvl.fr/sites_pratique/voir/25', 'Puncho d’Agast ouest'), ', ', link('https://federation.ffvl.fr/sites_pratique/voir/27', 'sud'), ', ', link('https://federation.ffvl.fr/terrain/13564', 'nord-ouest'), '.'),
      ),
      h('h3', {}, 'Pour vérifier d’un coup d’œil'),
      h('ul', {},
        h('li', {}, 'Balises FFVL en direct : ', link('https://www.balisemeteo.com/balise.php?idBalise=66', 'La Puncho d’Agast'), ' · ', link('https://www.balisemeteo.com/balise.php?idBalise=2930', 'Brunas'), '.'),
        h('li', {}, link('https://meteofrance.com/previsions-meteo-france/millau/12100', 'Météo-France Millau'), ' · ', link('https://www.meteociel.fr/previsions/3317/millau.htm', 'Météociel'), ' (', link('https://www.meteociel.fr/tendances/3317/millau.htm', 'tendances'), ', ', link('https://www.meteociel.fr/previsions-orage/3317/millau.htm', 'orages'), ') · ', link('https://www.meteoblue.com/fr/meteo/prevision/multimodel/millau_france_2993875', 'Meteoblue multimodèle'), ' · ', link('https://www.meteoblue.com/en/weather/forecast/multimodelensemble/millau_france_2993875', 'multimodèle ensembliste'), '.'),
        h('li', {}, link('https://fr.windfinder.com/forecast/millau_puncho_d_agast', 'Windfinder Puncho d’Agast'), ' · ', link('https://www.windy.com/44.110/3.101?44.110,3.101,10', 'Windy'), ' · ', link('https://www.ventusky.com/?p=44.11;3.10;9&l=wind-10m', 'Ventusky'), ' · ', link('https://www.keraunos.org/', 'Keraunos'), '.'),
        h('li', {}, 'ECMWF : ', link('https://charts.ecmwf.int/products/medium-z500-t850', 'Z500 et T850'), ' · ', link('https://charts.ecmwf.int/products/medium-t500-mean-spread', 'moyenne et dispersion de l’ENS'), ' · ', link('https://www.ecmwf.int/en/forecasts/documentation-and-support/extended-range/extended-forecast-graphical-products', 'produits de prévision étendue'), '.'),
      ),
      h('p', { class: 'small muted' }, 'Code, données et historique de chaque mise à jour : ', link('https://github.com/r69sy78sny-droid/stage-millau', 'dépôt GitHub'), '.'),
    ));
  }
  reliabilityChart(relBox, cal.reliability);
}

// ---------------------------------------------------------------- thème, démarrage
function setupTheme() {
  const btn = $('theme');
  const current = () => document.documentElement.dataset.theme ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const label = () => (btn.textContent = current() === 'dark' ? 'Mode clair' : 'Mode sombre');
  label();
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
    label();
    rerender();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    label();
    rerender();
  });
}
function rerender() {
  if (!report) return;
  gauge?.repaint();
  renderDist();
  renderHistory();
  renderModels();
  renderClimatology();
  renderMethod();
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => report && (renderDist(), renderHistory(), renderModels(), renderClimatology(), renderMethod()), 200);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

setupTheme();
setupTabs();
refresh(true).then(fetchLastCheck);
setInterval(() => refresh().then(fetchLastCheck), POLL_MS);
