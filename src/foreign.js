// Ergänzt internationale Züge um ihren Laufweg im Ausland.
//
// Der Schweizer Fahrplan enthält z. B. den ICE 100 nur bis Basel Bad Bf oder
// den EC 150 erst ab Como. Die Fahrpläne der Nachbarländer (Deutschland:
// gtfs.de/DELFI, Frankreich: SNCF) enthalten den Rest. Zugeordnet wird ohne
// Zugnummern: Eine ausländische Fahrt gilt als Fortsetzung, wenn sie am End-
// bzw. Anfangshalt der Schweizer Fahrt UND am Halt davor bzw. danach zur
// gleichen Zeit hält (±3 Minuten). Dann werden ihre weiteren Halte angehängt.
import path from 'node:path';
import { ensureDownloaded, openGtfs } from './gtfs-source.js';
import { loadGtfs } from './gtfs-loader.js';
import { modeFilter } from './modes.js';
import { serviceDayStart } from './time.js';

const TOLERANCE = 180;   // s: gleiche Zeit am gemeinsamen Halt
const SAME_PLACE = 600;  // m: gleicher Bahnhof (Koordinaten aus verschiedenen Quellen)
const CELL = 0.01;       // Grad, Raster für die Bahnhofssuche
// Ausländische Fahrten laden, die irgendwo in diesem Gebiet halten (S, W, N, O)
const AREA = [44.5, 4.0, 49.5, 12.5];

const dist = (lat1, lon1, lat2, lon2) =>
  Math.hypot((lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180), (lat2 - lat1) * 110540);

/** Lädt die ausländischen Fahrpläne (nur Bahn) für das Datumsfenster. */
export async function loadForeignFeeds(feeds, { dataDir, centerDay, checkHours, log = console.log }) {
  const out = [];
  for (const { name, url } of feeds) {
    try {
      const file = await ensureDownloaded(url, path.join(dataDir, `foreign-${name}.zip`), checkHours, log);
      const src = await openGtfs(file);
      try {
        const data = await loadGtfs(src, { routeTypes: modeFilter(['rail']), centerDay, bbox: AREA, log: () => {} });
        log(`Ausland (${name}): ${data.trips.size.toLocaleString('de-CH')} Bahnfahrten im Grenzgebiet`);
        out.push({ name, data });
      } finally {
        src.close();
      }
    } catch (err) {
      log(`Ausland (${name}): nicht verfügbar – ${err.message}`);
    }
  }
  return out;
}

/**
 * Verlängert die Fahrten in data (Schweizer Fahrplan) um ihren Laufweg im
 * Ausland. Ändert data.trips und data.stops; gibt die Anzahl verlängerter
 * Fahrten zurück.
 */
export function extendWithForeign(data, foreignFeeds, timeZone) {
  if (!foreignFeeds.length) return 0;
  const S = data.stops;

  // Index: Rasterzelle -> Halte-Ereignisse ausländischer Fahrten (absolute Zeiten in s)
  const index = new Map();
  const cellKey = (lat, lon) => Math.floor(lat / CELL) * 100000 + Math.floor(lon / CELL);
  for (const { data: f } of foreignFeeds) {
    for (const day of f.days) {
      const base = serviceDayStart(day, timeZone) / 1000;
      const active = f.services.get(day);
      for (const trip of f.trips.values()) {
        if (!active.has(trip.serviceId)) continue;
        for (let k = 0; k < trip.stop.length; k++) {
          const s = trip.stop[k];
          const key = cellKey(f.stops.lat[s], f.stops.lon[s]);
          if (!index.has(key)) index.set(key, []);
          index.get(key).push({ feed: f, trip, k, base, arr: base + trip.arr[k], dep: base + trip.dep[k] });
        }
      }
    }
  }
  const eventsNear = (lat, lon) => {
    const r = Math.floor(lat / CELL), c = Math.floor(lon / CELL), out = [];
    for (let i = r - 1; i <= r + 1; i++) {
      for (let j = c - 1; j <= c + 1; j++) {
        for (const e of index.get(i * 100000 + j) ?? []) {
          const s = e.trip.stop[e.k];
          if (dist(lat, lon, e.feed.stops.lat[s], e.feed.stops.lon[s]) <= SAME_PLACE) out.push(e);
        }
      }
    }
    return out;
  };
  // Halt einer ausländischen Fahrt in die Schweizer Halteliste übernehmen
  const addStop = (f, s) => {
    const id = `foreign:${f.stops.id[s]}`;
    let k = data.stopIndex.get(id);
    if (k === undefined) {
      k = S.id.length;
      data.stopIndex.set(id, k);
      S.id.push(id); S.name.push(f.stops.name[s]); S.lat.push(f.stops.lat[s]); S.lon.push(f.stops.lon[s]); S.parent.push(id);
    }
    return k;
  };

  let extended = 0;
  for (const trip of data.trips.values()) {
    if ((trip.route.mode ?? 'rail') !== 'rail' || trip.stop.length < 2) continue;
    // ersten Tag des Fensters nehmen, an dem die Fahrt verkehrt
    const day = data.days.find((d) => data.services.get(d).has(trip.serviceId));
    if (day === undefined) continue;
    const base = serviceDayStart(day, timeZone) / 1000;
    const n = trip.stop.length;
    const at = (k) => [S.lat[trip.stop[k]], S.lon[trip.stop[k]]];

    // Fortsetzung nach dem letzten Halt
    let after = null;
    for (const e of eventsNear(...at(n - 1))) {
      if (e.k >= e.trip.stop.length - 1 || Math.abs(e.arr - (base + trip.arr[n - 1])) > TOLERANCE) continue;
      const prev = eventsNear(...at(n - 2)).find((p) => p.trip === e.trip && p.k < e.k && Math.abs(p.dep - (base + trip.dep[n - 2])) <= TOLERANCE);
      if (prev) { after = e; break; }
    }
    // Herkunft vor dem ersten Halt
    let before = null;
    for (const e of eventsNear(...at(0))) {
      if (e.k === 0 || Math.abs(e.dep - (base + trip.dep[0])) > TOLERANCE) continue;
      const next = eventsNear(...at(1)).find((p) => p.trip === e.trip && p.k > e.k && Math.abs(p.arr - (base + trip.arr[1])) <= TOLERANCE);
      if (next) { before = e; break; }
    }
    if (!after && !before) continue;

    const rows = [];
    if (before) {
      const f = before.feed, ft = before.trip;
      for (let k = 0; k < before.k; k++) {
        rows.push([trip.seq[0] - (before.k - k), addStop(f, ft.stop[k]), before.base + ft.arr[k] - base, before.base + ft.dep[k] - base]);
      }
    }
    for (let k = 0; k < n; k++) rows.push([trip.seq[k], trip.stop[k], trip.arr[k], trip.dep[k]]);
    if (after) {
      const f = after.feed, ft = after.trip;
      for (let k = after.k + 1; k < ft.stop.length; k++) {
        rows.push([trip.seq[n - 1] + (k - after.k), addStop(f, ft.stop[k]), after.base + ft.arr[k] - base, after.base + ft.dep[k] - base]);
      }
    }
    trip.seq = Int32Array.from(rows, (r) => r[0]);
    trip.stop = Int32Array.from(rows, (r) => r[1]);
    trip.arr = Int32Array.from(rows, (r) => Math.round(r[2]));
    trip.dep = Int32Array.from(rows, (r) => Math.round(r[3]));
    trip.foreign = { before: before ? before.k : 0, after: after ? after.trip.stop.length - after.k - 1 : 0 };
    if (after) trip.headsign = S.name[trip.stop[trip.stop.length - 1]];
    extended++;
  }
  return extended;
}
