// Wagenzeichnungen von reisezuege.ch (Markus Blaser), mit Erlaubnis verwendet.
// Die Seite führt pro Zugnummer die Komposition als Reihe von Seitenansichten,
// je Fahrplanperiode und Verkehrstagen. Die Bilder sind im Docker-Image
// enthalten (scripts/fetch-drawings.js); Zugseiten werden erst beim Öffnen
// eines Zugs geholt und 30 Tage gespeichert. Abfragen laufen höflich: eine
// gleichzeitig, mindestens 1 s Abstand – reisezuege.ch soll nicht belastet werden.
import fsp from 'node:fs/promises';
import path from 'node:path';

export const BASE = 'https://www.reisezuege.ch/';
const KEEP_DAYS = 30;    // Zugseite
const MISS_DAYS = 2;     // «keine Komposition» bzw. Fehler
const GAP_MS = 1000;     // Abstand zwischen zwei Abfragen

const DAYS = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];
const html = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&([aou])uml;/gi, (m, c) => ({ a: 'ä', o: 'ö', u: 'ü', A: 'Ä', O: 'Ö', U: 'Ü' })[c])
  .replace(/&egrave;/g, 'è').replace(/&eacute;/g, 'é').replace(/&nbsp;/g, ' ');

/** «Montag - Freitag», «Samstag, Sonntag», «Sonntag» -> Wochentage (0 = So) oder null (unbekannt). */
export function parseDays(label) {
  const days = new Set();
  for (const part of label.toLowerCase().split(/,|\bund\b/)) {
    const names = part.match(/[a-zäöü]+/g)?.filter((w) => DAYS.includes(w)) ?? [];
    if (names.length === 2 && /-|–|bis/.test(part)) {
      for (let d = DAYS.indexOf(names[0]); ; d = (d + 1) % 7) { days.add(d); if (d === DAYS.indexOf(names[1])) break; }
    } else for (const n of names) days.add(DAYS.indexOf(n));
  }
  return days.size ? [...days].sort() : null;
}

/** Zugseite (index.php?action=5&znummer=…) -> Kompositionen der aktuellen Fahrplanperiode. */
export function parseTrainPage(text) {
  const s = text.replace(/\s+/g, ' ');
  const blocks = [];
  for (const blk of s.split('color: red;"><b>').slice(1)) {
    const label = html(blk.split('<')[0]).trim();
    const wagons = [];
    for (const m of blk.matchAll(/<img src="images\/zugbilder\/([^"]+)"[^>]*?(?:tfah_id=(\d+)[^>]*?)?alt="([^"]*)"/g)) {
      wagons.push({ file: m[1], id: m[2] ? Number(m[2]) : null, name: html(m[3]) });
    }
    if (wagons.length) blocks.push({ label, days: parseDays(label), wagons });
  }
  return blocks;
}

/** Klasse eines Wagens aus dem Namen («SBB RABe 501 At2» -> '1') wie im formationShortString. */
export function classOf(name) {
  const clean = name.replace(/\([^)]*\)/g, ' ').trim();
  if (/\b(Re|Ae|Ee|Ge|BR|Motorwagen|Lok)\b/.test(clean) && !/\b(R?A?B?De|RABe|RBe|RAe|RABDe|RBDe)\b/.test(clean)) return 'LK';
  const last = clean.split(/\s+/).pop();
  if (/^WR/.test(last)) return 'WR';
  if (/^AB/.test(last)) return '12';
  if (/^A/.test(last)) return '1';
  if (/^B/.test(last)) return '2';
  if (/^D/.test(last)) return 'D';
  return null;
}

export class ReisezuegeStore {
  /** @param bundled Ordner mit den beim Bauen geladenen Bildern (optional) */
  constructor({ dir, bundled = null, base = BASE, log = console.log }) {
    Object.assign(this, { dir, bundled, base, log });
    this.queue = Promise.resolve();
    this.last = 0;
    this.pending = new Map();
    this.status = { enabled: true, requests: 0, lastError: null };
  }

  /** Eine Abfrage nach der anderen, mit Abstand. */
  fetchPolite(url) {
    const run = async () => {
      const wait = this.last + GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      this.status.requests++;
      const res = await fetch(url, { headers: { 'User-Agent': 'swisstransportmap (Karte mit Erlaubnis von reisezuege.ch)' } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Kompositionen eines Zugs (aus dem Zwischenspeicher oder von reisezuege.ch). */
  async train(number) {
    const file = path.join(this.dir, 'zug', `${number}.json`);
    try {
      const cached = JSON.parse(await fsp.readFile(file, 'utf8'));
      const age = (Date.now() - cached.at) / 86400e3;
      if (age < (cached.blocks.length ? KEEP_DAYS : MISS_DAYS)) return cached.blocks;
    } catch { /* noch nicht geladen */ }
    if (this.pending.has(number)) return this.pending.get(number);
    const p = (async () => {
      let blocks = [];
      try {
        const buf = await this.fetchPolite(`${this.base}index.php?action=5&znummer=${encodeURIComponent(number)}`);
        blocks = parseTrainPage(buf.toString('latin1'));
      } catch (err) {
        this.status.lastError = `${new Date().toISOString()}: ${err.message}`;
        this.log(`reisezuege.ch: Zug ${number} – ${err.message}`);
        return [];
      }
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify({ at: Date.now(), blocks }));
      return blocks;
    })().finally(() => this.pending.delete(number));
    this.pending.set(number, p);
    return p;
  }

  /** Komposition für einen Wochentag (0 = So); ohne passende Angabe die erste. */
  async forDay(number, weekday) {
    const blocks = await this.train(number);
    return blocks.find((b) => b.days?.includes(weekday)) ?? blocks.find((b) => !b.days) ?? blocks[0] ?? null;
  }

  /** Bild (lokal zwischengespeichert); null bei ungültigem Namen. */
  async image(name) {
    if (!/^[A-Za-z0-9_.-]+\.(jpe?g|gif|png)$/.test(name)) return null;
    const file = path.join(this.dir, 'img', name);
    for (const f of [this.bundled && path.join(this.bundled, name), file].filter(Boolean)) {
      try {
        return await fsp.readFile(f);
      } catch { /* nicht vorhanden */ }
    }
    const buf = await this.fetchPolite(`${this.base}images/zugbilder/${name}`);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, buf);
    return buf;
  }
}
