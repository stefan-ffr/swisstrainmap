// Liest den statischen GTFS-Fahrplan ein – nur die gewünschten Verkehrsmittel
// und nur Fahrten, die in einem kleinen Datumsfenster verkehren.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readCsv } from './csv.js';
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
    // kompaktes Format aus dem Auszug (siehe gtfs-extract.js)
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
    });
  });

  // Alle Halte der Quelle; trip.stop verweist zunächst auf diese Tabelle
  const all = { id: [], name: [], lat: [], lon: [], parent: [] };
  const allIndex = new Map();
  await readCsv(await src.open('stops.txt'), (r, i) => {
    allIndex.set(r[i.stop_id], all.id.length);
    all.id.push(r[i.stop_id]);
    all.name.push(r[i.stop_name]);
    all.lat.push(Number(r[i.stop_lat]));
    all.lon.push(Number(r[i.stop_lon]));
    all.parent.push(i.parent_station !== undefined ? r[i.parent_station] : '');
  });

  const rows = src.has('stop_times.bin')
    ? await readBinaryStopTimes(src.dir, trips)
    : await readCsvStopTimes(src, trips, allIndex);

  // Nur benutzte Halte behalten und neu nummerieren
  const stops = { id: [], name: [], lat: [], lon: [], parent: [] };
  const remap = new Int32Array(all.id.length).fill(-1);
  const keepStop = (k) => {
    if (remap[k] < 0) {
      remap[k] = stops.id.length;
      const parent = all.parent[k];
      stops.id.push(all.id[k]);
      stops.name.push(all.name[k] || all.name[allIndex.get(parent)] || all.id[k]);
      stops.lat.push(all.lat[k]);
      stops.lon.push(all.lon[k]);
      stops.parent.push(parent || all.id[k]);
    }
    return remap[k];
  };
  // Der Schweizer Feed enthält auch Fahrten, die nie in die Schweiz kommen
  // (z. B. SNCF Paris–Lyon): nur Fahrten mit mindestens einem Halt in bbox behalten.
  const inBox = (k) => !bbox || (all.lat[k] >= bbox[0] && all.lon[k] >= bbox[1] && all.lat[k] <= bbox[2] && all.lon[k] <= bbox[3]);
  let outside = 0;
  for (const [id, trip] of trips) {
    if (!trip.stop || trip.stop.length < 2) { trips.delete(id); continue; }
    if (!trip.stop.some(inBox)) { trips.delete(id); outside++; continue; }
    for (let k = 0; k < trip.stop.length; k++) trip.stop[k] = keepStop(trip.stop[k]);
    for (let k = 0; k < trip.arr.length; k++) {
      if (trip.arr[k] < 0) trip.arr[k] = trip.dep[k];
      if (trip.dep[k] < 0) trip.dep[k] = trip.arr[k];
    }
    fillMissingTimes(trip);
  }
  const stopIndex = new Map(stops.id.map((id, k) => [id, k]));

  const perMode = {};
  for (const t of trips.values()) perMode[t.route.mode] = (perMode[t.route.mode] || 0) + 1;
  const modes = Object.entries(perMode).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n.toLocaleString('de-CH')}`).join(', ');
  log(`GTFS: ${routes.size} Linien, ${trips.size.toLocaleString('de-CH')} Fahrten (${modes}; ${outside} ausserhalb ignoriert), `
    + `${stops.id.length} Halte (${rows.toLocaleString('de-CH')} Haltezeiten gelesen) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  return { days, services, routes, trips, stops, stopIndex };
}

/** Setzt trip.seq/stop/arr/dep (Int32Array) aus nach stop_sequence sortierten Zeilen. */
function setTimes(trip, list) {
  list.sort((a, b) => a[0] - b[0]);
  const n = list.length;
  trip.seq = new Int32Array(n); trip.stop = new Int32Array(n); trip.arr = new Int32Array(n); trip.dep = new Int32Array(n);
  list.forEach(([seq, stop, arr, dep], k) => { trip.seq[k] = seq; trip.stop[k] = stop; trip.arr[k] = arr; trip.dep[k] = dep; });
}

/** stop_times.txt vollständig lesen (normaler GTFS-Feed ohne Auszug). */
async function readCsvStopTimes(src, trips, allIndex) {
  const lists = new Map();
  let rows = 0;
  await readCsv(await src.open('stop_times.txt'), (r, i) => {
    rows++;
    const trip = trips.get(r[i.trip_id]);
    const stop = allIndex.get(r[i.stop_id]);
    if (!trip || stop === undefined) return;
    let list = lists.get(trip);
    if (!list) lists.set(trip, (list = []));
    list.push([Number(r[i.stop_sequence]), stop, parseGtfsTime(r[i.arrival_time]), parseGtfsTime(r[i.departure_time])]);
  });
  for (const [trip, list] of lists) setTimes(trip, list);
  return rows;
}

/**
 * Haltezeiten aus dem Binärformat des Auszugs (siehe gtfs-extract.js): pro
 * Zeile 4 × Int32 (Halt-Index in stops.txt, Ankunft, Abfahrt, stop_sequence);
 * stop_times.idx enthält pro Zeile in trips.txt die erste Zeile und Anzahl.
 * Gelesen werden nur die Bereiche der gesuchten Fahrten.
 */
async function readBinaryStopTimes(dir, trips) {
  const REC = 16;
  const index = await fsp.readFile(path.join(dir, 'stop_times.idx'));
  const ranges = [];
  for (const trip of trips.values()) {
    const start = index.readUInt32LE(trip.row * 8), count = index.readUInt32LE(trip.row * 8 + 4);
    if (count > 0) ranges.push([start, count, trip]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const fh = await fsp.open(path.join(dir, 'stop_times.bin'));
  let rows = 0;
  try {
    const GAP = 256, MAX = 1 << 19; // in Zeilen: Lücken bis 4 KB mitlesen, Blöcke bis 8 MB
    let buf = Buffer.alloc(MAX * REC);
    for (let k = 0; k < ranges.length;) {
      const first = k;
      const start = ranges[k][0];
      let end = start + ranges[k][1];
      k++;
      while (k < ranges.length && ranges[k][0] - end < GAP && ranges[k][0] + ranges[k][1] - start < MAX) {
        end = Math.max(end, ranges[k][0] + ranges[k][1]);
        k++;
      }
      const bytes = (end - start) * REC;
      if (bytes > buf.length) buf = Buffer.alloc(bytes);
      await fh.read(buf, 0, bytes, start * REC);
      const data = new Int32Array(buf.buffer, buf.byteOffset, bytes / 4);
      for (let j = first; j < k; j++) {
        const [rStart, count, trip] = ranges[j];
        const list = [];
        for (let r = 0; r < count; r++) {
          const o = (rStart - start + r) * 4;
          list.push([data[o + 3], data[o], data[o + 1], data[o + 2]]);
        }
        setTimes(trip, list);
        rows += count;
      }
    }
  } finally {
    await fh.close();
  }
  return rows;
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
