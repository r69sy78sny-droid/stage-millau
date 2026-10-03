// Accès à l'API Paraglidable. La clé vient du secret GitHub PARAGLIDABLE_KEY et n'apparaît jamais
// dans les journaux : elle est masquée dans les messages d'erreur.

import { PG, parseApi } from '../engine/paraglidable.js';

const UA = { 'User-Agent': 'stage-millau/1.0 (GitHub Pages, usage non commercial)' };

export async function fetchParaglidable(key) {
  const hide = (msg) => String(msg).split(key).join('***');
  try {
    const r = await fetch(`${PG.url}?key=${encodeURIComponent(key)}&format=JSON&version=1`, { headers: UA, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const parsed = parseApi(JSON.parse(await r.text()));
    if (!Object.keys(parsed.days).length) throw new Error('réponse vide (clé invalide ?)');
    return parsed;
  } catch (e) {
    throw new Error(`Paraglidable : ${hide(e.message)}`);
  }
}

/** Fusionne une nouvelle réponse dans data/paraglidable.json ; `changed` = un jour du stage a bougé. */
export function mergeParaglidable(prev, fresh, stageDates, now) {
  const t = new Date(now).toISOString();
  const pick = (days) => Object.fromEntries(stageDates.filter((d) => days?.[d]).map((d) => [d, days[d].fly]));
  const before = pick(prev?.days);
  const after = pick(fresh.days);
  const changed = stageDates.some((d) => before[d] !== after[d]);
  const history = [...(prev?.history ?? [])];
  if (changed && Object.keys(after).length) history.push({ t, v: after });
  return {
    changed,
    data: { fetchedAt: t, changedAt: changed ? t : prev?.changedAt ?? t, spot: fresh.spot, days: fresh.days, history },
  };
}
