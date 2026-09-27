// Accès à Open-Meteo : heures des derniers runs, ensembles, modèles déterministes. Réessaie sur les
// erreurs passagères (503, quota à la minute), jamais sur une requête invalide.

import { API, STAGE, VARS } from '../engine/config.js';

const UA = { 'User-Agent': 'stage-millau/1.0 (GitHub Pages, usage non commercial)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url, { retries = 4, label = 'Open-Meteo' } = {}) {
  let last;
  for (let k = 0; k <= retries; k++) {
    try {
      const r = await fetch(url, { headers: UA });
      const text = await r.text();
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        throw Object.assign(new Error(`HTTP ${r.status} ${text.slice(0, 120)}`), { transient: true });
      }
      if (j.error) {
        const transient = r.status === 429 || r.status >= 500 || /limit|exceeded|timeout/i.test(j.reason ?? '');
        throw Object.assign(new Error(j.reason), { transient, status: r.status });
      }
      return j;
    } catch (e) {
      last = e;
      if (e.transient === false || (e.status && e.status < 500 && e.status !== 429)) break;
      if (k < retries) await sleep(e.status === 429 ? 61000 : 3000 * (k + 1));
    }
  }
  throw new Error(`${label} : ${last?.message}`);
}

/** Métadonnées d'un domaine (heure du dernier run, fin des données, fréquence). */
export async function getMeta(domain) {
  for (const host of ['api.open-meteo.com', 'ensemble-api.open-meteo.com']) {
    try {
      const r = await fetch(API.meta(host, domain), { headers: UA });
      if (!r.ok) continue;
      const j = await r.json();
      if (!j.last_run_initialisation_time) continue;
      return {
        domain,
        init: new Date(j.last_run_initialisation_time * 1000).toISOString(),
        available: new Date(j.last_run_availability_time * 1000).toISOString(),
        end: j.data_end_time ? new Date(j.data_end_time * 1000).toISOString() : null,
        interval: j.update_interval_seconds ?? null,
      };
    } catch {
      /* domaine suivant */
    }
  }
  return null;
}

export function ensembleUrl(sys, point, keys = sys.vars) {
  const hourly = keys.map((k) => VARS[k]).join(',');
  return `${API.ensemble}?latitude=${point.lat}&longitude=${point.lon}&elevation=${point.elevation}&hourly=${hourly}` +
    `&models=${sys.model}&timezone=Europe%2FParis&start_date=${STAGE.fetchStart}&end_date=${STAGE.fetchEnd}&wind_speed_unit=kmh`;
}

/** L'API Forecast refuse une date de fin au-delà d'aujourd'hui + 15 jours : on borne la fenêtre. */
export function forecastRange(now = Date.now()) {
  const max = new Date(now + 15 * 86400000).toISOString().slice(0, 10);
  const end = STAGE.fetchEnd < max ? STAGE.fetchEnd : max;
  return end < STAGE.fetchStart ? null : { start: STAGE.fetchStart, end };
}

export function forecastUrl(models, point, vars, range) {
  return `${API.forecast}?latitude=${point.lat}&longitude=${point.lon}&elevation=${point.elevation}&hourly=${vars.join(',')}` +
    `&models=${models.join(',')}&timezone=Europe%2FParis&start_date=${range.start}&end_date=${range.end}&wind_speed_unit=kmh`;
}
