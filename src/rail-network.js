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
way["railway"~"^(rail|narrow_gauge|light_rail|funicular)$"]["service"!~"^(yard|spur)$"](${BBOX});
out body qt; >; out skel qt;`;

const SNAP_RADIUS = 300;      // m: Gleise im Umkreis eines Halts als Start/Ziel
const SNAP_FALLBACK = 2000;   // m: falls im Umkreis nichts liegt
const SNAP_MAX = 30;          // so viele nächste Gleispunkte als Kandidaten
// Max. Richtungsänderung pro Knoten. Schlägt die strenge Suche fehl (z. B. wegen
// ungenau gezeichneter Weichen in OSM), wird eine lockerere Grenze versucht.
const TURN_LIMITS = [70, 110].map((deg) => Math.cos((deg * Math.PI) / 180));
const CELL = 0.003;           // Grad, Rasterweite des räumlichen Index

/** Lädt das Gleisnetz per Overpass, falls kein aktueller Cache existiert. */
export async function ensureRailOsm(url, cacheFile, maxAgeDays, log = console.log) {
  try {
    const stat = await fsp.stat(cacheFile);
    if ((Date.now() - stat.mtimeMs) / 86400e3 < maxAgeDays) return cacheFile;
  } catch { /* noch kein Cache */ }
  log(`Gleisnetz: lade OSM-Daten von ${url} (kann einige Minuten dauern) …`);
  await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: OVERPASS_QUERY }),
  });
  if (!res.ok) throw new Error(`Overpass: ${res.status} ${res.statusText}`);
  const tmp = `${cacheFile}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  await fsp.rename(tmp, cacheFile);
  log(`Gleisnetz: gespeichert unter ${cacheFile}`);
  return cacheFile;
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

export class RailNetwork {
  /** @param osm Overpass-JSON ({ elements: [...] }) */
  constructor(osm) {
    const index = new Map();
    const lat = [], lon = [];
    for (const el of osm.elements) {
      if (el.type !== 'node') continue;
      index.set(el.id, lat.length);
      lat.push(el.lat); lon.push(el.lon);
    }
    const n = lat.length;
    const pairs = [];
    for (const el of osm.elements) {
      if (el.type !== 'way' || !el.nodes) continue;
      for (let k = 1; k < el.nodes.length; k++) {
        const a = index.get(el.nodes[k - 1]), b = index.get(el.nodes[k]);
        if (a === undefined || b === undefined || a === b) continue;
        pairs.push(a, b);
      }
    }

    this.lat = Float64Array.from(lat);
    this.lon = Float64Array.from(lon);
    // ebene Näherung in Metern – für die Schweiz genau genug
    this.kx = 111320 * Math.cos((46.8 * Math.PI) / 180);
    this.ky = 110540;
    this.x = this.lon.map((v) => v * this.kx);
    this.y = this.lat.map((v) => v * this.ky);

    // CSR-Adjazenz mit gerichteten Kanten (jeder Gleisabschnitt in beide Richtungen)
    const deg = new Int32Array(n + 1);
    for (let k = 0; k < pairs.length; k += 2) { deg[pairs[k]]++; deg[pairs[k + 1]]++; }
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
    for (let k = 0; k < pairs.length; k += 2) { add(pairs[k], pairs[k + 1]); add(pairs[k + 1], pairs[k]); }
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

  /** Gleispunkte nahe (lat, lon) als [[knoten, distanz], …]. */
  near(lat, lon, radius = SNAP_RADIUS) {
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
    if (!found.length && radius < SNAP_FALLBACK) return this.near(lat, lon, SNAP_FALLBACK).slice(0, 5);
    return found.slice(0, SNAP_MAX);
  }

  /**
   * Weg auf den Gleisen von a nach b ([lat, lon]) als Koordinatenliste,
   * oder null, wenn kein plausibler Weg gefunden wird.
   */
  route(a, b) {
    for (const minCos of TURN_LIMITS) {
      const path = this.search(a, b, minCos);
      if (path) return path;
    }
    return null;
  }

  search(a, b, minCos) {
    const starts = this.near(a[0], a[1]);
    const targets = new Map(this.near(b[0], b[1]).map(([v, d]) => [v, d]));
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
      for (let e = offset[s]; e < offset[s + 1]; e++) relax(e, d + len[e], -1);
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

export async function loadRailNetwork(file, log = console.log) {
  const t0 = Date.now();
  const net = new RailNetwork(JSON.parse(await fsp.readFile(file, 'utf8')));
  log(`Gleisnetz: ${net.n.toLocaleString('de-CH')} Knoten, ${(net.E / 2).toLocaleString('de-CH')} Abschnitte `
    + `in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return net;
}
