// Commande tapée dans l'issue d'alertes pendant le stage : « volé 12 », « pas volé 13 », « oublie 14 ».
// Met à jour data/observed.json ; la combinaison fixe alors la matinée (1 ou 0) au lieu de la prévoir.

import fs from 'node:fs';
import { STAGE } from '../engine/config.js';

const body = (process.env.BODY ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const file = 'data/observed.json';
const observed = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const re = /(pas vole|pas volee|vole|volee|oublie|annule)\s+(?:le\s+)?(1[2-5])\b/g;
let changed = [];
for (const [, verb, day] of body.matchAll(re)) {
  const date = STAGE.dates.find((d) => d.endsWith(`-${day}`));
  if (!date) continue;
  if (verb.startsWith('oublie') || verb.startsWith('annule')) delete observed[date];
  else observed[date] = !verb.startsWith('pas');
  changed.push(`${day} → ${observed[date] === undefined ? 'prévision' : observed[date] ? 'volé' : 'pas volé'}`);
}
if (!changed.length) {
  console.log('Aucune commande reconnue dans le commentaire.');
  process.exit(0);
}
fs.writeFileSync(file, JSON.stringify(observed));
console.log('Matinées signalées :', changed.join(', '));
if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `TRIGGER_LABEL=signalé dans l'issue : ${changed.join(', ')}\n`);
