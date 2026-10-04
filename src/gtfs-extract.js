// Erstellt einmal pro Fahrplan-Version einen Auszug des Landesfahrplans für die
// gewünschten Verkehrsmittel (route_types). Der Auszug ist so aufgebaut, dass
// Starts und Tageswechsel schnell gehen:
//  - service_days.txt: Verkehrstage als Bitmaske statt calendar(_dates).txt
//    (im Schweizer Feed allein 11 Mio. Ausnahme-Zeilen),
//  - stop_times.idx: pro Zeile in trips.txt Byte-Position und -Länge der
//    zugehörigen Haltezeiten in stop_times.txt; der Loader liest damit nur die
//    Fahrten der benötigten Tage statt aller ~42 Mio. Zeilen.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { readCsv, parseLine } from './csv.js';
import { openGtfs } from './gtfs-source.js';
import { addDays, weekday } from './time.js';

const VERSION = 3;
const stripBom = (line) => line.replace(/^﻿/, '');

// Schreibt synchron aus dem CSV-Callback; die Festplatte ist schneller als das
// Parsen, daher bleibt der Puffer des Streams klein.
class Writer {
  constructor(file) {
    this.out = fs.createWriteStream(file);
    this.bytes = 0;
  }
  line(text) {
    const s = `${text}\n`;
    this.bytes += Buffer.byteLength(s);
    this.out.write(s);
  }
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

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const dayNumber = (key) => Date.UTC(Math.floor(key / 10000), Math.floor(key / 100) % 100 - 1, key % 100) / 86400e3;

/**
 * Ersetzt calendar.txt + calendar_dates.txt durch service_days.txt: pro
 * service_id eine Bitmaske der Verkehrstage (Hex, Bit k = start_date + k Tage).
 * Zwei Durchgänge über calendar_dates.txt (Datumsbereich, dann Ausnahmen
 * anwenden), damit die Millionen Ausnahmen nie gleichzeitig im Speicher liegen.
 */
async function writeServiceDays(src, outDir, services) {
  let min = Infinity, max = -Infinity;
  const calendars = [];
  if (src.has('calendar.txt')) {
    await readCsv(await src.open('calendar.txt'), (r, i) => {
      if (!services.has(r[i.service_id])) return;
      const start = Number(r[i.start_date]), end = Number(r[i.end_date]);
      calendars.push([r[i.service_id], start, end, WEEKDAYS.map((d) => r[i[d]] === '1')]);
      min = Math.min(min, start); max = Math.max(max, end);
    });
  }
  if (src.has('calendar_dates.txt')) {
    await readCsv(await src.open('calendar_dates.txt'), (r, i) => {
      const date = Number(r[i.date]);
      if (date < min || date > max) {
        if (!services.has(r[i.service_id])) return;
        min = Math.min(min, date); max = Math.max(max, date);
      }
    });
  }
  if (!Number.isFinite(min)) return;
  const first = dayNumber(min);
  const bytes = Math.ceil((dayNumber(max) - first + 1) / 8);
  const masks = new Map();
  const mask = (id) => {
    let m = masks.get(id);
    if (!m) masks.set(id, (m = new Uint8Array(bytes)));
    return m;
  };
  for (const [id, start, end, days] of calendars) {
    const m = mask(id);
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (!days[weekday(d)]) continue;
      const k = dayNumber(d) - first;
      m[k >> 3] |= 1 << (k & 7);
    }
  }
  calendars.length = 0;
  if (src.has('calendar_dates.txt')) {
    await readCsv(await src.open('calendar_dates.txt'), (r, i) => {
      const id = r[i.service_id];
      if (!services.has(id)) return;
      const m = mask(id), k = dayNumber(Number(r[i.date])) - first;
      if (r[i.exception_type] === '1') m[k >> 3] |= 1 << (k & 7); else m[k >> 3] &= ~(1 << (k & 7));
    });
  }
  const w = new Writer(path.join(outDir, 'service_days.txt'));
  w.line('service_id,start_date,days');
  for (const [id, m] of masks) w.line(`"${id.replace(/"/g, '""')}",${min},${Buffer.from(m).toString('hex')}`);
  await w.close();
}

export async function ensureExtract(sourceFile, outDir, routeTypes, log = console.log) {
  const stat = await fsp.stat(sourceFile);
  const meta = {
    version: VERSION,
    source: path.resolve(sourceFile),
    size: stat.isDirectory() ? 0 : stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    modes: routeTypes.modes ?? [...routeTypes].sort((a, b) => a - b),
  };
  try {
    const old = JSON.parse(await fsp.readFile(path.join(outDir, 'meta.json'), 'utf8'));
    if (JSON.stringify(old) === JSON.stringify(meta)) return outDir;
  } catch { /* noch kein Auszug */ }

  const t0 = Date.now();
  log('GTFS: erstelle Auszug (einmal pro Fahrplan-Version) …');
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

    // trip_id -> Zeilennummer im Auszug (für den Index)
    const trips = new Map(), services = new Set();
    await filterFile(src, 'trips.txt', tmp, (r, i) => {
      if (!routes.has(r[i.route_id])) return false;
      trips.set(r[i.trip_id], trips.size);
      services.add(r[i.service_id]);
      return true;
    });

    // stop_times: Zeilen nur zerlegen, wenn die Fahrt im Auszug ist; Position merken
    const offset = new Float64Array(trips.size).fill(-1);
    const length = new Uint32Array(trips.size);
    let contiguous = true, current = -1;
    const stops = new Set();
    const w = new Writer(path.join(tmp, 'stop_times.txt'));
    let tripCol = 0, stopCol = 0, kept = 0;
    await readCsv(await src.open('stop_times.txt'), (_, idx, line) => {
      const id = tripCol === 0 ? firstField(line) : parseLine(line)[tripCol];
      const k = trips.get(id);
      if (k === undefined) return;
      if (k !== current) {
        if (offset[k] >= 0) contiguous = false; // Fahrt taucht ein zweites Mal auf
        offset[k] = w.bytes;
        current = k;
      }
      stops.add(parseLine(line)[stopCol]);
      const before = w.bytes;
      w.line(line);
      length[k] += w.bytes - before;
      kept++;
    }, {
      parse: false,
      onHeader: (line, idx) => { tripCol = idx.trip_id; stopCol = idx.stop_id; w.line(stripBom(line)); },
    });
    await w.close();
    if (contiguous) {
      const idx = Buffer.alloc(trips.size * 12);
      for (let k = 0; k < trips.size; k++) {
        idx.writeDoubleLE(offset[k], k * 12);
        idx.writeUInt32LE(length[k], k * 12 + 8);
      }
      await fsp.writeFile(path.join(tmp, 'stop_times.idx'), idx);
    } else {
      log('GTFS: stop_times.txt ist nicht nach Fahrten gruppiert – Auszug ohne Index');
    }

    // Halte inkl. übergeordneter Stationen (für Namen)
    const parents = new Set();
    await readCsv(await src.open('stops.txt'), (r, i) => {
      if (stops.has(r[i.stop_id]) && i.parent_station !== undefined && r[i.parent_station]) parents.add(r[i.parent_station]);
    });
    await filterFile(src, 'stops.txt', tmp, (r, i) => stops.has(r[i.stop_id]) || parents.has(r[i.stop_id]));
    await writeServiceDays(src, tmp, services);
    await filterFile(src, 'agency.txt', tmp, () => true);
    await filterFile(src, 'feed_info.txt', tmp, () => true);

    await fsp.writeFile(path.join(tmp, 'meta.json'), JSON.stringify(meta));
    await fsp.rm(outDir, { recursive: true, force: true });
    await fsp.rename(tmp, outDir);
    log(`GTFS: Auszug mit ${trips.size.toLocaleString('de-CH')} Fahrten und `
      + `${kept.toLocaleString('de-CH')} Haltezeiten in ${((Date.now() - t0) / 1000).toFixed(1)} s erstellt`);
    return outDir;
  } finally {
    src.close();
  }
}
