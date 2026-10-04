// Liest den statischen GTFS-Fahrplan ein – nur die gewünschten Verkehrsmittel
// und nur Fahrten, die in einem kleinen Datumsfenster verkehren.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readCsv, parseLine } from './csv.js';
import { addDays, parseGtfsTime, weekday } from './time.js';

import { modeOf } from './modes.js';

export { modeOf };

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Zugkategorie (IC, IR, RE, S, …) aus Linienangaben ableiten. */
export function categoryOf(route) {
  const desc = (route.desc || '').trim();
  if (desc && desc.length <= 4) return desc.toUpperCase();
  const m = /^[A-Za-z]+/.exec(route.shortName || '');
  return m ? m[0].toUpperCase() : 'R';
}

/** Ermittelt pro Datum (YYYYMMDD) die aktiven service_ids. */
async function loadServices(src, days) {
  const active = new Map(days.map((d) => [d, new Set()]));
  if (src.has('service_days.txt')) {
    // kompaktes Format aus dem Bahn-Auszug (siehe gtfs-extract.js)
    const dayNumber = (key) => Date.UTC(Math.floor(key / 10000), Math.floor(key / 100) % 100 - 1, key % 100) / 86400e3;
    await readCsv(await src.open('service_days.txt'), (r, i) => {
      const hex = r[i.days], first = dayNumber(Number(r[i.start_date]));
      for (const d of days) {
        const k = dayNumber(d) - first;
        if (k < 0 || k >= hex.length * 4) continue;
        if (parseInt(hex.substr((k >> 3) * 2, 2), 16) & (1 << (k & 7))) active.get(d).add(r[i.service_id]);
      }
    });
    return active;
  }
  if (src.has('calendar.txt')) {
    await readCsv(await src.open('calendar.txt'), (r, i) => {
      const start = Number(r[i.start_date]), end = Number(r[i.end_date]);
      for (const d of days) {
        if (d < start || d > end) continue;
        if (r[i[WEEKDAYS[weekday(d)]]] === '1') active.get(d).add(r[i.service_id]);
      }
    });
  }
  if (src.has('calendar_dates.txt')) {
    await readCsv(await src.open('calendar_dates.txt'), (r, i) => {
      const set = active.get(Number(r[i.date]));
      if (!set) return;
      if (r[i.exception_type] === '1') set.add(r[i.service_id]);
      else set.delete(r[i.service_id]);
    });
  }
  return active;
}

/**
 * @param src     Ergebnis von openGtfs()
 * @param options { routeTypes: { has(type) } (z. B. modeFilter()), centerDay:number (YYYYMMDD), bbox, log }
 */
export async function loadGtfs(src, { routeTypes, centerDay, bbox = null, log = console.log }) {
  const t0 = Date.now();
  const days = [addDays(centerDay, -1), centerDay, addDays(centerDay, 1)];
  const services = await loadServices(src, days);
  const usedServices = new Set();
  for (const s of services.values()) for (const id of s) usedServices.add(id);

  const agencies = new Map();
  if (src.has('agency.txt')) {
    await readCsv(await src.open('agency.txt'), (r, i) => agencies.set(r[i.agency_id] ?? '', r[i.agency_name]));
  }

  const routes = new Map();
  await readCsv(await src.open('routes.txt'), (r, i) => {
    const type = Number(r[i.route_type]);
    if (!routeTypes.has(type)) return;
    const route = {
      id: r[i.route_id],
      shortName: r[i.route_short_name] || '',
      longName: r[i.route_long_name] || '',
      desc: i.route_desc !== undefined ? r[i.route_desc] : '',
      agency: agencies.get(r[i.agency_id] ?? '') || '',
      type,
    };
    route.category = categoryOf(route);
    route.mode = modeOf(type);
    routes.set(route.id, route);
  });

  const trips = new Map();
  let row = -1;
  await readCsv(await src.open('trips.txt'), (r, i) => {
    row++;
    const route = routes.get(r[i.route_id]);
    if (!route) return;
    const serviceId = r[i.service_id];
    if (!usedServices.has(serviceId)) return;
    trips.set(r[i.trip_id], {
      row,
      id: r[i.trip_id],
      route,
      serviceId,
      headsign: i.trip_headsign !== undefined ? r[i.trip_headsign] : '',
      shortName: i.trip_short_name !== undefined ? r[i.trip_short_name] : '',
      raw: [], // [seq, stopId, arr, dep] – wird unten komprimiert
    });
  });

  const neededStops = new Set();
  let rows = 0;
  const onStopTime = (r, i) => {
    rows++;
    const trip = trips.get(r[i.trip_id]);
    if (!trip) return;
    const stopId = r[i.stop_id];
    neededStops.add(stopId);
    trip.raw.push([Number(r[i.stop_sequence]), stopId, parseGtfsTime(r[i.arrival_time]), parseGtfsTime(r[i.departure_time])]);
  };
  if (src.dir && src.has('stop_times.idx')) await readIndexedStopTimes(src.dir, trips, onStopTime);
  else await readCsv(await src.open('stop_times.txt'), onStopTime);

  const stopIndex = new Map();
  const stops = { id: [], name: [], lat: [], lon: [], parent: [] };
  const allStops = new Map();
  await readCsv(await src.open('stops.txt'), (r, i) => {
    allStops.set(r[i.stop_id], {
      name: r[i.stop_name],
      lat: Number(r[i.stop_lat]),
      lon: Number(r[i.stop_lon]),
      parent: i.parent_station !== undefined ? r[i.parent_station] : '',
    });
  });
  for (const id of neededStops) {
    const s = allStops.get(id);
    if (!s) continue;
    stopIndex.set(id, stops.id.length);
    stops.id.push(id);
    stops.name.push(s.name || allStops.get(s.parent)?.name || id);
    stops.lat.push(s.lat);
    stops.lon.push(s.lon);
    stops.parent.push(s.parent || id);
  }

  // Der Schweizer Feed enthält auch Züge, die nie in die Schweiz fahren
  // (z. B. SNCF Paris–Lyon): nur Fahrten mit mindestens einem Halt in bbox behalten.
  const inBox = (k) => !bbox || (stops.lat[k] >= bbox[0] && stops.lon[k] >= bbox[1] && stops.lat[k] <= bbox[2] && stops.lon[k] <= bbox[3]);
  let outside = 0;
  for (const [id, trip] of trips) {
    const raw = trip.raw.filter((x) => stopIndex.has(x[1])).sort((a, b) => a[0] - b[0]);
    delete trip.raw;
    if (raw.length < 2) { trips.delete(id); continue; }
    if (!raw.some((x) => inBox(stopIndex.get(x[1])))) { trips.delete(id); outside++; continue; }
    const n = raw.length;
    trip.seq = new Int32Array(n);
    trip.stop = new Int32Array(n);
    trip.arr = new Int32Array(n);
    trip.dep = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      const [seq, stopId, a, d] = raw[k];
      trip.seq[k] = seq;
      trip.stop[k] = stopIndex.get(stopId);
      trip.arr[k] = a >= 0 ? a : d;
      trip.dep[k] = d >= 0 ? d : a;
    }
    fillMissingTimes(trip);
  }

  const perMode = {};
  for (const t of trips.values()) perMode[t.route.mode] = (perMode[t.route.mode] || 0) + 1;
  const modes = Object.entries(perMode).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n.toLocaleString('de-CH')}`).join(', ');
  log(`GTFS: ${routes.size} Linien, ${trips.size.toLocaleString('de-CH')} Fahrten (${modes}; ${outside} ausserhalb ignoriert), ${stops.id.length} Halte `
    + `(${rows.toLocaleString('de-CH')} stop_times gelesen) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  return { days, services, routes, trips, stops, stopIndex };
}

/**
 * Liest nur die Haltezeiten der gegebenen Fahrten über stop_times.idx
 * (Byte-Position/-Länge pro Zeile in trips.txt, siehe gtfs-extract.js).
 * Nahe beieinanderliegende Bereiche werden zu grösseren Lesevorgängen
 * zusammengefasst; Zeilen fremder Fahrten darin verwirft onRow selbst.
 */
async function readIndexedStopTimes(dir, trips, onRow) {
  const index = await fsp.readFile(path.join(dir, 'stop_times.idx'));
  const ranges = [];
  for (const trip of trips.values()) {
    const off = index.readDoubleLE(trip.row * 12), len = index.readUInt32LE(trip.row * 12 + 8);
    if (off >= 0 && len > 0) ranges.push([off, off + len]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const fh = await fsp.open(path.join(dir, 'stop_times.txt'));
  try {
    const head = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    const header = head.toString('utf8', 0, bytesRead).split('\n')[0].replace(/^\uFEFF/, '');
    const idx = {};
    parseLine(header).forEach((name, k) => { idx[name.trim()] = k; });
    const GAP = 64 * 1024, MAX = 8 * 1024 * 1024;
    let buf = Buffer.alloc(MAX);
    for (let k = 0; k < ranges.length;) {
      let [start, end] = ranges[k++];
      while (k < ranges.length && ranges[k][0] - end < GAP && ranges[k][1] - start < MAX) end = Math.max(end, ranges[k++][1]);
      if (end - start > buf.length) buf = Buffer.alloc(end - start);
      await fh.read(buf, 0, end - start, start);
      for (const line of buf.toString('utf8', 0, end - start).split('\n')) {
        if (line) onRow(parseLine(line), idx);
      }
    }
  } finally {
    await fh.close();
  }
}

/** Halte ohne Zeiten (-1) linear zwischen den Nachbarn interpolieren. */
function fillMissingTimes(trip) {
  const n = trip.arr.length;
  let last = -1;
  for (let k = 0; k < n; k++) {
    if (trip.arr[k] < 0) continue;
    if (last >= 0 && k - last > 1) {
      const t0 = trip.dep[last], t1 = trip.arr[k];
      for (let j = last + 1; j < k; j++) {
        trip.arr[j] = trip.dep[j] = Math.round(t0 + ((t1 - t0) * (j - last)) / (k - last));
      }
    }
    last = k;
  }
}
