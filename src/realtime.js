// Holt periodisch GTFS-RT Trip Updates (Verspätungen, Ausfälle).
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { FeedMessage, TripUpdate, TripDescriptor } = GtfsRealtimeBindings.transit_realtime;
const CANCELED = TripDescriptor.ScheduleRelationship.CANCELED;
const SKIPPED = TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED;

const num = (v) => (v === null || v === undefined ? undefined : Number(v));

export class RealtimeStore {
  constructor() {
    this.byKey = new Map();
    this.status = { enabled: false, lastSuccess: null, lastError: null, trips: 0 };
  }

  get(tripId, day) {
    return this.byKey.get(`${tripId}|${day}`) || this.byKey.get(`${tripId}|*`);
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
        updates,
      });
    }
    this.byKey = map;
    this.status.trips = map.size;
    this.status.lastSuccess = new Date().toISOString();
    this.status.lastError = null;
  }

  ingestBuffer(buffer) {
    this.ingest(FeedMessage.toObject(FeedMessage.decode(new Uint8Array(buffer)), { longs: Number }));
  }

  start({ url, apiKey, intervalSeconds, log = console.log }) {
    if (!apiKey) {
      log('GTFS-RT: kein API-Key (GTFS_RT_API_KEY) – Karte zeigt Sollpositionen nach Fahrplan.');
      return;
    }
    this.status.enabled = true;
    const poll = async () => {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}`, 'Accept-Encoding': 'gzip, deflate' },
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        this.ingestBuffer(await res.arrayBuffer());
      } catch (err) {
        this.status.lastError = `${new Date().toISOString()}: ${err.message}`;
        log(`GTFS-RT: Fehler – ${err.message}`);
      }
    };
    poll();
    this.timer = setInterval(poll, intervalSeconds * 1000);
    this.timer.unref?.();
  }
}
