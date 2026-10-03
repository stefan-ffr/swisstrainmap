// HTTP-Server: liefert die Karte aus und stellt die Zugpositionen als JSON bereit.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openGtfs, ensureDownloaded } from './gtfs-source.js';
import { loadGtfs } from './gtfs-loader.js';
import { Timetable } from './timetable.js';
import { RealtimeStore } from './realtime.js';
import { todayKey } from './time.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const state = { timetable: null, loading: false, loadedAt: null, loadError: null };
const realtime = new RealtimeStore();

async function reload() {
  if (state.loading) return;
  state.loading = true;
  try {
    const file = config.gtfsPath
      || await ensureDownloaded(config.gtfsUrl, path.resolve(root, config.gtfsCacheFile), config.gtfsMaxAgeHours, log);
    const src = await openGtfs(path.resolve(root, file));
    try {
      const data = await loadGtfs(src, {
        routeTypes: config.routeTypes,
        centerDay: todayKey(Date.now(), config.timeZone),
        log,
      });
      state.timetable = new Timetable(data, config.timeZone);
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
}

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

let cache = { at: 0, body: null };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const tt = state.timetable;

  if (url.pathname === '/api/trains') {
    if (!tt) return sendJson(req, res, 503, { error: state.loadError || 'Fahrplan wird geladen …' });
    const now = Date.now();
    if (now - cache.at > 2000) cache = { at: now, body: { now, trains: tt.positions(now, realtime) } };
    return sendJson(req, res, 200, { ...cache.body, serverTime: now });
  }
  if (url.pathname.startsWith('/api/trip/')) {
    if (!tt) return sendJson(req, res, 503, { error: 'Fahrplan wird geladen …' });
    const trip = tt.trip(decodeURIComponent(url.pathname.slice('/api/trip/'.length)), realtime);
    return trip ? sendJson(req, res, 200, trip) : sendJson(req, res, 404, { error: 'Fahrt unbekannt' });
  }
  if (url.pathname === '/api/status') {
    return sendJson(req, res, 200, {
      timetable: {
        loaded: !!tt, loading: state.loading, loadedAt: state.loadedAt, error: state.loadError,
        days: tt?.days.map((d) => d.day), trips: tt?.data.trips.size,
      },
      realtime: realtime.status,
    });
  }
  serveStatic(url.pathname, res);
});

server.listen(config.port, config.host, () => log(`Server läuft auf http://localhost:${config.port}`));
realtime.start({ url: config.rtUrl, apiKey: config.rtApiKey, intervalSeconds: config.rtIntervalSeconds, log });
reload();
