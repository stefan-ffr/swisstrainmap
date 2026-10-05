// Gleisnetz aus OpenStreetMap und Wegsuche zwischen zwei Halten.
// Gesucht wird mit A* über gerichtete Gleisabschnitte, damit Züge nicht an
// einer Weiche "umkehren" (keine Spitzkehren ausser an Halten).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Grenzgebiet mit: Züge nach Lörrach, Konstanz, Domodossola, Annemasse …
const BBOX = '45.75,5.85,47.85,10.55';
export const OVERPASS_QUERY = `[out:json][timeout:900][maxsize:2000000000];
way["railway"~"^(rail|narrow_gauge|light_rail|funicular|tram|subway)$"]["service"!~"^(yard|spur)$"](${BBOX});
out body qt; >; out skel qt;`;
// Strassen, auf denen laut OSM-Linienverläufen (route=bus/trolleybus) Busse
// fahren – viel kleiner als das ganze Strassennetz und genau die richtigen Wege.
export const ROAD_QUERY = `[out:json][timeout:900][maxsize:2000000000];
rel["route"~"^(bus|trolleybus)$"](${BBOX});
way(r)["highway"];
out body qt; >; out skel qt;`;
// Schiffskurse: In OSM ist jede Verbindung als Weg route=ferry von Steg zu Steg
// über das Wasser gezeichnet (z. B. «Genève - Yvoire").
export const WATER_QUERY = `[out:json][timeout:900][maxsize:2000000000];
way["route"="ferry"](${BBOX});
out body qt; >; out skel qt;`;

const deg = (d) => Math.cos((d * Math.PI) / 180);

/**
 * Netz-Profile:
 *  - snap: Umkreis (m), in dem Netzpunkte als Start/Ziel eines Halts gelten;
 *    fallback: grösserer Umkreis, falls darin nichts liegt; max: so viele
 *    Kandidaten. Bei Gleisen alle im Umkreis – in Bahnhöfen mit mehreren
 *    Bahnen (z. B. Montreux: SBB + MOB) lägen die nächsten sonst alle auf der
 *    falschen Bahn.
 *  - turns: max. Richtungsänderung pro Knoten; schlägt die strenge Suche fehl
 *    (z. B. ungenau gezeichnete Weichen), wird die nächste versucht. Züge
 *    können an Weichen nicht umkehren; Busse biegen rechtwinklig ab, wenden
 *    aber nicht.
 *  - oneway: Einbahnstrassen beachten (ausser oneway:bus/psv=no).
 *  - join: Wegenden, die nicht mit dem Netz verbunden sind, mit Netzpunkten
 *    im Umkreis (m) verbinden – die Fährwege der einzelnen Kurse enden am Steg
 *    meist nur nahe beieinander statt im gleichen Knoten.
 *  - maxDetour: längere Wege verwerfen (Luftlinie statt Umweg über andere
 *    Stege, wenn ein Kurs in OSM fehlt).
 */
export const PROFILES = {
  rail: { name: 'Gleisnetz', query: OVERPASS_QUERY, snap: 300, fallback: 2000, max: 500, turns: [70, 110].map(deg), oneway: false },
  road: { name: 'Busnetz', query: ROAD_QUERY, snap: 80, fallback: 400, max: 60, turns: [150, 175].map(deg), oneway: true },
  water: { name: 'Schiffsnetz', query: WATER_QUERY, snap: 400, fallback: 1500, max: 100, turns: [120, 170].map(deg), oneway: false, join: 250, maxDetour: 3 },
};

// Weg vom Haltepunkt zum Netz zählt mehrfach, damit das Fahrzeug am Halt
// startet und nicht am Netzpunkt, der dem Ziel schon am nächsten liegt.
const SNAP_WEIGHT = 3;
const CELL = 0.003;           // Grad, Rasterweite des räumlichen Index

/**
 * Lädt ein Netz (Gleise oder Busstrassen) per Overpass, falls kein aktueller
 * Cache existiert. Die Server in urls werden der Reihe nach versucht.
 */
export async function ensureRailOsm(urls, cacheFile, maxAgeDays, log = console.log, profile = PROFILES.rail) {
  const OVERPASS_QUERY = profile.query;
  // Bei geänderter Abfrage (z. B. neue Gleisarten) neu laden
  const queryFile = `${cacheFile}.query`;
  const knownQuery = await fsp.readFile(queryFile, 'utf8').catch(() => null);
  try {
    const stat = await fsp.stat(cacheFile);
    if (knownQuery === OVERPASS_QUERY && (Date.now() - stat.mtimeMs) / 86400e3 < maxAgeDays) return cacheFile;
  } catch { /* noch kein Cache */ }
  await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
  const errors = [];
  for (const url of urls) {
    try {
      log(`${profile.name}: lade OSM-Daten von ${url} …`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: OVERPASS_QUERY }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const tmp = `${cacheFile}.part`;
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      // Overpass meldet Abbrüche (Timeout, Speicher) im JSON statt per Statuscode
      const tail = (await fsp.readFile(tmp, 'utf8')).slice(-2000);
      if (/"remark"\s*:\s*"runtime error/.test(tail)) throw new Error('Overpass-Abfrage abgebrochen (runtime error)');
      await fsp.rename(tmp, cacheFile);
      await fsp.writeFile(queryFile, OVERPASS_QUERY);
      log(`${profile.name}: gespeichert unter ${cacheFile}`);
      return cacheFile;
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
      log(`${profile.name}: ${url} fehlgeschlagen – ${err.message}`);
    }
  }
  throw new Error(`${profile.name}: Download fehlgeschlagen (${errors.join('; ')})`);
}

class Heap {
  constructor() { this.f = []; this.id = []; }
  get size() { return this.f.length; }
  push(f, id) {
    const F = this.f, I = this.id;
    let i = F.length;
    F.push(f); I.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (F[p] <= f) break;
      F[i] = F[p]; I[i] = I[p]; i = p;
    }
    F[i] = f; I[i] = id;
  }
  pop() {
    const F = this.f, I = this.id;
    const topF = F[0], topId = I[0];
    const lastF = F.pop(), lastId = I.pop();
    if (F.length) {
      let i = 0;
      const n = F.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && F[c + 1] < F[c]) c++;
        if (F[c] >= lastF) break;
        F[i] = F[c]; I[i] = I[c]; i = c;
      }
      F[i] = lastF; I[i] = lastId;
    }
    this.lastF = topF;
    return topId;
  }
}

/** Overpass-JSON ({ elements }) in Knoten und Wege umwandeln. */
function fromElements(elements) {
  const nodes = new Map(), ways = [];
  for (const el of elements) {
    if (el.type === 'node') nodes.set(el.id, [el.lat, el.lon]);
    else if (el.type === 'way' && el.nodes) ways.push({ nodes: el.nodes, oneway: onewayOf(el.tags || {}) });
  }
  return { nodes, ways };
}

/** 1 = nur in Zeichenrichtung, -1 = nur entgegen, 0 = beide (Busse ausgenommen). */
function onewayOf(tags) {
  if (tags['oneway:bus'] === 'no' || tags['oneway:psv'] === 'no') return 0;
  if (tags.oneway === '-1') return -1;
  if (tags.oneway === 'yes' || tags.oneway === 'true' || tags.oneway === '1') return 1;
  if (tags.junction === 'roundabout' && tags.oneway !== 'no') return 1;
  return 0;
}

/** Verbindet Wegenden mit allen Netzpunkten im Umkreis join (m), ergänzt pairs. */
function joinEnds(ends, lat, lon, pairs, join) {
  const kx = 111320 * Math.cos((46.8 * Math.PI) / 180), ky = 110540;
  const cell = join / ky, grid = new Map();
  const key = (r, c) => r * 100000 + c;
  for (let i = 0; i < lat.length; i++) {
    const k = key(Math.floor(lat[i] / cell), Math.floor(lon[i] / cell));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  const linked = new Set();
  for (let k = 0; k < pairs.length; k += 3) linked.add(pairs[k] * 1e7 + pairs[k + 1]);
  for (const end of ends.flat()) {
    if (end === undefined) continue;
    const r = Math.floor(lat[end] / cell), c = Math.floor(lon[end] / cell);
    for (let i = r - 1; i <= r + 1; i++) {
      for (let j = c - 2; j <= c + 2; j++) {
        for (const v of grid.get(key(i, j)) ?? []) {
          if (v === end || linked.has(end * 1e7 + v) || linked.has(v * 1e7 + end)) continue;
          if (Math.hypot((lon[v] - lon[end]) * kx, (lat[v] - lat[end]) * ky) > join) continue;
          pairs.push(end, v, 0);
          linked.add(end * 1e7 + v);
        }
      }
    }
  }
}

export class RailNetwork {
  /**
   * @param osm     Overpass-JSON ({ elements }) oder { nodes: Map(id -> [lat, lon]), ways: [{ nodes, oneway }] }
   * @param profile Eintrag aus PROFILES
   */
  constructor(osm, profile = PROFILES.rail) {
    this.profile = profile;
    const { nodes, ways } = osm.elements ? fromElements(osm.elements) : osm;
    const index = new Map();
    const lat = [], lon = [];
    const idx = (id) => {
      let i = index.get(id);
      if (i === undefined) {
        const p = nodes.get(id);
        if (!p) return undefined;
        i = lat.length;
        index.set(id, i);
        lat.push(p[0]); lon.push(p[1]);
      }
      return i;
    };
    // pairs: a, b, Richtung (0 beide, 1 a->b, -1 b->a)
    const pairs = [];
    for (const way of ways) {
      const dir = profile.oneway ? way.oneway : 0;
      for (let k = 1; k < way.nodes.length; k++) {
        const a = idx(way.nodes[k - 1]), b = idx(way.nodes[k]);
        if (a === undefined || b === undefined || a === b) continue;
        pairs.push(a, b, dir);
      }
    }
    const n = lat.length;
    if (profile.join) joinEnds(ways.map((w) => [idx(w.nodes[0]), idx(w.nodes.at(-1))]), lat, lon, pairs, profile.join);

    this.lat = Float64Array.from(lat);
    this.lon = Float64Array.from(lon);
    // ebene Näherung in Metern – für die Schweiz genau genug
    this.kx = 111320 * Math.cos((46.8 * Math.PI) / 180);
    this.ky = 110540;
    this.x = this.lon.map((v) => v * this.kx);
    this.y = this.lat.map((v) => v * this.ky);

    // CSR-Adjazenz mit gerichteten Kanten (Abschnitte ohne Einbahn in beide Richtungen)
    const deg = new Int32Array(n + 1);
    for (let k = 0; k < pairs.length; k += 3) {
      if (pairs[k + 2] >= 0) deg[pairs[k]]++;
      if (pairs[k + 2] <= 0) deg[pairs[k + 1]]++;
    }
    const offset = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) offset[i + 1] = offset[i] + deg[i];
    const E = offset[n];
    const fill = offset.slice(0, n);
    const src = new Int32Array(E), dst = new Int32Array(E), len = new Float32Array(E);
    const add = (a, b) => {
      const e = fill[a]++;
      src[e] = a; dst[e] = b;
      len[e] = Math.hypot(this.x[b] - this.x[a], this.y[b] - this.y[a]);
    };
    for (let k = 0; k < pairs.length; k += 3) {
      if (pairs[k + 2] >= 0) add(pairs[k], pairs[k + 1]);
      if (pairs[k + 2] <= 0) add(pairs[k + 1], pairs[k]);
    }
    Object.assign(this, { n, E, offset, src, dst, len });

    // Suchzustand (wird nach jeder Suche selektiv zurückgesetzt)
    this.g = new Float64Array(E).fill(Infinity);
    this.prev = new Int32Array(E).fill(-1);
    this.closed = new Uint8Array(E);

    // Raster für Nächste-Punkte-Suche
    this.grid = new Map();
    for (let i = 0; i < n; i++) {
      if (offset[i + 1] === offset[i]) continue;
      const key = this.cellKey(Math.floor(this.lat[i] / CELL), Math.floor(this.lon[i] / CELL));
      let list = this.grid.get(key);
      if (!list) this.grid.set(key, (list = []));
      list.push(i);
    }
  }

  cellKey(r, c) { return r * 100000 + c; }

  /** Netzpunkte nahe (lat, lon) als [[knoten, distanz], …]. */
  near(lat, lon, radius = this.profile.snap) {
    const px = lon * this.kx, py = lat * this.ky;
    const r = Math.ceil(radius / (CELL * this.ky)) + 1;
    const cr = Math.floor(lat / CELL), cc = Math.floor(lon / CELL);
    const found = [];
    for (let i = cr - r; i <= cr + r; i++) {
      for (let j = cc - Math.ceil(r * 1.5); j <= cc + Math.ceil(r * 1.5); j++) {
        const list = this.grid.get(this.cellKey(i, j));
        if (!list) continue;
        for (const v of list) {
          const d = Math.hypot(this.x[v] - px, this.y[v] - py);
          if (d <= radius) found.push([v, d]);
        }
      }
    }
    found.sort((a, b) => a[1] - b[1]);
    if (!found.length && radius < this.profile.fallback) return this.near(lat, lon, this.profile.fallback).slice(0, 5);
    return found.slice(0, this.profile.max);
  }

  /**
   * Weg auf den Gleisen von a nach b ([lat, lon]) als Koordinatenliste,
   * oder null, wenn kein plausibler Weg gefunden wird.
   */
  route(a, b) {
    for (const minCos of this.profile.turns) {
      const path = this.search(a, b, minCos);
      if (path && this.profile.maxDetour && this.length(path) > this.profile.maxDetour * this.length([a, b]) + 500) return null;
      if (path) return path;
    }
    return null;
  }

  length(coords) {
    let sum = 0;
    for (let i = 1; i < coords.length; i++) {
      sum += Math.hypot((coords[i][1] - coords[i - 1][1]) * this.kx, (coords[i][0] - coords[i - 1][0]) * this.ky);
    }
    return sum;
  }

  search(a, b, minCos) {
    const starts = this.near(a[0], a[1]);
    const targets = new Map(this.near(b[0], b[1]).map(([v, d]) => [v, d * SNAP_WEIGHT]));
    if (!starts.length || !targets.size) return null;

    const { x, y, offset, src, dst, len, g, prev, closed, E } = this;
    const bx = b[1] * this.kx, by = b[0] * this.ky;
    const straight = Math.hypot(a[1] * this.kx - bx, a[0] * this.ky - by);
    const limit = straight * 3 + 5000;
    // zulässig, da jedes Ziel zusätzlich seine Distanz zu b kostet
    const h = (v) => Math.hypot(x[v] - bx, y[v] - by);

    const touched = [];
    const heap = new Heap();
    let bestFinal = Infinity, bestEdge = -1;
    const relax = (e, cost, from) => {
      if (cost >= g[e] || cost > limit) return;
      if (g[e] === Infinity) touched.push(e);
      g[e] = cost; prev[e] = from;
      heap.push(cost + h(dst[e]), e);
    };
    for (const [s, d] of starts) {
      for (let e = offset[s]; e < offset[s + 1]; e++) relax(e, d * SNAP_WEIGHT + len[e], -1);
    }

    while (heap.size) {
      const e = heap.pop();
      if (e === E) break; // bestes Ziel erreicht
      if (closed[e]) continue;
      closed[e] = 1;
      const u = src[e], v = dst[e];
      const fin = targets.get(v);
      if (fin !== undefined && g[e] + fin < bestFinal) {
        bestFinal = g[e] + fin; bestEdge = e;
        heap.push(bestFinal, E);
      }
      const ux = x[v] - x[u], uy = y[v] - y[u], ul = len[e] || 1;
      for (let e2 = offset[v]; e2 < offset[v + 1]; e2++) {
        const w = dst[e2];
        if (w === u) continue;
        const cos = (ux * (x[w] - x[v]) + uy * (y[w] - y[v])) / (ul * (len[e2] || 1));
        if (cos < minCos) continue;
        relax(e2, g[e] + len[e2], e);
      }
    }

    let coords = null;
    if (bestEdge >= 0) {
      const chain = [];
      for (let e = bestEdge; e >= 0; e = prev[e]) chain.push(e);
      chain.reverse();
      coords = [[this.lat[src[chain[0]]], this.lon[src[chain[0]]]]];
      for (const e of chain) coords.push([this.lat[dst[e]], this.lon[dst[e]]]);
    }
    for (const e of touched) { g[e] = Infinity; prev[e] = -1; closed[e] = 0; }
    return coords;
  }
}

/**
 * Liest eine Overpass-JSON-Datei zeilenweise, ohne sie ganz in den Speicher zu
 * laden (das Busnetz ist ~190 MB). Erwartet die Formatierung von Overpass:
 * ein Feld pro Zeile, Knoten-IDs eines Wegs je auf eigener Zeile.
 */
async function parseOverpassFile(file) {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const nodes = new Map(), ways = [];
  let el = null, inNodes = false, inTags = false;
  const field = (line) => {
    const m = /^\s*"([^"]+)":\s*(.*?),?\s*$/.exec(line);
    return m ? [m[1], m[2]] : null;
  };
  const unquote = (v) => (v.startsWith('"') ? JSON.parse(v) : v);
  for await (const line of rl) {
    if (inNodes) {
      if (line.includes(']')) inNodes = false;
      else el.nodes.push(Number(line.trim().replace(/,$/, '')));
      continue;
    }
    if (inTags) {
      if (/^\s*}/.test(line)) { inTags = false; continue; }
      const f = field(line);
      if (f) el.tags[f[0]] = unquote(f[1]);
      continue;
    }
    const t = line.trim();
    if (t === '{') { el = { tags: {} }; continue; }
    if (t === '}' || t === '},') {
      if (el?.type === 'node') nodes.set(el.id, [el.lat, el.lon]);
      else if (el?.type === 'way' && el.nodes) ways.push({ nodes: el.nodes, oneway: onewayOf(el.tags) });
      el = null;
      continue;
    }
    if (!el) continue;
    const f = field(line);
    if (!f) continue;
    const [k, v] = f;
    if (k === 'nodes') { el.nodes = []; inNodes = !v.includes(']'); }
    else if (k === 'tags') inTags = true;
    else if (k === 'type') el.type = unquote(v);
    else if (k === 'id') el.id = Number(v);
    else if (k === 'lat') el.lat = Number(v);
    else if (k === 'lon') el.lon = Number(v);
  }
  return { nodes, ways };
}

export async function loadRailNetwork(file, log = console.log, profile = PROFILES.rail) {
  const t0 = Date.now();
  const net = new RailNetwork(await parseOverpassFile(file), profile);
  log(`${profile.name}: ${net.n.toLocaleString('de-CH')} Knoten, ${net.E.toLocaleString('de-CH')} gerichtete Abschnitte `
    + `in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return net;
}
