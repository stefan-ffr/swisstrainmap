// Fragt einen Feed von opentransportdata.swiss periodisch ab. Die Dienste
// erlauben nur wenige Abfragen pro Minute (je nach Plan 2–5): Abfragen laufen
// deshalb nie überlappend, bei 429 wird gewartet, und der letzte Feed wird in
// cacheFile gespeichert, damit ein Neustart weder ohne Daten dasteht noch das
// Limit sofort wieder anfragt.
import fsp from 'node:fs/promises';
import path from 'node:path';

const MIN_INTERVAL = 12; // s: 5 Abfragen pro Minute

/**
 * @param name     für Meldungen, z. B. 'GTFS-RT'
 * @param status   Objekt, in dem enabled/lastSuccess/lastError gepflegt werden
 * @param ingest   (buffer) => void, wirft bei ungültigen Daten
 * @param forbidden Text für 401/403 (z. B. Hinweis auf das Abo im API-Manager)
 * @returns false, wenn ohne Key und ohne enabled nichts abgefragt wird
 */
export async function startPolling({
  name, url, apiKey, enabled = false, intervalSeconds, cacheFile, status, ingest,
  log = console.log, onUpdate = () => {}, forbidden = 'API-Key fehlt oder ist ungültig', forbiddenWaitSeconds = 300,
}) {
  if (!apiKey && !enabled) return false;
  if (!apiKey) log(`${name}: ohne eigenen Key – Authentisierung muss z. B. ein Proxy ergänzen.`);
  status.enabled = true;
  const interval = Math.max(MIN_INTERVAL, intervalSeconds) * 1000;

  let wait = 0;
  if (cacheFile) {
    try {
      const stat = await fsp.stat(cacheFile);
      ingest(await fsp.readFile(cacheFile));
      status.lastSuccess = stat.mtime.toISOString();
      wait = Math.max(0, stat.mtimeMs + interval - Date.now());
      log(`${name}: aus Cache geladen`);
      onUpdate();
    } catch { /* kein (gültiger) Cache */ }
  }

  const poll = async () => {
    let next = interval;
    try {
      // Die API leitet teils auf eine signierte Download-URL (largeapi…) weiter;
      // fetch folgt automatisch und lässt dabei den Authorization-Header weg.
      const headers = { 'Accept-Encoding': 'gzip, deflate' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(url, { headers });
      if (res.status === 401 || res.status === 403) {
        next = Math.max(interval, forbiddenWaitSeconds * 1000);
        throw new Error(`${res.status} – ${forbidden}, nächster Versuch in ${Math.round(next / 60000)} min`);
      }
      if (res.status === 429) {
        next = Math.max(interval, (Number(res.headers.get('retry-after')) || 60) * 1000);
        throw new Error(`429 Rate-Limit – nächster Versuch in ${Math.round(next / 1000)} s`);
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      ingest(buffer);
      status.lastSuccess = new Date().toISOString();
      status.lastError = null;
      onUpdate();
      if (cacheFile) {
        await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
        await fsp.writeFile(cacheFile, buffer);
      }
    } catch (err) {
      status.lastError = `${new Date().toISOString()}: ${err.message}`;
      log(`${name}: Fehler – ${err.message}`);
    }
    const timer = setTimeout(poll, next);
    timer.unref?.();
  };
  const timer = setTimeout(poll, wait);
  timer.unref?.();
  return true;
}
