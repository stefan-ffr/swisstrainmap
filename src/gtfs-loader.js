// Liest den statischen GTFS-Fahrplan ein – nur Bahn-Linien und nur Fahrten,
// die in einem kleinen Datumsfenster verkehren, damit der Speicher klein bleibt.
import { readCsv } from './csv.js';
import { addDays, parseGtfsTime, weekday } from './time.js';

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
 * @param options { routeTypes:Set<number>, centerDay:number (YYYYMMDD), log }
 */
export async function loadGtfs(src, { routeTypes, centerDay, log = console.log }) {
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
    routes.set(route.id, route);
  });

  const trips = new Map();
  await readCsv(await src.open('trips.txt'), (r, i) => {
    const route = routes.get(r[i.route_id]);
    if (!route) return;
    const serviceId = r[i.service_id];
    if (!usedServices.has(serviceId)) return;
    trips.set(r[i.trip_id], {
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
  await readCsv(await src.open('stop_times.txt'), (r, i) => {
    rows++;
    const trip = trips.get(r[i.trip_id]);
    if (!trip) return;
    const stopId = r[i.stop_id];
    neededStops.add(stopId);
    trip.raw.push([Number(r[i.stop_sequence]), stopId, parseGtfsTime(r[i.arrival_time]), parseGtfsTime(r[i.departure_time])]);
  });

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

  for (const [id, trip] of trips) {
    const raw = trip.raw.filter((x) => stopIndex.has(x[1])).sort((a, b) => a[0] - b[0]);
    delete trip.raw;
    if (raw.length < 2) { trips.delete(id); continue; }
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

  log(`GTFS: ${routes.size} Bahnlinien, ${trips.size} Fahrten, ${stops.id.length} Halte `
    + `(${rows.toLocaleString('de-CH')} stop_times gelesen) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  return { days, services, routes, trips, stops, stopIndex };
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
