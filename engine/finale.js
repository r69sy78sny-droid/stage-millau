// Bilan du stage une fois la dernière matinée passée : à partir des matinées signalées dans l'issue
// (« volé 12 », « pas volé 13 »), dit si le stage a eu lieu, n'a pas pu avoir lieu, ou reste à confirmer.

import { STAGE } from './config.js';

/** Fin de la dernière matinée : 13 h à Paris (11 h UTC en octobre). */
export const stageEndsAt = (dates = STAGE.dates) => Date.parse(`${dates.at(-1)}T11:00:00Z`);
export const stageOver = (now = Date.now(), dates = STAGE.dates) => now > stageEndsAt(dates);

/** observed : tableau de true / false / null (non signalée) pour chaque matinée. */
export function stageOutcome(observed, need = STAGE.sessionsNeeded) {
  const flown = observed.filter((x) => x === true).length;
  const missed = observed.filter((x) => x === false).length;
  const unknown = observed.length - flown - missed;
  let kind = 'attente';
  if (flown >= need) kind = 'reussi';
  else if (flown + unknown < need) kind = 'rate';
  return { kind, flown, missed, unknown, need };
}
