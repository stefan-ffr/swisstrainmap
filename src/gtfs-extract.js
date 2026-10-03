// Erstellt einmal pro Fahrplan-Version einen Auszug nur mit Bahnfahrten.
// Der Landesfahrplan enthält ~42 Mio. Haltezeiten (Bus, Tram, Schiff …),
// davon sind nur ~10 % Bahn – Starts und Tageswechsel lesen dann nur noch den
// Auszug statt der ganzen ZIP-Datei.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { readCsv, parseLine } from './csv.js';
import { openGtfs } from './gtfs-source.js';

const VERSION = 1;
const stripBom = (line) => line.replace(/^﻿/, '');

// Schreibt synchron aus dem CSV-Callback; die Festplatte ist schneller als das
// Parsen, daher bleibt der Puffer des Streams klein.
class Writer {
  constructor(file) { this.out = fs.createWriteStream(file); }
  line(text) { this.out.write(`${text}\n`); }
  async close() {
    this.out.end();
    await once(this.out, 'finish');
  }
}

/** Schreibt die Kopfzeile und alle Zeilen, für die keep(row, idx) true liefert. */
async function filterFile(src, name, outDir, keep) {
  if (!src.has(name)) return;
  const w = new Writer(path.join(outDir, name));
  await readCsv(await src.open(name), (row, idx, line) => {
    if (keep(row, idx)) w.line(line);
  }, { onHeader: (line) => w.line(stripBom(line)) });
  await w.close();
}

/** Erstes Feld einer Zeile (ohne Anführungszeichen), schneller als parseLine. */
function firstField(line) {
  const end = line.indexOf(',');
  const f = end < 0 ? line : line.slice(0, end);
  return f.charCodeAt(0) === 34 ? f.slice(1, -1) : f;
}

export async function ensureRailExtract(sourceFile, outDir, routeTypes, log = console.log) {
  const stat = await fsp.stat(sourceFile);
  const meta = {
    version: VERSION,
    source: path.resolve(sourceFile),
    size: stat.isDirectory() ? 0 : stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    routeTypes: [...routeTypes].sort((a, b) => a - b),
  };
  try {
    const old = JSON.parse(await fsp.readFile(path.join(outDir, 'meta.json'), 'utf8'));
    if (JSON.stringify(old) === JSON.stringify(meta)) return outDir;
  } catch { /* noch kein Auszug */ }

  const t0 = Date.now();
  log('GTFS: erstelle Bahn-Auszug (einmal pro Fahrplan-Version) …');
  const tmp = `${outDir}.tmp`;
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });
  const src = await openGtfs(sourceFile);
  try {
    const routes = new Set();
    await filterFile(src, 'routes.txt', tmp, (r, i) => {
      if (!routeTypes.has(Number(r[i.route_type]))) return false;
      routes.add(r[i.route_id]);
      return true;
    });

    const trips = new Set(), services = new Set();
    await filterFile(src, 'trips.txt', tmp, (r, i) => {
      if (!routes.has(r[i.route_id])) return false;
      trips.add(r[i.trip_id]);
      services.add(r[i.service_id]);
      return true;
    });

    // stop_times ist riesig: Zeilen nur zerlegen, wenn die Fahrt eine Bahnfahrt ist
    const stops = new Set();
    const w = new Writer(path.join(tmp, 'stop_times.txt'));
    let tripCol = 0, stopCol = 0, kept = 0;
    await readCsv(await src.open('stop_times.txt'), (_, idx, line) => {
      const id = tripCol === 0 ? firstField(line) : parseLine(line)[tripCol];
      if (!trips.has(id)) return;
      stops.add(parseLine(line)[stopCol]);
      w.line(line);
      kept++;
    }, {
      parse: false,
      onHeader: (line, idx) => { tripCol = idx.trip_id; stopCol = idx.stop_id; w.line(stripBom(line)); },
    });
    await w.close();

    // Halte inkl. übergeordneter Stationen (für Namen)
    const parents = new Set();
    await readCsv(await src.open('stops.txt'), (r, i) => {
      if (stops.has(r[i.stop_id]) && i.parent_station !== undefined && r[i.parent_station]) parents.add(r[i.parent_station]);
    });
    await filterFile(src, 'stops.txt', tmp, (r, i) => stops.has(r[i.stop_id]) || parents.has(r[i.stop_id]));
    await filterFile(src, 'calendar.txt', tmp, (r, i) => services.has(r[i.service_id]));
    await filterFile(src, 'calendar_dates.txt', tmp, (r, i) => services.has(r[i.service_id]));
    await filterFile(src, 'agency.txt', tmp, () => true);
    await filterFile(src, 'feed_info.txt', tmp, () => true);

    await fsp.writeFile(path.join(tmp, 'meta.json'), JSON.stringify(meta));
    await fsp.rm(outDir, { recursive: true, force: true });
    await fsp.rename(tmp, outDir);
    log(`GTFS: Bahn-Auszug mit ${trips.size.toLocaleString('de-CH')} Fahrten und `
      + `${kept.toLocaleString('de-CH')} Haltezeiten in ${((Date.now() - t0) / 1000).toFixed(1)} s erstellt`);
    return outDir;
  } finally {
    src.close();
  }
}
