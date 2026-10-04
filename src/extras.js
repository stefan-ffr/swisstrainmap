// Protokoll der Extrafahrten (Zusatzfahrten aus GTFS-RT): GTFS-RT enthält eine
// Fahrt nur, solange sie läuft – damit man Extrafahrten auch nachträglich
// findet, merkt sich der Server jede, die er sieht. Gespeichert in einer
// JSON-Datei, damit das Protokoll Neustarts übersteht.
import fsp from 'node:fs/promises';
import path from 'node:path';

const KEEP_DAYS = 2; // heute und gestern

export class ExtraLog {
  constructor(file, log = console.log) {
    this.file = file;
    this.log = log;
    this.entries = new Map(); // `${tripId}|${day}` -> Eintrag
    this.saving = null;
  }

  async load() {
    try {
      const list = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      for (const e of list) this.entries.set(`${e.tripId}|${e.day}`, e);
    } catch { /* noch kein Protokoll */ }
  }

  /**
   * Übernimmt die aktuellen Zusatzfahrten (Timetable.added) samt Prognose.
   * @param trips    Iterable der Fahrten aus Timetable.added
   * @param expected (trip) -> { A, D } erwartete Zeiten in s relativ zum Betriebstag
   */
  record(trips, expected, stops, now = Date.now()) {
    let changed = false;
    for (const trip of trips) {
      const key = `${trip.id}|${trip.day}`;
      const { A, D } = expected(trip);
      const ms = (s) => trip.dayStart + s * 1000;
      const n = trip.stop.length;
      const old = this.entries.get(key);
      this.entries.set(key, {
        tripId: trip.id,
        day: trip.day,
        name: trip.route.shortName || trip.route.category,
        cat: trip.route.category,
        mode: trip.route.mode,
        num: trip.shortName,
        op: trip.route.agency,
        from: stops.name[trip.stop[0]],
        to: stops.name[trip.stop[n - 1]],
        dep: ms(trip.dep[0]),
        arr: ms(trip.arr[n - 1]),
        delay: Math.round(D[0] - trip.dep[0]),
        stops: Array.from(trip.stop, (s, k) => ({
          name: stops.name[s],
          arr: k === 0 ? null : ms(trip.arr[k]),
          dep: k === n - 1 ? null : ms(trip.dep[k]),
          arrRt: k === 0 ? null : ms(A[k]),
          depRt: k === n - 1 ? null : ms(D[k]),
        })),
        firstSeen: old?.firstSeen ?? now,
        lastSeen: now,
      });
      changed = true;
    }
    if (changed) this.save();
  }

  /** Einträge eines Betriebstags, nach Abfahrt sortiert. */
  forDay(day) {
    return [...this.entries.values()].filter((e) => e.day === day).sort((a, b) => a.dep - b.dep);
  }

  prune(today) {
    const y = Math.floor(today / 10000), m = Math.floor(today / 100) % 100, d = today % 100;
    const limit = new Date(Date.UTC(y, m - 1, d - (KEEP_DAYS - 1)));
    const minDay = limit.getUTCFullYear() * 10000 + (limit.getUTCMonth() + 1) * 100 + limit.getUTCDate();
    for (const [key, e] of this.entries) if (e.day < minDay) this.entries.delete(key);
  }

  /** Speichert höchstens einmal gleichzeitig; Fehler nur protokollieren. */
  save() {
    if (this.saving) { this.dirty = true; return; }
    this.saving = (async () => {
      try {
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.part`;
        await fsp.writeFile(tmp, JSON.stringify([...this.entries.values()]));
        await fsp.rename(tmp, this.file);
      } catch (err) {
        this.log(`Extrafahrten: Speichern fehlgeschlagen – ${err.message}`);
      } finally {
        this.saving = null;
        if (this.dirty) { this.dirty = false; this.save(); }
      }
    })();
  }
}
