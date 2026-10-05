// Störungsmeldungen aus GTFS-SA (GTFS-RT Service Alerts): Unterbrüche,
// Bauarbeiten, Ersatzverkehr … mit den betroffenen Fahrten, Linien und Halten.
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { startPolling } from './feed-poller.js';

const { FeedMessage, Alert } = GtfsRealtimeBindings.transit_realtime;
const CAUSE = Object.fromEntries(Object.entries(Alert.Cause).map(([k, v]) => [v, k]));
const EFFECT = Object.fromEntries(Object.entries(Alert.Effect).map(([k, v]) => [v, k]));

/**
 * Bahnhof hinter einer Halt-ID, damit Meldungen unabhängig von Gleis bzw.
 * Kante passen: ch:1:sloid:3000:7:12, 8503000:0:7, Parent8503000 -> 8503000.
 */
export function stationKey(id) {
  const s = String(id);
  const sloid = /^ch:1:sloid:(\d+)/.exec(s);
  if (sloid) return `85${sloid[1].padStart(5, '0')}`;
  const uic = /^(?:Parent)?(\d{7})(?::|$)/.exec(s);
  if (uic) return uic[1];
  return s;
}

/** Text in der gewünschten Sprache (sonst Deutsch, ohne Sprache, erste). */
function pick(translated, lang) {
  const list = translated?.translation ?? [];
  const by = (l) => list.find((t) => (t.language || '').toLowerCase().startsWith(l));
  return (by(lang) ?? by('de') ?? list.find((t) => !t.language) ?? list[0])?.text?.trim() || '';
}

// header_text -> headerText (Protobuf-JSON mit Originalnamen)
function camelize(v) {
  if (Array.isArray(v)) return v.map(camelize);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [key, val] of Object.entries(v)) out[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = camelize(val);
  return out;
}

const sec = (v) => (v === null || v === undefined || Number(v) === 0 ? null : Number(v) * 1000);

export class AlertStore {
  constructor(lang = 'de') {
    this.lang = lang;
    this.alerts = [];
    this.byTrip = new Map();
    this.byRoute = new Map();
    this.byStop = new Map();
    this.status = { enabled: false, lastSuccess: null, lastError: null, alerts: 0 };
  }

  ingest(feed) {
    const alerts = [], byTrip = new Map(), byRoute = new Map(), byStop = new Map();
    const add = (map, key, a) => {
      if (!map.has(key)) map.set(key, []);
      if (!map.get(key).includes(a)) map.get(key).push(a);
    };
    for (const entity of feed.entity || []) {
      const al = entity.alert;
      if (!al) continue;
      const a = {
        id: entity.id,
        header: pick(al.headerText, this.lang),
        description: pick(al.descriptionText, this.lang),
        url: pick(al.url, this.lang),
        cause: CAUSE[al.cause] ?? 'UNKNOWN_CAUSE',
        effect: EFFECT[al.effect] ?? 'UNKNOWN_EFFECT',
        periods: (al.activePeriod || []).map((p) => [sec(p.start), sec(p.end)]),
        trips: [], routes: [], stops: [], agencies: [],
      };
      for (const e of al.informedEntity || []) {
        if (e.trip?.tripId) {
          a.trips.push(e.trip.tripId);
          add(byTrip, e.trip.tripId, a);
        } else if (e.routeId && !e.stopId) {
          a.routes.push(e.routeId);
          add(byRoute, e.routeId, a);
        } else if (e.stopId) {
          // Halt (evtl. nur für eine Linie): beim Halt anzeigen
          a.stops.push(e.stopId);
          add(byStop, stationKey(e.stopId), a);
        } else if (e.agencyId) {
          a.agencies.push(e.agencyId);
        }
      }
      alerts.push(a);
    }
    Object.assign(this, { alerts, byTrip, byRoute, byStop });
    this.status.alerts = alerts.length;
  }

  /** Protobuf oder GTFS-RT als JSON (snake_case oder camelCase). */
  ingestBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    let k = 0;
    while (k < bytes.length && (bytes[k] === 0x20 || bytes[k] === 0x0a || bytes[k] === 0x0d || bytes[k] === 0x09 || bytes[k] === 0xef || bytes[k] === 0xbb || bytes[k] === 0xbf)) k++;
    const message = bytes[k] === 0x7b // «{»
      ? FeedMessage.fromObject(camelize(JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, ''))))
      : FeedMessage.decode(bytes);
    this.ingest(FeedMessage.toObject(message, { longs: Number }));
  }

  static isActive(a, nowMs) {
    return !a.periods.length || a.periods.some(([s, e]) => (s === null || s <= nowMs) && (e === null || nowMs < e));
  }

  /** Aktive Meldungen, die eine Fahrt als Ganzes betreffen (Fahrt oder Linie). */
  forTrip(tripId, routeId, nowMs) {
    const list = [...(this.byTrip.get(tripId) ?? []), ...(this.byRoute.get(routeId) ?? [])];
    return [...new Set(list)].filter((a) => AlertStore.isActive(a, nowMs));
  }

  /** Aktive Meldungen zu einem Halt (beliebige Halt-ID des Bahnhofs). */
  forStop(stopId, nowMs) {
    return (this.byStop.get(stationKey(stopId)) ?? []).filter((a) => AlertStore.isActive(a, nowMs));
  }

  active(nowMs) {
    return this.alerts.filter((a) => AlertStore.isActive(a, nowMs));
  }

  /** Für die API: Meldung mit lesbaren Namen der betroffenen Linien und Halte. */
  static describe(a, data) {
    const routes = [...new Set(a.routes.map((id) => {
      const r = data?.routes.get(id);
      if (!r) return null;
      return !r.shortName || r.shortName.startsWith(r.category) ? r.shortName || r.category : `${r.category} ${r.shortName}`;
    }).filter(Boolean))];
    const stops = [];
    const seen = new Set();
    for (const id of a.stops) {
      const key = stationKey(id);
      if (seen.has(key)) continue;
      seen.add(key);
      const k = data?.stationIndex?.get(key);
      if (k !== undefined) stops.push({ name: data.stops.name[k], lat: data.stops.lat[k], lon: data.stops.lon[k] });
    }
    const [start, end] = a.periods.reduce(([s, e], [ps, pe]) => [
      s === undefined || (ps ?? -Infinity) < s ? ps : s,
      e === undefined || (pe ?? Infinity) > e ? pe : e,
    ], [undefined, undefined]);
    return {
      id: a.id, header: a.header, description: a.description, url: a.url, cause: a.cause, effect: a.effect,
      start: start ?? null, end: end ?? null, trips: a.trips.length, routes, stops,
    };
  }

  start({ url, apiKey, enabled, intervalSeconds, cacheFile, log = console.log, onUpdate }) {
    return startPolling({
      name: 'GTFS-SA', url, apiKey, enabled, intervalSeconds, cacheFile, log, onUpdate,
      status: this.status,
      ingest: (buffer) => this.ingestBuffer(buffer),
      forbidden: 'kein Zugriff – im API-Manager die Anwendung für «GTFS Service Alerts» abonnieren',
      forbiddenWaitSeconds: 1800,
    });
  }
}
