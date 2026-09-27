// Réglages centraux : le stage, les points de prévision, les sites de Fly Millau, les limites de vol
// et les systèmes de prévision interrogés. Tout choix « métier » est ici, pas dans le code.

/** Change ce numéro quand le traitement des données change : les résumés par système sont alors recalculés. */
export const ENGINE_VERSION = 5;

export const STAGE = {
  title: 'Stage perfectionnement parapente · Fly Millau',
  school: 'Fly Millau Parapente',
  schoolUrl: 'https://www.fly-millau-parapente.com/stage-perfectionnement-parapente-millau-12',
  dates: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'],
  sessionsNeeded: 3, // 3 matinées réservées sur les 4 jours
  tz: 'Europe/Paris',
  // Créneaux d'une heure notés par leur heure de fin (convention Open-Meteo : cumul sur l'heure écoulée).
  // 10, 11, 12, 13 = 9 h-10 h … 12 h-13 h, heure locale : la matinée de vol.
  morningSlots: [10, 11, 12, 13],
  minConsecutiveSlots: 2, // il faut 2 h volables d'affilée pour que la matinée compte
  fetchStart: '2026-10-11', // la veille, pour les cumuls et le brouillard du matin
  fetchEnd: '2026-10-16', // jusqu'au lendemain 0 h pour le cumul du dernier jour
};

export const POINTS = {
  deco: { id: 'deco', name: "Déco Pouncho d'Agast", lat: 44.1104, lon: 3.1009, elevation: 828 },
  atterro: { id: 'atterro', name: 'Atterrissage Millau-Plage', lat: 44.1143, lon: 3.0874, elevation: 359 },
  aigoual: { id: 'aigoual', name: 'Mont Aigoual (Cévennes)', lat: 44.1214, lon: 3.5817, elevation: 1567 },
  station: { id: 'station', name: 'Station Météo-France Millau (12145001)', lat: 44.1185, lon: 3.0195, elevation: 712 },
};

/** Sites de Fly Millau (site de l'école) ; orientations des décollages. */
export const SITES = [
  { id: 'pouncho', name: "Pouncho d'Agast", alt: 828, orient: ['S', 'SO', 'O', 'NO', 'N'], note: 'site principal, atterrissage Millau-Plage (500 m de dénivelé)' },
  { id: 'brunas', name: 'Brunas', alt: 815, orient: ['N'], note: 'pratiqué par vent du nord' },
  { id: 'novis', name: 'Novis', alt: 867, orient: ['SE'], note: 'vent de sud-est soutenu, Causse de Sauveterre' },
  { id: 'andan', name: "Pic d'Andan", alt: 850, orient: ['SE'], note: 'vent de sud-est soutenu, accès 4x4' },
];

/**
 * Limites de vol pour un groupe d'élèves en perfectionnement, exprimées « au niveau de la station
 * Météo-France de Millau » (anémomètre à 10 m, plateau à 712 m). Les vents des modèles sont d'abord
 * ramenés à cette échelle (voir BIAS) : un modèle à 25 km lisse le relief et sous-estime les vents forts.
 */
export const LIMITS = {
  wind: 22, // km/h, vent moyen
  gust: 35, // km/h, rafale
  rain: 0.2, // mm/h
  calm: 8, // km/h : en dessous, la direction du vent n'est plus un critère
  wind850: 45, // km/h vers 1 500 m : au-delà, vent météo trop fort (turbulence, sous le vent des causses)
  // Aucun décollage de l'école n'est orienté NE-E : secteur 22,5°-112,5° exclu dès que le vent souffle.
  forbidden: { center: 67.5, halfWidth: 45 },
  cape: 800, // J/kg, avec pluie : risque orageux
};

/**
 * Facteurs pour passer du vent d'un modèle au vent de la station (quantiles ERA5 1993-2025 contre la
 * station de Millau, matinées d'octobre ; voir data/climatology.json). Les modèles fins (≤ 2,5 km)
 * voient déjà le relief : facteurs neutres.
 */
export const BIAS = {
  coarse: { wind: 1.18, gust: 0.89 }, // ≥ 20 km
  medium: { wind: 1.1, gust: 0.93 }, // 7-13 km
  fine: { wind: 1.0, gust: 1.0 }, // ≤ 2,5 km
};

/** Poids de la prévision face à la climatologie selon l'échéance L (jours) : a(L) = 1 / (1 + e^((L − L50)/s)). */
export const LEAD = { l50: 10, scale: 2.5 };

/** Alertes GitHub : commentaire sur l'issue quand l'aiguille a bougé d'au moins ce nombre de points. */
export const ALERT = { threshold: 30, issueTitle: "🎯 Alertes de l'aiguille (stage Millau 12-15 oct.)" };

const V = {
  t: 'temperature_2m',
  rh: 'relative_humidity_2m',
  rr: 'precipitation',
  sh: 'showers',
  cc: 'cloud_cover',
  ccl: 'cloud_cover_low',
  wc: 'weather_code',
  vis: 'visibility',
  ws: 'wind_speed_10m',
  wd: 'wind_direction_10m',
  wg: 'wind_gusts_10m',
  cape: 'cape',
  p: 'pressure_msl',
  t850: 'temperature_850hPa',
  ws850: 'wind_speed_850hPa',
  wd850: 'wind_direction_850hPa',
  z500: 'geopotential_height_500hPa',
};
export const VARS = V;

/**
 * Ensembles interrogés via l'API Ensemble d'Open-Meteo. `weight` = poids total du système (pas par membre),
 * `meta` = domaines Open-Meteo dont l'heure de run déclenche une mise à jour.
 */
export const ENSEMBLES = [
  {
    id: 'ecmwf_ens', horizonHours: 360, model: 'ecmwf_ifs025', meta: ['ecmwf_ifs025_ensemble'], label: 'ECMWF IFS ENS', short: 'ECMWF ENS',
    provider: 'ECMWF (Centre européen)', res: '0,25° (~25 km)', horizon: '15 j', bias: 'coarse', weight: 3.0,
    vars: ['t', 'rh', 'rr', 'sh', 'cc', 'ccl', 'wc', 'ws', 'wd', 'wg', 'cape', 'p', 't850', 'ws850', 'wd850', 'z500'],
  },
  {
    id: 'ecmwf_aifs', horizonHours: 360, model: 'ecmwf_aifs025', meta: ['ecmwf_aifs025_ensemble'], label: 'ECMWF AIFS ENS (IA)', short: 'AIFS ENS',
    provider: 'ECMWF (modèle IA)', res: '0,25°', horizon: '15 j', bias: 'coarse', weight: 2.5,
    vars: ['t', 'rh', 'rr', 'sh', 'cc', 'ccl', 'wc', 'ws', 'wd', 'p', 't850', 'ws850', 'wd850', 'z500'],
  },
  {
    id: 'ecmwf_ec46', horizonHours: 1104, model: 'ecmwf_ec46', meta: ['ecmwf_ec46'], label: 'ECMWF ENS étendu (EC46)', short: 'EC46',
    provider: 'ECMWF', res: '~36 km, pas de 6 h', horizon: '46 j', bias: 'coarse', weight: 2.5, weightWhenCovered: 0.5, coveredBy: 'ecmwf_ens',
    vars: ['t', 'rh', 'rr', 'sh', 'cc', 'wc', 'ws', 'wd', 'wg', 'p'],
  },
  {
    id: 'google_wn2', horizonHours: 360, model: 'google_weathernext2_ensemble', meta: ['google_weathernext2_ensemble'], label: 'Google WeatherNext 2 (IA)', short: 'WeatherNext 2',
    provider: 'Google DeepMind', res: '0,25°, pas de 6 h', horizon: '15 j', bias: 'coarse', weight: 1.8,
    vars: ['t', 'rr', 'sh', 'cc', 'ccl', 'wc', 'ws', 'wd', 'p', 't850', 'ws850', 'wd850', 'z500'],
  },
  {
    id: 'gefs', horizonHours: 840, model: 'gfs05', meta: ['ncep_gefs05'], label: 'NOAA GEFS', short: 'GEFS',
    provider: 'NOAA / NCEP (États-Unis)', res: '0,5° (~50 km)', horizon: '35 j', bias: 'coarse', weight: 1.8,
    vars: ['t', 'rh', 'rr', 'sh', 'cc', 'wc', 'vis', 'ws', 'wd', 'wg', 'cape', 'p', 't850', 'ws850', 'wd850', 'z500'],
  },
  {
    id: 'aigefs', horizonHours: 384, model: 'ncep_aigefs025', meta: ['ncep_aigefs025'], label: 'NOAA AI-GEFS (IA)', short: 'AI-GEFS',
    provider: 'NOAA (modèle IA)', res: '0,25°', horizon: '16 j', bias: 'coarse', weight: 1.0,
    vars: ['t', 'rr', 'sh', 'cc', 'ccl', 'wc', 'ws', 'wd', 'p', 't850', 'ws850', 'wd850', 'z500'],
  },
  {
    id: 'geps', horizonHours: 384, model: 'gem_global', meta: ['cmc_gem_geps'], label: 'ECCC GEPS', short: 'GEPS',
    provider: 'Environnement Canada', res: '~25 km', horizon: '16 j (32 j le jeudi)', bias: 'coarse', weight: 1.3,
    vars: ['t', 'rh', 'rr', 'cc', 'wc', 'ws', 'wd', 'cape', 'p', 't850', 'z500'],
  },
  {
    id: 'icon_eps', horizonHours: 180, model: 'icon_seamless', meta: ['dwd_icon_eps', 'dwd_icon_eu_eps', 'dwd_icon_d2_eps'], label: 'DWD ICON-EPS (+ EU, D2)', short: 'ICON-EPS',
    provider: 'DWD (Allemagne)', res: '26 km → 13 km → 2 km', horizon: '7,5 j', bias: 'coarse', weight: 1.8,
    vars: ['t', 'rh', 'rr', 'sh', 'cc', 'wc', 'ws', 'wd', 'wg', 'cape', 'p'],
  },
  {
    id: 'mogreps', horizonHours: 168, model: 'ukmo_global_ensemble_20km', meta: ['ukmo_global_ensemble_20km'], label: 'UKMO MOGREPS-G', short: 'MOGREPS-G',
    provider: 'Met Office (Royaume-Uni)', res: '20 km', horizon: '7 j', bias: 'coarse', weight: 1.5,
    vars: ['t', 'rh', 'rr', 'sh', 'cc', 'wc', 'vis', 'ws', 'wd', 'wg', 'cape', 'p'],
  },
  {
    id: 'icon_ch2', horizonHours: 120, model: 'meteoswiss_icon_ch2', meta: ['meteoswiss_icon_ch2_ensemble'], label: 'MeteoSwiss ICON-CH2-EPS', short: 'ICON-CH2',
    provider: 'MeteoSwiss', res: '2,1 km', horizon: '5 j', bias: 'fine', weight: 1.5,
    vars: ['t', 'rh', 'rr', 'sh', 'cc', 'ccl', 'wc', 'ws', 'wd', 'wg', 'cape', 'p'],
  },
  {
    id: 'icon_ch1', horizonHours: 33, model: 'meteoswiss_icon_ch1', meta: ['meteoswiss_icon_ch1_ensemble'], label: 'MeteoSwiss ICON-CH1-EPS', short: 'ICON-CH1',
    provider: 'MeteoSwiss', res: '1 km', horizon: '33 h', bias: 'fine', weight: 1.2,
    vars: ['t', 'rh', 'rr', 'sh', 'cc', 'ccl', 'wc', 'ws', 'wd', 'wg', 'cape', 'p'],
  },
];

/** Modèles déterministes (API Forecast d'Open-Meteo), une seule trajectoire chacun. */
export const DETERMINISTIC = [
  { id: 'arome_hd', horizonHours: 42, model: 'meteofrance_arome_france_hd', meta: 'meteofrance_arome_france_hd', label: 'AROME HD', provider: 'Météo-France', res: '1,3 km', horizon: '42 h', bias: 'fine', weight: 2.0 },
  { id: 'arome', horizonHours: 42, model: 'meteofrance_arome_france', meta: 'meteofrance_arome_france0025', label: 'AROME', provider: 'Météo-France', res: '2,5 km', horizon: '42 h', bias: 'fine', weight: 1.5 },
  { id: 'arpege', horizonHours: 102, model: 'meteofrance_arpege_europe', meta: 'meteofrance_arpege_europe', label: 'ARPEGE Europe', provider: 'Météo-France', res: '0,1° (~11 km)', horizon: '4 j', bias: 'medium', weight: 1.0 },
  { id: 'icon_d2', horizonHours: 48, model: 'icon_d2', meta: 'dwd_icon_d2', label: 'ICON-D2', provider: 'DWD', res: '2,2 km', horizon: '48 h', bias: 'fine', weight: 1.0 },
  { id: 'icon_eu', horizonHours: 120, model: 'icon_eu', meta: 'dwd_icon_eu', label: 'ICON-EU', provider: 'DWD', res: '7 km', horizon: '5 j', bias: 'medium', weight: 0.7 },
  { id: 'ifs', horizonHours: 360, model: 'ecmwf_ifs', meta: 'ecmwf_ifs', label: 'ECMWF IFS HRES', provider: 'ECMWF', res: '9 km', horizon: '15 j', bias: 'medium', weight: 0.8 },
  { id: 'aifs', horizonHours: 360, model: 'ecmwf_aifs025_single', meta: 'ecmwf_aifs025_single', label: 'ECMWF AIFS', provider: 'ECMWF (IA)', res: '0,25°', horizon: '15 j', bias: 'coarse', weight: 0.4 },
  { id: 'gfs', horizonHours: 384, model: 'gfs_seamless', meta: 'ncep_gfs013', label: 'NOAA GFS', provider: 'NOAA', res: '0,11-0,25°', horizon: '16 j', bias: 'coarse', weight: 0.4 },
  { id: 'gem', horizonHours: 240, model: 'gem_seamless', meta: null, label: 'ECCC GEM', provider: 'Environnement Canada', res: '15-25 km', horizon: '10 j', bias: 'coarse', weight: 0.3 },
  { id: 'ukmo', horizonHours: 168, model: 'ukmo_seamless', meta: 'ukmo_global_deterministic_10km', label: 'UKMO Global', provider: 'Met Office', res: '10 km', horizon: '7 j', bias: 'medium', weight: 0.4 },
  { id: 'jma', horizonHours: 264, model: 'jma_seamless', meta: 'jma_gsm', label: 'JMA GSM', provider: 'JMA (Japon)', res: '~20-55 km', horizon: '11 j', bias: 'coarse', weight: 0.2 },
];

export const DET_VARS = [
  'temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'precipitation', 'showers', 'cloud_cover', 'cloud_cover_low',
  'cloud_cover_mid', 'cloud_cover_high', 'weather_code', 'visibility', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
  'cape', 'pressure_msl', 'boundary_layer_height', 'temperature_925hPa', 'temperature_850hPa', 'temperature_700hPa',
  'relative_humidity_925hPa', 'relative_humidity_850hPa', 'relative_humidity_700hPa', 'geopotential_height_925hPa',
  'geopotential_height_850hPa', 'geopotential_height_700hPa', 'geopotential_height_500hPa', 'wind_speed_850hPa',
  'wind_direction_850hPa', 'wind_speed_925hPa', 'wind_direction_925hPa',
];
export const DET_VARS_VALLEY = ['temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'wind_speed_10m', 'visibility', 'cloud_cover_low', 'weather_code'];

export const API = {
  ensemble: 'https://ensemble-api.open-meteo.com/v1/ensemble',
  forecast: 'https://api.open-meteo.com/v1/forecast',
  meta: (host, domain) => `https://${host}/data/${domain}/static/meta.json`,
};

/** Régimes météo (classement de chaque membre, chaque jour). */
export const REGIMES = {
  cevenol: { label: 'Épisode méditerranéen / cévenol (ou retour d’est)', color: '#7b3fa0', fly: 'non volable : pluie, plafond bas, vent de sud-est' },
  perturbe: { label: 'Passage perturbé (pluie)', color: '#3f6fb5', fly: 'rarement volable' },
  instable: { label: 'Instable, averses', color: '#4f9fb0', fly: 'créneaux possibles entre les averses' },
  sud: { label: 'Flux de sud-est (vent du Midi, marin)', color: '#d0873a', fly: 'Novis / Pic d’Andan si le vent reste modéré' },
  nord: { label: 'Flux de nord à nord-ouest (tramontane)', color: '#5d7f99', fly: 'Brunas / Pouncho nord si le vent reste modéré' },
  ouest: { label: "Flux d'ouest à sud-ouest", color: '#6c9a5b', fly: 'Pouncho ouest, souvent soaring' },
  est: { label: "Vent d'est à nord-est", color: '#a05a5a', fly: 'aucun décollage orienté à l’est' },
  anticyclone: { label: 'Anticyclonique, vent faible', color: '#e0b640', fly: 'volable ; brouillard possible au fond de la vallée' },
  marais: { label: 'Marais barométrique', color: '#9c9c7a', fly: 'souvent volable, vigilance nuages bas' },
};
