// Zentrale Konfiguration – alles über Umgebungsvariablen überschreibbar.
import { ALL_MODES, modeFilter } from './modes.js';

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
  // So oft wird geprüft, ob es eine neue Fahrplan-Version gibt.
  gtfsMaxAgeHours: Number(env.GTFS_MAX_AGE_HOURS || 6),

  // GTFS-RT (Trip Updates). Ohne API-Key läuft die Karte rein nach Fahrplan.
  rtUrl: env.GTFS_RT_URL || 'https://api.opentransportdata.swiss/la/gtfs-rt',
  rtApiKey: env.GTFS_RT_API_KEY || '',
  // Auch ohne Key abfragen (wenn z. B. ein Proxy den Authorization-Header ergänzt).
  rtEnabled: env.GTFS_RT_ENABLED === '1',
  // opentransportdata.swiss erlaubt je nach Plan 2–5 Abfragen pro Minute;
  // 35 s passt mit Reserve zu beiden (Minimum 12 s).
  rtIntervalSeconds: Number(env.GTFS_RT_INTERVAL || 35),
  rtCacheFile: env.GTFS_RT_CACHE_FILE || 'data/gtfs-rt.pb',

  // Gleisnetz aus OpenStreetMap, damit Züge den Strecken entlang fahren.
  railRouting: env.RAIL_ROUTING !== '0',
  // Lokale Overpass-JSON-Datei; sonst Download über Overpass mit Cache.
  railOsmPath: env.RAIL_OSM_PATH || '',
  // Mehrere Overpass-Server (kommagetrennt) werden der Reihe nach versucht;
  // overpass.osm.ch ist die Instanz der Swiss OSM Association.
  overpassUrls: list(env.OVERPASS_URL || 'https://overpass.osm.ch/api/interpreter,https://overpass-api.de/api/interpreter'),
  railOsmCacheFile: env.RAIL_OSM_CACHE_FILE || 'data/rail-osm.json',
  railOsmMaxAgeDays: Number(env.RAIL_OSM_MAX_AGE_DAYS || 30),
  railLegsCacheFile: env.RAIL_LEGS_CACHE_FILE || 'data/rail-legs.json',

  // Fahrten ohne Halt in diesem Gebiet (Süd, West, Nord, Ost) werden ignoriert.
  bbox: list(env.BBOX || '45.75,5.85,47.85,10.55').map(Number),

  // Verkehrsmittel: rail, tram, metro, bus, ship, cable, funicular
  routeTypes: modeFilter(list(env.MODES || ALL_MODES.join(','))),
  // Auszug des Fahrplans (wird pro Fahrplan-Version und Auswahl einmal erstellt).
  gtfsExtractDir: env.GTFS_EXTRACT_DIR || 'data/gtfs-extract',

  timeZone: env.TZ_FEED || 'Europe/Zurich',
};
