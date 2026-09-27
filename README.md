# VU-mètre · stage perfectionnement Fly Millau (12-15 octobre 2026)

Site : https://r69sy78sny-droid.github.io/stage-millau/

Une aiguille de **−180** (impossible) à **+180** (le stage aura lieu) répond à une seule question :
*mes 3 matinées de vol pourront-elles avoir lieu entre le lundi 12 et le jeudi 15 octobre ?*
Elle vaut `360 × P − 180`, où P est la probabilité d'avoir au moins 3 matinées volables sur 4.

## Comment l'aiguille est calculée

1. **Matinée volable** : au moins 2 h d'affilée volables entre 9 h et 13 h (Fly Millau vole le matin).
   Heure volable : pluie < 0,2 mm, vent ≤ 22 km/h, rafales ≤ 35 km/h, pas de vent de NE-E au-delà de
   8 km/h (aucun décollage de l'école orienté ainsi), pas de nuage au déco, pas d'orage, vent à 850 hPa
   ≤ 45 km/h. Seuils dans `engine/config.js`, à faire valider par un moniteur.
2. **Prévisions** : 11 ensembles (ECMWF ENS, AIFS ENS, EC46, WeatherNext 2, GEFS, AI-GEFS, GEPS,
   ICON-EPS, MOGREPS-G, ICON-CH1/CH2) et 11 modèles déterministes (AROME HD, AROME, ARPEGE, ICON-D2,
   ICON-EU, IFS, AIFS, GFS, GEM, UKMO, JMA) via [Open-Meteo](https://open-meteo.com/).
3. **Calibration** : régression logistique apprise sur 33 ans (1993-2025) de matinées d'octobre à la
   station Météo-France de Millau (données ouvertes) contre ERA5 ; vents des modèles ramenés à l'échelle
   de la station.
4. **Échéance** : au-delà d'une dizaine de jours, les prévisions sont mélangées à la climatologie
   (poids a(L) = 1 / (1 + e^((L − 10)/2,5))).
5. **Combinaison** : 40 000 trajectoires de 4 matinées (système × membre × fenêtre climatologique).

Tout est détaillé sur le site, onglet « Méthode & sources ».

## Mises à jour

Le workflow `.github/workflows/aiguille.yml` tourne toutes les 20 minutes : il lit l'heure du dernier run
de chaque modèle, ne retélécharge que ceux qui ont changé, recalcule, committe `data/` et republie.
Si l'aiguille bouge d'au moins 30 points depuis la dernière alerte, un commentaire est posté sur l'issue
« 🎯 Alertes de l'aiguille » (notification GitHub par mail et dans l'app).

**Pendant le stage**, réponds dans cette issue :

- `volé 12` → la matinée du 12 compte comme volée ;
- `pas volé 13` → comptée comme perdue ;
- `oublie 14` → retour à la prévision.

Forcer une mise à jour : onglet *Actions* → *Aiguille météo* → *Run workflow* (case « Tout retélécharger »).

## En local

```bash
npm test                                   # tests du moteur
node scripts/update.mjs --dry              # mise à jour sans alerte
node scripts/build-climatology.mjs         # reconstruit data/climatology.json (~130 Mo de données Météo-France)
python3 -m http.server 8801                # puis http://localhost:8801
```

## Sources et licences

- Prévisions : Open-Meteo (CC BY 4.0) ; ECMWF (CC BY 4.0), NOAA (domaine public), DWD, ECCC, Met Office,
  Météo-France (Licence Ouverte 2.0), MeteoSwiss, Google DeepMind, JMA.
- Observations : Météo-France, données climatologiques de base horaires et quotidiennes (Licence Ouverte 2.0).
- Réanalyse : ERA5, Copernicus Climate Change Service / ECMWF.
- Sites de vol : [Fly Millau Parapente](https://www.fly-millau-parapente.com/), FFVL.

Outil d'aide personnel : c'est toujours le moniteur qui décide si l'on vole.
