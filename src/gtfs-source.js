// Zugriff auf einen GTFS-Feed als ZIP-Datei oder entpacktes Verzeichnis,
// inkl. Download/Cache des Permalinks von opentransportdata.swiss.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export async function openGtfs(filePath) {
  const stat = await fsp.stat(filePath);
  if (stat.isDirectory()) {
    return {
      dir: filePath,
      has: (name) => fs.existsSync(path.join(filePath, name)),
      open: async (name) => fs.createReadStream(path.join(filePath, name)),
      close: () => {},
    };
  }
  const zip = await new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, z) => (err ? reject(err) : resolve(z)));
  });
  const entries = new Map();
  await new Promise((resolve, reject) => {
    zip.on('entry', (e) => { entries.set(path.basename(e.fileName), e); zip.readEntry(); });
    zip.on('end', resolve);
    zip.on('error', reject);
    zip.readEntry();
  });
  return {
    has: (name) => entries.has(name),
    open: (name) => new Promise((resolve, reject) => {
      const entry = entries.get(name);
      if (!entry) return reject(new Error(`${name} fehlt im GTFS-ZIP`));
      zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s)));
    }),
    close: () => zip.close(),
  };
}

/**
 * Lädt den Feed herunter, wenn es eine neue Version gibt. Der Permalink von
 * opentransportdata.swiss leitet auf eine Datei mit Datum im Namen weiter
 * (z. B. gtfs_fp2026_20260930.zip); ist das Ziel unverändert, wird nicht
 * erneut geladen. Geprüft wird höchstens alle checkHours Stunden.
 */
export async function ensureDownloaded(url, cacheFile, checkHours, log = console.log) {
  // cacheFile.source enthält die zuletzt geladene Datei-URL; ihr Zeitstempel
  // ist der Zeitpunkt der letzten Prüfung. Die ZIP-Datei selbst bleibt
  // unverändert, sonst hielte sich der Auszug (gtfs-extract.js) für veraltet.
  const sourceFile = `${cacheFile}.source`;
  let stat = null;
  try { stat = await fsp.stat(cacheFile); } catch { /* noch kein Cache */ }
  // Zeile 1: geladene Version, Zeile 2: angefragte URL (ändert sich z. B. mit
  // dem Fahrplanjahr – dann sofort prüfen)
  const [known = null, knownUrl = url] = (await fsp.readFile(sourceFile, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const checked = await fsp.stat(sourceFile).then((s) => s.mtimeMs).catch(() => stat?.mtimeMs ?? 0);
  if (stat && knownUrl === url && (Date.now() - checked) / 3600e3 < checkHours) return cacheFile;

  let target = url, head;
  try {
    head = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    const location = head.headers.get('location');
    if (head.status >= 300 && head.status < 400 && location) target = new URL(location, url).href;
  } catch (err) {
    if (stat) {
      log(`GTFS: Versionsprüfung fehlgeschlagen (${err.message}) – verwende vorhandenen Fahrplan`);
      return cacheFile;
    }
    throw err;
  }
  // Ohne Weiterleitung (z. B. ÖBB, gtfs.de) erkennt man eine neue Version an
  // ETag bzw. Last-Modified.
  let version = target;
  if (target === url) {
    if (!head.ok && stat) {
      log(`GTFS: Versionsprüfung fehlgeschlagen (HTTP ${head.status}) – verwende vorhandenen Fahrplan`);
      return cacheFile;
    }
    const validator = head.headers.get('etag') || head.headers.get('last-modified');
    if (validator) version = `${target} ${validator}`;
  }
  if (stat && version !== url && known === version) {
    const now = new Date();
    await fsp.utimes(sourceFile, now, now); // nächste Prüfung erst nach checkHours
    log(`GTFS: Fahrplan ist aktuell (${path.basename(new URL(target).pathname)})`);
    return cacheFile;
  }

  log(`GTFS: lade ${target} …`);
  await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
  const res = await fetch(target, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GTFS-Download fehlgeschlagen: ${res.status} ${res.statusText}`);
  const tmp = `${cacheFile}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  await fsp.rename(tmp, cacheFile);
  await fsp.writeFile(sourceFile, `${version}\n${url}\n`);
  log(`GTFS: gespeichert unter ${cacheFile}`);
  return cacheFile;
}
