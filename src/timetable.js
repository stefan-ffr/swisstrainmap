// Berechnet aus Fahrplan (+ optional Echtzeit-Verspätungen) die aktuelle
// Position aller Züge. Jeder Wegpunkt trägt die ID des folgenden Legs
// (Streckengeometrie bis zum nächsten Halt); der Browser interpoliert entlang
// dieser Geometrie bzw. geradlinig, solange sie fehlt.
import { serviceDayStart } from './time.js';
import { NETWORK_OF } from './modes.js';

// So viele kommende Wegpunkte bekommt der Browser, um selbst flüssig zu animieren.
const LOOKAHEAD = 3;
// Puffer für verspätete Züge, die nach Fahrplan schon angekommen wären.
const MAX_DELAY = 3 * 3600;
// Rasterweite (Grad) des räumlichen Index für Abfragen nach Kartenausschnitt.
const CELL = 0.05;
const cellKey = (r, c) => r * 100000 + c;

export class Timetable {
  constructor(data, timeZone, legStore = null) {
    this.data = data;
    this.timeZone = timeZone;
    this.legStore = legStore;
    this.added = new Map(); // tripId -> Zusatzfahrt aus GTFS-RT
    this.addedVersion = -1;
    if (legStore) {
      // jedem Abschnitt Halt k -> k+1 eine Leg-ID (Streckengeometrie) zuordnen
      const { lat, lon } = data.stops;
      for (const trip of data.trips.values()) {
        const network = legStore.networks.has(NETWORK_OF[trip.route.mode ?? 'rail']) ? NETWORK_OF[trip.route.mode ?? 'rail'] : null;
        if (!network) continue; // Schiff, Seilbahn (oder abgeschaltetes Netz): Luftlinie
        trip.leg = new Int32Array(trip.stop.length - 1);
        for (let k = 0; k < trip.leg.length; k++) {
          const a = trip.stop[k], b = trip.stop[k + 1];
          trip.leg[k] = legStore.idFor([lat[a], lon[a]], [lat[b], lon[b]], network);
        }
      }
    }
    this.days = data.days.map((day) => {
      const active = data.services.get(day);
      const byMode = new Map();
      for (const trip of data.trips.values()) {
        if (!active.has(trip.serviceId)) continue;
        const mode = trip.route.mode ?? 'rail';
        if (!byMode.has(mode)) byMode.set(mode, []);
        byMode.get(mode).push(trip);
      }
      return { day, start: serviceDayStart(day, timeZone), active, byMode };
    });

    // Halte, die von Zügen bedient werden – um bei Zusatzfahrten ohne bekannte
    // Linie zu entscheiden, ob es ein Zug oder ein (Ersatz-)Bus ist.
    this.railStops = new Set();
    for (const trip of data.trips.values()) {
      if ((trip.route.mode ?? 'rail') === 'rail') for (const s of trip.stop) this.railStops.add(s);
    }

    // Räumlicher Index: Rasterzellen, die eine Fahrt zwischen zwei Halten
    // berührt -> Fahrten. Damit werden für einen Kartenausschnitt nur die
    // Fahrten betrachtet, die dort überhaupt vorbeikommen.
    const { lat, lon } = data.stops;
    this.grid = new Map();
    for (const trip of data.trips.values()) {
      const cells = new Set();
      for (let k = 0; k < trip.stop.length; k++) {
        const a = trip.stop[k], b = trip.stop[Math.min(k + 1, trip.stop.length - 1)];
        const r0 = Math.floor(Math.min(lat[a], lat[b]) / CELL), r1 = Math.floor(Math.max(lat[a], lat[b]) / CELL);
        const c0 = Math.floor(Math.min(lon[a], lon[b]) / CELL), c1 = Math.floor(Math.max(lon[a], lon[b]) / CELL);
        if ((r1 - r0 + 1) * (c1 - c0 + 1) > 400) continue; // unplausibel langer Abschnitt (z. B. Nachtzug ins Ausland)
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.add(cellKey(r, c));
      }
      for (const key of cells) {
        let list = this.grid.get(key);
        if (!list) this.grid.set(key, (list = []));
        list.push(trip);
      }
    }
  }

  covers(dayKey) {
    return this.days.some((d) => d.day === dayKey);
  }

  /** Fahrten der gewünschten Verkehrsmittel, die den Ausschnitt [s, w, n, e] berühren. */
  tripsIn(bbox, modes) {
    const seen = new Set();
    const r0 = Math.floor(bbox[0] / CELL), r1 = Math.floor(bbox[2] / CELL);
    const c0 = Math.floor(bbox[1] / CELL), c1 = Math.floor(bbox[3] / CELL);
    if ((r1 - r0 + 1) * (c1 - c0 + 1) > 20000) return null; // Ausschnitt zu gross: kein Gewinn
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (const trip of this.grid.get(cellKey(r, c)) ?? []) {
          if (!modes || modes.has(trip.route.mode ?? 'rail')) seen.add(trip);
        }
      }
    }
    return seen;
  }

  /**
   * Alle Fahrten, die zum Zeitpunkt nowMs unterwegs sein könnten – optional
   * nur bestimmte Verkehrsmittel (Set) und nur im Ausschnitt bbox.
   */
  *candidates(nowMs, { modes = null, bbox = null } = {}) {
    const local = bbox ? this.tripsIn(bbox, modes) : null;
    for (const d of this.days) {
      const t = (nowMs - d.start) / 1000;
      if (t < -3600 || t > 2 * 86400) continue;
      const lists = local ? [local] : [...d.byMode].filter(([m]) => !modes || modes.has(m)).map(([, l]) => l);
      for (const list of lists) {
        for (const trip of list) {
          if (local && !d.active.has(trip.serviceId)) continue;
          if (trip.dep[0] <= t && trip.arr[trip.arr.length - 1] + MAX_DELAY >= t) yield { trip, day: d.day, dayStart: d.start, t };
        }
      }
    }
    for (const trip of this.added.values()) {
      if (modes && !modes.has(trip.route.mode)) continue;
      const t = (nowMs - trip.dayStart) / 1000;
      if (trip.dep[0] <= t && trip.arr[trip.arr.length - 1] + MAX_DELAY >= t) yield { trip, day: trip.day, dayStart: trip.dayStart, t };
    }
  }

  /** Index eines Halts in data.stops; unbekannte Halte werden aus allStops ergänzt. */
  resolveStop(stopId) {
    const { stops, stopIndex, allStops } = this.data;
    let k = stopIndex.get(stopId);
    if (k !== undefined) return k;
    const a = allStops?.index.get(stopId);
    if (a === undefined) return undefined;
    k = stops.id.length;
    stopIndex.set(stopId, k);
    stops.id.push(stopId);
    stops.name.push(allStops.name[a] || stopId);
    stops.lat.push(allStops.lat[a]);
    stops.lon.push(allStops.lon[a]);
    stops.parent.push(allStops.parent[a] || stopId);
    return k;
  }

  /**
   * Zusatzfahrten aus GTFS-RT (schedule_relationship ADDED) in Fahrten
   * umwandeln: Extrazüge, Ersatzbusse … – sie stehen nicht im Fahrplan, ihre
   * Halte und Zeiten kommen nur aus dem Echtzeit-Feed.
   */
  refreshAdded(realtime) {
    if (!realtime?.addedTrips || realtime.version === this.addedVersion) return;
    this.addedVersion = realtime.version;
    this.added.clear();
    for (const a of realtime.addedTrips()) {
      const d = this.days.find((x) => x.day === a.day);
      if (!d) continue;
      const base = d.start / 1000;
      const rows = [];
      for (const u of [...a.updates].sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0))) {
        const k = u.stopId !== undefined ? this.resolveStop(u.stopId) : undefined;
        const arr = u.arrTime ?? u.depTime, dep = u.depTime ?? u.arrTime;
        if (k === undefined || arr === undefined) continue;
        // Plan = Prognose minus Verspätung; die Verspätung wendet expectedTimes wieder an
        rows.push([u.seq ?? rows.length + 1, k, arr - (u.arrDelay ?? u.depDelay ?? 0) - base, dep - (u.depDelay ?? u.arrDelay ?? 0) - base]);
      }
      if (rows.length < 2) continue;
      const known = this.data.routes.get(a.routeId);
      const onRail = rows.filter((r) => this.railStops.has(r[1])).length >= rows.length / 2;
      const route = known ?? {
        id: a.routeId, shortName: 'EXT', longName: '', desc: '', agency: '', category: 'EXT', mode: onRail ? 'rail' : 'bus',
      };
      const n = rows.length;
      const trip = {
        id: a.tripId,
        route,
        serviceId: null,
        added: true,
        day: d.day,
        dayStart: d.start,
        headsign: this.data.stops.name[rows[n - 1][1]],
        shortName: /sjyid:\d+:(\d+)/.exec(a.tripId)?.[1] ?? '',
        seq: Int32Array.from(rows, (r) => r[0]),
        stop: Int32Array.from(rows, (r) => r[1]),
        arr: Int32Array.from(rows, (r) => Math.round(r[2])),
        dep: Int32Array.from(rows, (r) => Math.round(Math.max(r[2], r[3]))),
      };
      const network = this.legStore && NETWORK_OF[route.mode];
      if (network && this.legStore.networks.has(network)) {
        const { lat, lon } = this.data.stops;
        trip.leg = Int32Array.from({ length: n - 1 }, (_, k) => {
          const p = trip.stop[k], q = trip.stop[k + 1];
          return this.legStore.idFor([lat[p], lon[p]], [lat[q], lon[q]], network);
        });
      }
      this.added.set(trip.id, trip);
    }
  }

  /**
   * Erwartete Ankunfts-/Abfahrtszeiten (Sekunden relativ zum Betriebstag)
   * unter Berücksichtigung der Echtzeitdaten.
   */
  expectedTimes(trip, day, dayStart, realtime) {
    const n = trip.arr.length;
    const A = new Float64Array(n), D = new Float64Array(n);
    const rt = realtime?.get(trip.id, day);
    const arrDelay = new Float64Array(n), depDelay = new Float64Array(n);

    if (rt && rt.updates.length) {
      const bySeq = new Map(), byStop = new Map();
      for (let k = 0; k < n; k++) {
        bySeq.set(trip.seq[k], k);
        byStop.set(this.data.stops.id[trip.stop[k]], k);
      }
      const at = new Array(n);
      for (const u of rt.updates) {
        const k = u.seq !== undefined && bySeq.has(u.seq) ? bySeq.get(u.seq) : byStop.get(u.stopId);
        if (k !== undefined) at[k] = u;
      }
      const base = dayStart / 1000;
      let current = null;
      for (let k = 0; k < n; k++) {
        const u = at[k];
        if (u) {
          let a = u.arrDelay ?? (u.arrTime != null ? u.arrTime - (base + trip.arr[k]) : null);
          let d = u.depDelay ?? (u.depTime != null ? u.depTime - (base + trip.dep[k]) : null);
          if (a == null) a = d ?? current ?? 0;
          if (d == null) d = a;
          if (current === null) for (let j = 0; j < k; j++) arrDelay[j] = depDelay[j] = a; // Halte davor
          arrDelay[k] = a;
          depDelay[k] = d;
          current = d;
        } else if (current !== null) {
          arrDelay[k] = depDelay[k] = current;
        }
      }
    }

    for (let k = 0; k < n; k++) {
      A[k] = trip.arr[k] + arrDelay[k];
      D[k] = Math.max(A[k], trip.dep[k] + depDelay[k]);
      if (k > 0 && A[k] < D[k - 1]) { A[k] = D[k - 1]; D[k] = Math.max(D[k], A[k]); }
    }
    A[0] = Math.min(A[0], D[0]);
    return { A, D, arrDelay, depDelay, canceled: !!rt?.canceled };
  }

  /**
   * Fahrende Fahrzeuge mit Wegpunkten für die Animation im Browser.
   * filter: { modes: Set, bbox: [s, w, n, e] } – berechnet werden nur Fahrten
   * dieser Verkehrsmittel, die den Ausschnitt berühren.
   */
  positions(nowMs, realtime, filter = {}) {
    this.refreshAdded(realtime);
    const { stops } = this.data;
    const { bbox } = filter;
    const inBox = (p) => !bbox || (p[0] >= bbox[0] && p[0] <= bbox[2] && p[1] >= bbox[1] && p[1] <= bbox[3]);
    const out = [];
    for (const { trip, day, dayStart, t } of this.candidates(nowMs, filter)) {
      const { A, D, depDelay, arrDelay, canceled } = this.expectedTimes(trip, day, dayStart, realtime);
      if (canceled) continue;
      const n = A.length;
      if (t < D[0] || t > A[n - 1]) continue;

      // letzter Halt k mit Ankunft <= t
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (A[mid] <= t) lo = mid; else hi = mid - 1;
      }
      const k = lo;
      const dwelling = t < D[k];
      const points = [];
      for (let j = k; j < Math.min(n, k + LOOKAHEAD + 1); j++) {
        const s = trip.stop[j];
        points.push([stops.lat[s], stops.lon[s], dayStart + A[j] * 1000, dayStart + D[j] * 1000, trip.leg?.[j] ?? -1]);
      }
      if (!points.some(inBox)) continue;
      const next = Math.min(n - 1, dwelling ? k : k + 1);
      const route = trip.route;
      out.push({
        id: `${trip.id}|${day}`,
        name: route.shortName || route.category,
        cat: route.category,
        mode: route.mode ?? 'rail',
        extra: !!trip.added,
        num: trip.shortName,
        to: trip.headsign || stops.name[trip.stop[n - 1]],
        op: route.agency,
        delay: Math.round(dwelling ? depDelay[k] : arrDelay[next]),
        rt: realtime?.has(trip.id, day) || false,
        at: dwelling ? stops.name[trip.stop[k]] : null,
        next: stops.name[trip.stop[next]],
        points,
      });
    }
    return out;
  }

  /** Detailinfos zu einer Fahrt (Halteliste und Linienverlauf). */
  trip(key, realtime) {
    this.refreshAdded(realtime);
    const sep = key.lastIndexOf('|');
    const trip = this.data.trips.get(key.slice(0, sep)) ?? this.added.get(key.slice(0, sep));
    const day = this.days.find((d) => d.day === Number(key.slice(sep + 1)));
    if (!trip || !day) return null;
    const { stops } = this.data;
    const { A, D, canceled } = this.expectedTimes(trip, day.day, day.start, realtime);
    const list = [];
    for (let k = 0; k < A.length; k++) {
      const s = trip.stop[k];
      list.push({
        name: stops.name[s],
        lat: stops.lat[s],
        lon: stops.lon[s],
        arr: k === 0 ? null : day.start + trip.arr[k] * 1000,
        dep: k === A.length - 1 ? null : day.start + trip.dep[k] * 1000,
        arrRt: k === 0 ? null : day.start + A[k] * 1000,
        depRt: k === A.length - 1 ? null : day.start + D[k] * 1000,
      });
    }
    return {
      id: key,
      name: trip.route.shortName || trip.route.category,
      cat: trip.route.category,
      mode: trip.route.mode ?? 'rail',
      extra: !!trip.added,
      num: trip.shortName,
      to: trip.headsign,
      op: trip.route.agency,
      rt: realtime?.has(trip.id, day.day) || false,
      canceled,
      stops: list,
      legs: trip.leg ? Array.from(trip.leg) : [],
    };
  }
}
