// Berechnet aus Fahrplan (+ optional Echtzeit-Verspätungen) die aktuelle
// Position aller Züge. Jeder Wegpunkt trägt die ID des folgenden Legs
// (Streckengeometrie bis zum nächsten Halt); der Browser interpoliert entlang
// dieser Geometrie bzw. geradlinig, solange sie fehlt.
import { serviceDayStart } from './time.js';
import { ROUTED_MODES } from './modes.js';

// So viele kommende Wegpunkte bekommt der Browser, um selbst flüssig zu animieren.
const LOOKAHEAD = 3;
// Puffer für verspätete Züge, die nach Fahrplan schon angekommen wären.
const MAX_DELAY = 3 * 3600;

export class Timetable {
  constructor(data, timeZone, legStore = null) {
    this.data = data;
    this.timeZone = timeZone;
    if (legStore) {
      // jedem Abschnitt Halt k -> k+1 eine Leg-ID (Streckengeometrie) zuordnen
      const { lat, lon } = data.stops;
      for (const trip of data.trips.values()) {
        if (!ROUTED_MODES.has(trip.route.mode ?? 'rail')) continue; // Bus, Schiff, Seilbahn: Luftlinie
        trip.leg = new Int32Array(trip.stop.length - 1);
        for (let k = 0; k < trip.leg.length; k++) {
          const a = trip.stop[k], b = trip.stop[k + 1];
          trip.leg[k] = legStore.idFor([lat[a], lon[a]], [lat[b], lon[b]]);
        }
      }
    }
    this.days = data.days.map((day) => {
      const active = data.services.get(day);
      const list = [];
      for (const trip of data.trips.values()) {
        if (!active.has(trip.serviceId)) continue;
        list.push({ trip, start: trip.dep[0], end: trip.arr[trip.arr.length - 1] });
      }
      return { day, start: serviceDayStart(day, timeZone), list };
    });
  }

  covers(dayKey) {
    return this.days.some((d) => d.day === dayKey);
  }

  /** Alle Fahrten, die zum Zeitpunkt nowMs unterwegs sein könnten. */
  *candidates(nowMs) {
    for (const d of this.days) {
      const t = (nowMs - d.start) / 1000;
      if (t < -3600 || t > 2 * 86400) continue;
      for (const c of d.list) {
        if (c.start <= t && c.end + MAX_DELAY >= t) yield { trip: c.trip, day: d.day, dayStart: d.start, t };
      }
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

  /** Liste aller fahrenden Züge mit Wegpunkten für die Animation im Browser. */
  positions(nowMs, realtime) {
    const { stops } = this.data;
    const out = [];
    for (const { trip, day, dayStart, t } of this.candidates(nowMs)) {
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
      const next = Math.min(n - 1, dwelling ? k : k + 1);
      const route = trip.route;
      out.push({
        id: `${trip.id}|${day}`,
        name: route.shortName || route.category,
        cat: route.category,
        mode: route.mode ?? 'rail',
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
    const sep = key.lastIndexOf('|');
    const trip = this.data.trips.get(key.slice(0, sep));
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
