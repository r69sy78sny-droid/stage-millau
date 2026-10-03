// Paraglidable : probabilité de vol par journée donnée par un réseau de neurones (pas de météo brute).
// Transforme data/paraglidable.json en « système » pour la combinaison, au même format que les autres.

import { STAGE, EXPERTS } from './config.js';
import { round } from './flyability.js';

export const PG = EXPERTS.find((e) => e.id === 'paraglidable');

const logit = (p) => Math.log(p / (1 - p));
const expit = (x) => 1 / (1 + Math.exp(-x));
const clip = (p) => Math.min(0.98, Math.max(0.02, p));

/** Avis Paraglidable (journée, tous pilotes) → probabilité de matinée volable pour l'élève. */
export function calibrateFly(fly, pClim, shrink = PG.shrink) {
  if (fly == null) return null;
  const c = logit(clip(pClim));
  return expit(c + shrink * (logit(clip(fly)) - c));
}

/** Réponse de l'API (version 1) → { date: { fly, XC } } pour le point demandé. */
export function parseApi(json, name = null) {
  const out = {};
  let spot = null;
  for (const [date, list] of Object.entries(json ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(list) || !list.length) continue;
    const item = (name && list.find((x) => x.name === name)) ?? list[0];
    if (item?.forecast?.fly == null) continue;
    spot = spot ?? { name: item.name, lat: item.lat, lon: item.lon };
    out[date] = { fly: round(item.forecast.fly, 4), XC: round(item.forecast.XC ?? null, 4) };
  }
  return { spot, days: out };
}

/** Système « IA » pour combine() : un seul membre, ne couvre que les journées publiées. */
export function summarizeParaglidable(pg, pClim) {
  if (!pg?.days) return null;
  const days = STAGE.dates.map((date) => {
    const v = pg.days[date];
    const p = v ? calibrateFly(v.fly, pClim) : null;
    return { date, cover: p != null, fly: v?.fly ?? null, XC: v?.XC ?? null, p: round(p, 4), P: round(p, 4) };
  });
  if (!days.some((d) => d.cover)) return null;
  return {
    id: PG.id, kind: 'ia', label: PG.label, short: PG.short, provider: PG.provider, res: PG.res, horizon: PG.horizon,
    run: { init: null, fetchedAt: pg.fetchedAt ?? null, changedAt: pg.changedAt ?? null }, nMembers: 1,
    cover: days.map((d) => d.cover),
    memberDays: [days.map((d) => [d.p, -1, null, null, null, null])],
    days,
  };
}

/** Date à partir de laquelle Paraglidable publie une journée (il prévoit aujourd'hui + 9 jours). */
export function firstAvailable(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - PG.horizonDays);
  return d.toISOString().slice(0, 10);
}
