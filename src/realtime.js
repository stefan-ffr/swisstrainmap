// Holt periodisch GTFS-RT Trip Updates (Verspätungen, Ausfälle).
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { startPolling } from './feed-poller.js';

const { FeedMessage, TripUpdate, TripDescriptor } = GtfsRealtimeBindings.transit_realtime;
const CANCELED = TripDescriptor.ScheduleRelationship.CANCELED;
const ADDED = TripDescriptor.ScheduleRelationship.ADDED;
const SKIPPED = TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED;

// Fortlaufend über alle Instanzen, damit Zwischenspeicher eine neue Version sicher erkennen.
let feedVersion = 0;

const num = (v) => (v === null || v === undefined ? undefined : Number(v));

export class RealtimeStore {
  constructor() {
    this.byKey = new Map();
    this.status = { enabled: false, lastSuccess: null, lastError: null, trips: 0 };
  }

  get(tripId, day) {
    return this.byKey.get(`${tripId}|${day}`) || this.byKey.get(`${tripId}|*`);
  }

  /** Zusatzfahrten: [{ tripId, day (YYYYMMDD), routeId, updates }] */
  *addedTrips() {
    for (const [key, entry] of this.byKey) {
      if (!entry.added) continue;
      const sep = key.lastIndexOf('|');
      yield { tripId: key.slice(0, sep), day: Number(key.slice(sep + 1)), ...entry };
    }
  }

  has(tripId, day) {
    return this.get(tripId, day) !== undefined;
  }

  /** Übernimmt einen (dekodierten) FeedMessage. */
  ingest(feed) {
    const map = new Map();
    for (const entity of feed.entity || []) {
      const tu = entity.tripUpdate;
      if (!tu?.trip?.tripId) continue;
      const updates = [];
      for (const stu of tu.stopTimeUpdate || []) {
        if (stu.scheduleRelationship === SKIPPED) continue;
        updates.push({
          seq: num(stu.stopSequence),
          stopId: stu.stopId || undefined,
          arrDelay: stu.arrival?.delay != null ? num(stu.arrival.delay) : undefined,
          arrTime: stu.arrival?.time ? num(stu.arrival.time) : undefined,
          depDelay: stu.departure?.delay != null ? num(stu.departure.delay) : undefined,
          depTime: stu.departure?.time ? num(stu.departure.time) : undefined,
        });
      }
      const date = tu.trip.startDate || '*';
      map.set(`${tu.trip.tripId}|${date}`, {
        canceled: tu.trip.scheduleRelationship === CANCELED,
        // Zusatzfahrt, die nicht im Fahrplan steht (Extrazug, Ersatzbus …)
        added: tu.trip.scheduleRelationship === ADDED,
        routeId: tu.trip.routeId || '',
        updates,
      });
    }
    this.byKey = map;
    this.version = ++feedVersion;
    this.status.trips = map.size;
    this.status.lastSuccess = new Date().toISOString();
    this.status.lastError = null;
  }

  ingestBuffer(buffer) {
    this.ingest(FeedMessage.toObject(FeedMessage.decode(new Uint8Array(buffer)), { longs: Number }));
  }

  /** Fragt den Feed periodisch ab (siehe feed-poller.js). */
  async start({ url, apiKey, enabled = false, intervalSeconds, cacheFile, log = console.log, onUpdate = () => {} }) {
    const started = await startPolling({
      name: 'GTFS-RT', url, apiKey, enabled, intervalSeconds, cacheFile, log, onUpdate,
      status: this.status,
      ingest: (buffer) => this.ingestBuffer(buffer),
    });
    if (!started) log('GTFS-RT: kein API-Key (GTFS_RT_API_KEY) – Karte zeigt Sollpositionen nach Fahrplan.');
  }
}
