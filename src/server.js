// HTTP-Server: liefert die Karte aus und stellt die Zugpositionen als JSON bereit.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openGtfs, ensureDownloaded } from './gtfs-source.js';
import { loadGtfs } from './gtfs-loader.js';
import { ensureExtractInWorker } from './extract-worker.js';
import { Timetable } from './timetable.js';
import { RealtimeStore } from './realtime.js';
import { todayKey } from './time.js';
import { loadForeignFeeds, extendWithForeign } from './foreign.js';
import { LegStore } from './legs.js';
import { ExtraLog } from './extras.js';
import { ensureRailOsm, loadRailNetwork, PROFILES } from './rail-network.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const state = { timetable: null, loading: false, loadedAt: null, loadError: null };
const realtime = new RealtimeStore();
const extraLog = new ExtraLog(path.resolve(root, config.extrasFile), log);
const extraLogLoaded = extraLog.load();

/** Extrafahrten aus dem neuesten GTFS-RT-Stand ins Protokoll übernehmen. */
async function recordExtras() {
  const tt = state.timetable;
  if (!tt) return;
  await extraLogLoaded;
  tt.refreshAdded(realtime);
  extraLog.prune(todayKey(Date.now(), config.timeZone));
  extraLog.record(tt.added.values(), (trip) => tt.expectedTimes(trip, trip.day, trip.dayStart, realtime), tt.data.stops);
}
const networks = [config.railRouting && 'rail', config.roadRouting && 'road'].filter(Boolean);
const legStore = networks.length ? new LegStore(path.resolve(root, config.railLegsCacheFile), log, networks) : null;
const NETWORK_SOURCES = {
  rail: { path: config.railOsmPath, cache: config.railOsmCacheFile },
  road: { path: config.roadOsmPath, cache: config.roadOsmCacheFile },
};
const legCacheLoaded = legStore?.loadCache();

/** Netze nur laden, wenn Abschnitte fehlen – danach wieder freigeben. */
async function computeLegs() {
  if (!legStore) return;
  await legStore.computeMissing(async (name) => {
    const profile = PROFILES[name], src = NETWORK_SOURCES[name];
    const file = src.path
      ? path.resolve(root, src.path)
      : await ensureRailOsm(config.overpassUrls, path.resolve(root, src.cache), config.railOsmMaxAgeDays, log, profile);
    return loadRailNetwork(file, log, profile);
  });
}

async function reload() {
  if (state.loading) return;
  state.loading = true;
  try {
    const file = config.gtfsPath
      || await ensureDownloaded(config.gtfsUrl, path.resolve(root, config.gtfsCacheFile), config.gtfsMaxAgeHours, log);
    let source = path.resolve(root, file);
    try {
      source = await ensureExtractInWorker(source, path.resolve(root, config.gtfsExtractDir), config.routeTypes, log);
    } catch (err) {
      log(`GTFS: Auszug fehlgeschlagen (${err.message}) – lese den Fahrplan direkt (langsamer)`);
    }
    const src = await openGtfs(source);
    try {
      const data = await loadGtfs(src, {
        routeTypes: config.routeTypes,
        bbox: config.bbox,
        centerDay: todayKey(Date.now(), config.timeZone),
        log,
      });
      if (config.foreignGtfs.length) {
        const foreign = await loadForeignFeeds(config.foreignGtfs, {
          dataDir: path.resolve(root, 'data'),
          centerDay: data.days[1],
          checkHours: config.foreignMaxAgeHours,
          log,
        });
        log(`Ausland: ${extendWithForeign(data, foreign, config.timeZone)} Fahrten über die Grenze hinaus verlängert`);
      }
      await legCacheLoaded;
      state.timetable = new Timetable(data, config.timeZone, legStore);
      recordExtras().catch((err) => log(`Extrafahrten: ${err.message}`));
      state.loadedAt = new Date().toISOString();
      state.loadError = null;
    } finally {
      src.close();
    }
  } catch (err) {
    state.loadError = err.message;
    log(`Fehler beim Laden des Fahrplans: ${err.stack || err.message}`);
  } finally {
    state.loading = false;
  }
  computeLegs();
}

// Neue Abschnitte (z. B. von Extrafahrten aus GTFS-RT) regelmässig nachberechnen;
// ohne offene Abschnitte wird kein Netz geladen.
setInterval(() => { if (state.timetable) computeLegs(); }, 30 * 60_000).unref();
setTimeout(() => { if (state.timetable) computeLegs(); }, 2 * 60_000).unref(); // erste Extrafahrten bald nach dem Start

// Fenster aus gestern/heute/morgen nachführen, sobald ein neuer Tag beginnt.
setInterval(() => {
  const today = todayKey(Date.now(), config.timeZone);
  const tt = state.timetable;
  if (!state.loading && (!tt || tt.days[1].day !== today)) reload();
}, 60_000).unref();

// --- HTTP -----------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const STATIC_DIRS = {
  '/vendor/leaflet/': path.join(root, 'node_modules/leaflet/dist/'),
  '/': path.join(root, 'public/'),
};

function sendJson(req, res, status, body) {
  const json = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (json.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(status, headers);
    res.end(zlib.gzipSync(json));
  } else {
    res.writeHead(status, headers);
    res.end(json);
  }
}

function serveStatic(pathname, res) {
  for (const [prefix, dir] of Object.entries(STATIC_DIRS)) {
    if (!pathname.startsWith(prefix)) continue;
    let rel = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html';
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir)) break;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

const cache = new Map(); // Verkehrsmittel -> { at, trains }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const tt = state.timetable;

  if (url.pathname === '/api/trains') {
    // ?modes=rail,tram,…  &bbox=süd,west,nord,ost – berechnet werden nur Fahrten
    // dieser Verkehrsmittel im Ausschnitt; ohne Angabe: alle, landesweit
    if (!tt) return sendJson(req, res, 503, { error: state.loadError || 'Fahrplan wird geladen …' });
    const now = Date.now();
    const modesParam = url.searchParams.get('modes') || '';
    const bbox = url.searchParams.get('bbox')?.split(',').map(Number);
    const filter = {
      modes: modesParam ? new Set(modesParam.split(',')) : null,
      bbox: bbox?.length === 4 && !bbox.some(Number.isNaN) ? bbox : null,
    };
    // Landesweite Abfragen (z. B. alle Züge) sind für alle Besucher gleich: 2 s zwischenspeichern
    const key = filter.bbox ? null : modesParam;
    let trains;
    if (key !== null && cache.get(key)?.at > now - 2000) trains = cache.get(key).trains;
    else {
      trains = tt.positions(now, realtime, filter);
      if (key !== null) cache.set(key, { at: now, trains });
    }
    return sendJson(req, res, 200, { now, trains, serverTime: now, legsVersion: legStore?.version ?? null });
  }
  if (url.pathname.startsWith('/api/trip/')) {
    if (!tt) return sendJson(req, res, 503, { error: 'Fahrplan wird geladen …' });
    const trip = tt.trip(decodeURIComponent(url.pathname.slice('/api/trip/'.length)), realtime);
    if (trip) trip.legs = trip.legs.map((id) => legStore?.geometry(id) || '');
    return trip ? sendJson(req, res, 200, trip) : sendJson(req, res, 404, { error: 'Fahrt unbekannt' });
  }
  if (url.pathname === '/api/legs') {
    // { id: Polyline | "" (keine Geometrie, Luftlinie) | null (noch in Berechnung) }
    const out = {};
    for (const id of (url.searchParams.get('ids') || '').split(',').slice(0, 2000)) {
      if (id === '' || !legStore) continue;
      out[id] = legStore.geometry(Number(id)) ?? null;
    }
    return sendJson(req, res, 200, { version: legStore?.version ?? null, legs: out });
  }
  if (url.pathname === '/api/extras') {
    // Extrafahrten eines Betriebstags (Standard: heute), auch bereits beendete
    const day = Number(url.searchParams.get('day')) || todayKey(Date.now(), config.timeZone);
    return sendJson(req, res, 200, { day, extras: extraLog.forDay(day) });
  }
  if (url.pathname === '/api/status') {
    return sendJson(req, res, 200, {
      timetable: {
        loaded: !!tt, loading: state.loading, loadedAt: state.loadedAt, error: state.loadError,
        days: tt?.days.map((d) => d.day), trips: tt?.data.trips.size,
      },
      realtime: realtime.status,
      legs: legStore ? { ...legStore.status, enabled: true } : { enabled: false },
    });
  }
  serveStatic(url.pathname, res);
});

server.listen(config.port, config.host, () => log(`Server läuft auf http://localhost:${config.port}`));
realtime.start({
  url: config.rtUrl,
  apiKey: config.rtApiKey,
  enabled: config.rtEnabled,
  intervalSeconds: config.rtIntervalSeconds,
  cacheFile: path.resolve(root, config.rtCacheFile),
  log,
  onUpdate: () => recordExtras().catch((err) => log(`Extrafahrten: ${err.message}`)),
});
reload();
