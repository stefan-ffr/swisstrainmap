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
  // … oder Download-URL (Permalink von opentransportdata.swiss); {year} wird
  // durch das aktuelle Fahrplanjahr ersetzt (Wechsel im Dezember).
  gtfsUrl: env.GTFS_URL || 'https://data.opentransportdata.swiss/dataset/timetable-{year}-gtfs2020/permalink',
  gtfsCacheFile: env.GTFS_CACHE_FILE || 'data/gtfs.zip',
  // So oft wird geprüft, ob es eine neue Fahrplan-Version gibt.
  gtfsMaxAgeHours: Number(env.GTFS_MAX_AGE_HOURS || 6),
  // Fahrpläne der Nachbarländer, um internationale Züge über die Grenze hinaus
  // zu zeigen (Name=URL, kommagetrennt; leer = aus).
  foreignGtfs: list(env.FOREIGN_GTFS ?? [
    'de=https://download.gtfs.de/germany/fv_free/latest.zip',
    'fr=https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip',
    'at=https://static.web.oebb.at/open-data/soll-fahrplan-gtfs/GTFS_Fahrplan_{year}.zip',
    // Trenitalia: wöchentlich aus dem offiziellen NeTEx (italienischer NAP) umgewandelt
    'it=https://raw.githubusercontent.com/deryclem/trenitalia-gtfs/main/gtfs-trenitalia.zip',
  ].join(',')).map((entry) => {
    const i = entry.indexOf('=');
    return { name: entry.slice(0, i), url: entry.slice(i + 1) };
  }),
  foreignMaxAgeHours: Number(env.FOREIGN_GTFS_MAX_AGE_HOURS || 24),

  // GTFS-RT (Trip Updates). Ohne API-Key läuft die Karte rein nach Fahrplan.
  rtUrl: env.GTFS_RT_URL || 'https://api.opentransportdata.swiss/la/gtfs-rt',
  rtApiKey: env.GTFS_RT_API_KEY || '',
  // Auch ohne Key abfragen (wenn z. B. ein Proxy den Authorization-Header ergänzt).
  rtEnabled: env.GTFS_RT_ENABLED === '1',
  // opentransportdata.swiss erlaubt je nach Plan 2–5 Abfragen pro Minute;
  // 35 s passt mit Reserve zu beiden (Minimum 12 s).
  rtIntervalSeconds: Number(env.GTFS_RT_INTERVAL || 35),
  rtCacheFile: env.GTFS_RT_CACHE_FILE || 'data/gtfs-rt.pb',

  // GTFS-SA (Störungsmeldungen), eigener Key im API-Manager (Produkt GTFS-SA).
  alertsUrl: env.GTFS_SA_URL || 'https://api.opentransportdata.swiss/la/gtfs-sa',
  alertsApiKey: env.GTFS_SA_API_KEY || '',
  alertsEnabled: env.GTFS_SA_ENABLED === '1',
  alertsIntervalSeconds: Number(env.GTFS_SA_INTERVAL || 120),
  alertsCacheFile: env.GTFS_SA_CACHE_FILE || 'data/gtfs-sa.pb',
  // Zugkomposition (Train Formation Service), eigener Key; abgefragt nur beim
  // Öffnen einer Fahrt. Plan: 50 Abfragen/min, 20 000/Tag.
  formationUrl: env.FORMATION_URL || 'https://api.opentransportdata.swiss/formation/v1/formations_full',
  formationApiKey: env.FORMATION_API_KEY || '',
  formationEnabled: env.FORMATION_ENABLED === '1',
  // Sprache der Meldungen (de, fr, it, en)
  alertsLang: env.ALERTS_LANG || 'de',
  // Protokoll der Extrafahrten (Zusatzfahrten aus GTFS-RT) der letzten 2 Tage
  extrasFile: env.EXTRAS_FILE || 'data/extras.json',

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
  // Busse auf den Strassen der OSM-Buslinien (route=bus) statt in Luftlinie.
  roadRouting: env.ROAD_ROUTING !== '0',
  roadOsmPath: env.ROAD_OSM_PATH || '',
  roadOsmCacheFile: env.ROAD_OSM_CACHE_FILE || 'data/road-osm.json',
  // Schiffe auf den OSM-Schiffskursen (route=ferry) statt in Luftlinie.
  shipRouting: env.SHIP_ROUTING !== '0',
  shipOsmPath: env.SHIP_OSM_PATH || '',
  shipOsmCacheFile: env.SHIP_OSM_CACHE_FILE || 'data/water-osm.json',

  // Fahrten ohne Halt in diesem Gebiet (Süd, West, Nord, Ost) werden ignoriert.
  bbox: list(env.BBOX || '45.75,5.85,47.85,10.55').map(Number),

  // Verkehrsmittel: rail, tram, metro, bus, ship, cable, funicular
  routeTypes: modeFilter(list(env.MODES || ALL_MODES.join(','))),
  // Auszug des Fahrplans (wird pro Fahrplan-Version und Auswahl einmal erstellt).
  gtfsExtractDir: env.GTFS_EXTRACT_DIR || 'data/gtfs-extract',

  timeZone: env.TZ_FEED || 'Europe/Zurich',
};
