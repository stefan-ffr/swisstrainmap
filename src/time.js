// Zeit-Hilfsfunktionen für GTFS-Betriebstage in einer festen Zeitzone.

const DAY = 86400;
const formatters = new Map();

function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }));
  }
  return formatters.get(timeZone);
}

/** Lokale Datums-/Zeitbestandteile eines Zeitpunkts (ms) in der Zeitzone. */
export function localParts(ms, timeZone) {
  const parts = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

/** Offset der Zeitzone zu UTC in Sekunden zum Zeitpunkt ms. */
function offsetSeconds(ms, timeZone) {
  const p = localParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 1000);
}

/** "YYYYMMDD" -> Zahl wie 20261003. */
export function dateKey(year, month, day) {
  return year * 10000 + month * 100 + day;
}

export function addDays(key, n) {
  const y = Math.floor(key / 10000), m = Math.floor(key / 100) % 100, d = key % 100;
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function weekday(key) {
  const y = Math.floor(key / 10000), m = Math.floor(key / 100) % 100, d = key % 100;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sonntag
}

/**
 * Referenzzeitpunkt (ms) eines GTFS-Betriebstags: laut Spezifikation
 * "Mittag minus 12 Stunden" – an Tagen mit Zeitumstellung ≠ Mitternacht.
 */
export function serviceDayStart(key, timeZone) {
  const y = Math.floor(key / 10000), m = Math.floor(key / 100) % 100, d = key % 100;
  const noonUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
  const noonLocal = noonUtc - offsetSeconds(noonUtc, timeZone) * 1000;
  return noonLocal - 12 * 3600 * 1000;
}

export function todayKey(ms, timeZone) {
  const p = localParts(ms, timeZone);
  return dateKey(p.year, p.month, p.day);
}

/** "HH:MM:SS" (Stunden dürfen ≥ 24 sein) -> Sekunden, leer -> -1. */
export function parseGtfsTime(s) {
  if (!s) return -1;
  const a = s.trim().split(':');
  if (a.length < 2) return -1;
  return Number(a[0]) * 3600 + Number(a[1]) * 60 + Number(a[2] || 0);
}

export { DAY };
