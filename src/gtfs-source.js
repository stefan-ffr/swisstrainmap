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

/** Lädt den Feed herunter, falls der Cache fehlt oder älter als maxAgeHours ist. */
export async function ensureDownloaded(url, cacheFile, maxAgeHours, log = console.log) {
  try {
    const stat = await fsp.stat(cacheFile);
    const ageHours = (Date.now() - stat.mtimeMs) / 3600e3;
    if (ageHours < maxAgeHours) return cacheFile;
  } catch { /* noch kein Cache */ }

  log(`GTFS: lade ${url} …`);
  await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GTFS-Download fehlgeschlagen: ${res.status} ${res.statusText}`);
  const tmp = `${cacheFile}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  await fsp.rename(tmp, cacheFile);
  log(`GTFS: gespeichert unter ${cacheFile}`);
  return cacheFile;
}
