import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RailNetwork } from '../src/rail-network.js';
import { encode, decode, simplify } from '../src/polyline.js';

// Knoten in einem lokalen Raster: (x, y) in ~100-m-Schritten um Bern
const P = (x, y) => [46.95 + y * 0.0009, 7.44 + x * 0.0013];

function network(ways, points) {
  const elements = Object.entries(points).map(([id, [lat, lon]]) => ({ type: 'node', id: Number(id), lat, lon }));
  ways.forEach((nodes, i) => elements.push({ type: 'way', id: 1000 + i, nodes }));
  return new RailNetwork({ elements });
}

test('Weg folgt den Gleisen statt der Luftlinie', () => {
  // A ── 1 ── 2 (Bogen nach Norden) ── 3 ── B
  const pts = { 1: P(0, 0), 2: P(10, 4), 3: P(20, 0) };
  const net = network([[1, 2, 3]], pts);
  const path = net.route(P(0, 0), P(20, 0));
  assert.deepEqual(path, [pts[1], pts[2], pts[3]]);
});

test('keine Spitzkehre an einer Weiche', () => {
  // Weiche bei 2: Stammgleis 1-2-3 nach Osten, Abzweig 2-4 nach Nordwesten.
  // Von 1 nach 4 direkt über die Weiche wäre eine Spitzkehre → nur über die
  // Wendeschleife ab 3 erlaubt, obwohl sie viel länger ist.
  const pts = {
    1: P(0, 0), 2: P(10, 0), 3: P(20, 0), 4: P(4, 10),
    5: P(28, 3), 7: P(33, 10), 8: P(32, 18), 9: P(26, 23), 6: P(18, 23), 10: P(11, 18),
  };
  const net = network([[1, 2, 3], [2, 4], [3, 5, 7, 8, 9, 6, 10, 4]], pts);
  const path = net.route(P(0, 0), P(4, 10));
  assert.deepEqual(path, [1, 2, 3, 5, 7, 8, 9, 6, 10, 4].map((id) => pts[id]));
});

test('kein Weg, wenn Gleise fehlen', () => {
  const pts = { 1: P(0, 0), 2: P(5, 0), 3: P(100, 0), 4: P(105, 0) };
  const net = network([[1, 2], [3, 4]], pts);
  assert.equal(net.route(P(0, 0), P(105, 0)), null);
});

test('Polyline-Kodierung und Vereinfachung', () => {
  const coords = [[46.95, 7.44], [46.951, 7.441], [46.952, 7.442], [46.953, 7.4415]];
  assert.deepEqual(decode(encode(coords)), coords);
  // Mittelpunkt einer Geraden fällt weg, der Knick bleibt
  assert.deepEqual(simplify(coords, 2), [coords[0], coords[2], coords[3]]);
});

test('Busnetz: rechtwinklig abbiegen erlaubt, Einbahnstrassen beachtet', async () => {
  const { PROFILES } = await import('../src/rail-network.js');
  // Kreuzung bei 2: 1-2 nach Osten, 2-3 nach Norden (90°). 4-5 ist eine
  // Einbahnstrasse von 4 nach 5; der Weg 5 -> 4 muss den Umweg über 6 nehmen.
  const pts = { 1: P(0, 0), 2: P(10, 0), 3: P(10, 10), 4: P(20, 0), 5: P(30, 0), 6: P(25, 6) };
  const elements = Object.entries(pts).map(([id, [lat, lon]]) => ({ type: 'node', id: Number(id), lat, lon }));
  elements.push(
    { type: 'way', id: 1, nodes: [1, 2, 3] },
    { type: 'way', id: 2, nodes: [4, 5], tags: { oneway: 'yes' } },
    { type: 'way', id: 3, nodes: [5, 6, 4] },
  );
  const net = new RailNetwork({ elements }, PROFILES.road);
  assert.deepEqual(net.route(P(0, 0), P(10, 10)), [pts[1], pts[2], pts[3]]);
  assert.deepEqual(net.route(P(30, 0), P(20, 0)), [pts[5], pts[6], pts[4]]);
  assert.deepEqual(net.route(P(20, 0), P(30, 0)), [pts[4], pts[5]]);
});
