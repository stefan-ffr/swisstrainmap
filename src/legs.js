// Verwaltet die Streckengeometrie zwischen aufeinanderfolgenden Halten ("Legs").
// Jedes Haltepaar bekommt eine stabile ID; die Geometrie wird im Hintergrund
// auf dem Gleisnetz berechnet und in einer Datei zwischengespeichert.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { encode, simplify } from './polyline.js';

const SIMPLIFY_M = 2;

export class LegStore {
  constructor(cacheFile, log = console.log) {
    this.cacheFile = cacheFile;
    this.log = log;
    this.ids = new Map();   // key -> id
    this.legs = [];         // id -> { key, a, b, geom }  geom: undefined = offen, '' = keine, sonst Polyline
    this.cache = new Map(); // key -> geom aus Datei
    this.version = Date.now().toString(36);
    this.status = { total: 0, done: 0, routed: 0, running: false, error: null };
  }

  async loadCache() {
    if (!this.cacheFile) return;
    try {
      const obj = JSON.parse(await fsp.readFile(this.cacheFile, 'utf8'));
      for (const [k, v] of Object.entries(obj)) this.cache.set(k, v);
    } catch { /* noch kein Cache */ }
  }

  async saveCache() {
    if (!this.cacheFile) return;
    for (const leg of this.legs) if (leg.geom !== undefined) this.cache.set(leg.key, leg.geom);
    await fsp.mkdir(path.dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.part`;
    await fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(this.cache)));
    await fsp.rename(tmp, this.cacheFile);
  }

  /** ID des Legs von a nach b ([lat, lon]); legt es bei Bedarf an. */
  idFor(a, b) {
    const key = `${a[0].toFixed(5)},${a[1].toFixed(5)}>${b[0].toFixed(5)},${b[1].toFixed(5)}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.legs.length;
      this.ids.set(key, id);
      this.legs.push({ key, a, b, geom: this.cache.get(key) });
    }
    return id;
  }

  /** undefined = noch nicht berechnet, '' = kein Weg gefunden, sonst Polyline. */
  geometry(id) {
    return this.legs[id]?.geom;
  }

  pending() {
    return this.legs.filter((l) => l.geom === undefined);
  }

  updateStatus() {
    this.status.total = this.legs.length;
    this.status.done = this.legs.filter((l) => l.geom !== undefined).length;
    this.status.routed = this.legs.filter((l) => l.geom).length;
  }

  /**
   * Berechnet alle offenen Legs. getNetwork() wird nur aufgerufen, wenn
   * tatsächlich etwas fehlt (das Gleisnetz braucht viel Speicher).
   */
  async computeMissing(getNetwork) {
    if (this.status.running) return;
    const todo = this.pending();
    this.updateStatus();
    if (!todo.length) return;
    this.status.running = true;
    this.status.error = null;
    try {
      const net = await getNetwork();
      this.log(`Gleisnetz: berechne ${todo.length} Streckenabschnitte …`);
      const t0 = Date.now();
      let lastSave = Date.now(), slice = Date.now();
      for (const leg of todo) {
        const coords = net.route(leg.a, leg.b);
        leg.geom = coords ? encode(simplify(coords, SIMPLIFY_M)) : '';
        this.status.done++;
        if (coords) this.status.routed++;
        if (Date.now() - slice > 50) { // Server zwischendurch antworten lassen
          await new Promise((r) => setImmediate(r));
          slice = Date.now();
        }
        if (Date.now() - lastSave > 60_000) { await this.saveCache(); lastSave = Date.now(); }
      }
      await this.saveCache();
      this.updateStatus();
      this.log(`Gleisnetz: ${this.status.routed}/${this.status.total} Abschnitte auf Gleisen, `
        + `Rest Luftlinie (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (err) {
      this.status.error = err.message;
      this.log(`Gleisnetz: Fehler – ${err.message}`);
    } finally {
      this.status.running = false;
    }
  }
}
