// Zentrale Konfiguration – alles über Umgebungsvariablen überschreibbar.
const env = process.env;

function list(value) {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  port: Number(env.PORT || 8080),
  host: env.HOST || '0.0.0.0',

  // Statischer Fahrplan: entweder lokaler Pfad (ZIP oder entpacktes Verzeichnis) …
  gtfsPath: env.GTFS_PATH || '',
  // … oder Download-URL (Permalink von opentransportdata.swiss).
  gtfsUrl: env.GTFS_URL || 'https://data.opentransportdata.swiss/dataset/timetable-2026-gtfs2020/permalink',
  gtfsCacheFile: env.GTFS_CACHE_FILE || 'data/gtfs.zip',
  gtfsMaxAgeHours: Number(env.GTFS_MAX_AGE_HOURS || 24),

  // GTFS-RT (Trip Updates). Ohne API-Key läuft die Karte rein nach Fahrplan.
  rtUrl: env.GTFS_RT_URL || 'https://api.opentransportdata.swiss/la/gtfs-rt',
  rtApiKey: env.GTFS_RT_API_KEY || '',
  // opentransportdata.swiss erlaubt nur 2 Abfragen pro Minute (Minimum 30 s);
  // der Standard lässt etwas Reserve.
  rtIntervalSeconds: Number(env.GTFS_RT_INTERVAL || 35),
  rtCacheFile: env.GTFS_RT_CACHE_FILE || 'data/gtfs-rt.pb',

  // GTFS route_type, die als "Zug" gelten (2 = Rail, 100–117 = Extended Rail).
  routeTypes: new Set(list(env.ROUTE_TYPES || '2,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117').map(Number)),

  timeZone: env.TZ_FEED || 'Europe/Zurich',
};
