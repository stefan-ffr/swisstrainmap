// Besucherzähler ohne Personendaten: Der Browser schickt eine zufällige
// Kennung mit (X-Client). Gezählt werden Browser, die in der letzten Minute
// abgefragt haben («online»), und verschiedene Besucher pro Tag. Gespeichert
// werden nur Tageszahlen und – damit ein Neustart nicht doppelt zählt – die
// Kennungen des laufenden Tages als Hash mit täglich neuem Zufallswert.
// Keine IP-Adressen, keine Cookies.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const ONLINE_MS = 60_000;
const KEEP_DAYS = 400;
const VALID = /^[A-Za-z0-9-]{8,64}$/;

export class Visitors {
  constructor(file, dayOf, log = console.log) {
    Object.assign(this, { file, dayOf, log });
    this.lastSeen = new Map(); // Kennung -> Zeitpunkt (nur im Speicher)
    this.day = dayOf(Date.now());
    this.salt = crypto.randomBytes(16).toString('hex');
    this.today = new Set();    // Hashes der heutigen Besucher
    this.history = {};         // JJJJMMTT -> Anzahl
    this.peak = { day: null, online: 0 };
    this.dirty = false;
  }

  async load() {
    try {
      const s = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      this.history = s.history ?? {};
      this.peak = s.peak ?? this.peak;
      if (s.day === this.day && s.salt) {
        this.salt = s.salt;
        this.today = new Set(s.today ?? []);
      }
    } catch { /* noch keine Zählung */ }
    const timer = setInterval(() => this.save(), 5 * 60_000);
    timer.unref?.();
  }

  hash(id) {
    return crypto.createHash('sha256').update(this.salt + id).digest('base64url').slice(0, 16);
  }

  /** Abfrage eines Browsers vermerken (ungültige Kennungen werden ignoriert). */
  seen(id, now = Date.now()) {
    if (!id || !VALID.test(id)) return;
    const day = this.dayOf(now);
    if (day !== this.day) {
      this.history[this.day] = this.today.size;
      this.day = day;
      this.salt = crypto.randomBytes(16).toString('hex');
      this.today = new Set();
      this.dirty = true;
    }
    if (!this.lastSeen.has(id) && this.lastSeen.size > 50_000) this.prune(now);
    this.lastSeen.set(id, now);
    const h = this.hash(id);
    if (!this.today.has(h)) { this.today.add(h); this.dirty = true; }
  }

  prune(now = Date.now()) {
    for (const [id, t] of this.lastSeen) if (t < now - ONLINE_MS) this.lastSeen.delete(id);
  }

  stats(now = Date.now()) {
    this.prune(now);
    const online = this.lastSeen.size;
    if (online > this.peak.online) { this.peak = { day: this.dayOf(now), online }; this.dirty = true; }
    const days = Object.keys(this.history).sort();
    return {
      online,
      today: this.dayOf(now) === this.day ? this.today.size : 0,
      yesterday: this.history[days.at(-1)] ?? null,
      peak: this.peak,
      days: Object.fromEntries(days.slice(-30).map((d) => [d, this.history[d]])),
    };
  }

  async save() {
    if (!this.dirty) return;
    this.dirty = false;
    const days = Object.keys(this.history).sort();
    for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete this.history[d];
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.part`;
      await fsp.writeFile(tmp, JSON.stringify({ day: this.day, salt: this.salt, today: [...this.today], history: this.history, peak: this.peak }));
      await fsp.rename(tmp, this.file);
    } catch (err) {
      this.log(`Besucher: Speichern fehlgeschlagen – ${err.message}`);
    }
  }
}
