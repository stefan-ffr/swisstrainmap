// Holt periodisch GTFS-RT Trip Updates (Verspätungen, Ausfälle).
import fsp from 'node:fs/promises';
import path from 'node:path';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { FeedMessage, TripUpdate, TripDescriptor } = GtfsRealtimeBindings.transit_realtime;
const CANCELED = TripDescriptor.ScheduleRelationship.CANCELED;
const ADDED = TripDescriptor.ScheduleRelationship.ADDED;
const SKIPPED = TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED;

// opentransportdata.swiss: je nach Plan 2–5 Abfragen pro Minute; 5/min = alle 12 s.
const MIN_INTERVAL = 12;

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

  /**
   * Fragt den Feed periodisch ab. opentransportdata.swiss erlaubt nur
   * wenige Abfragen pro Minute (je nach Plan 2–5): Abfragen laufen deshalb nie überlappend, bei 429
   * wird gewartet, und der letzte Feed wird in cacheFile gespeichert, damit ein
   * Neustart weder ohne Daten dasteht noch das Limit sofort wieder anfragt.
   */
  async start({ url, apiKey, enabled = false, intervalSeconds, cacheFile, log = console.log }) {
    if (!apiKey && !enabled) {
      log('GTFS-RT: kein API-Key (GTFS_RT_API_KEY) – Karte zeigt Sollpositionen nach Fahrplan.');
      return;
    }
    if (!apiKey) log('GTFS-RT: ohne eigenen Key (GTFS_RT_ENABLED) – Authentisierung muss z. B. ein Proxy ergänzen.');
    this.status.enabled = true;
    const interval = Math.max(MIN_INTERVAL, intervalSeconds) * 1000;

    let wait = 0;
    if (cacheFile) {
      try {
        const stat = await fsp.stat(cacheFile);
        this.ingestBuffer(await fsp.readFile(cacheFile));
        this.status.lastSuccess = stat.mtime.toISOString();
        wait = Math.max(0, stat.mtimeMs + interval - Date.now());
        log(`GTFS-RT: ${this.status.trips} Fahrten aus Cache geladen`);
      } catch { /* kein (gültiger) Cache */ }
    }

    const poll = async () => {
      let next = interval;
      try {
        // Die API leitet auf eine signierte Download-URL (largeapi…) weiter;
        // fetch folgt automatisch und lässt dabei den Authorization-Header weg.
        const headers = { 'Accept-Encoding': 'gzip, deflate' };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const res = await fetch(url, { headers });
        if (res.status === 401 || res.status === 403) {
          next = Math.max(interval, 300_000);
          throw new Error(`${res.status} – API-Key fehlt oder ist ungültig, nächster Versuch in 5 min`);
        }
        if (res.status === 429) {
          next = Math.max(interval, (Number(res.headers.get('retry-after')) || 60) * 1000);
          throw new Error(`429 Rate-Limit – nächster Versuch in ${Math.round(next / 1000)} s`);
        }
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        this.ingestBuffer(buffer);
        if (cacheFile) {
          await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
          await fsp.writeFile(cacheFile, buffer);
        }
      } catch (err) {
        this.status.lastError = `${new Date().toISOString()}: ${err.message}`;
        log(`GTFS-RT: Fehler – ${err.message}`);
      }
      this.timer = setTimeout(poll, next);
      this.timer.unref?.();
    };
    this.timer = setTimeout(poll, wait);
    this.timer.unref?.();
  }
}
