import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Visitors } from '../src/visitors.js';

test('Besucherzähler: online, heute, Tageswechsel, Neustart', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vis-')), 'visitors.json');
  let day = 20261021;
  const v = new Visitors(file, () => day, () => {});
  await v.load();
  const t = Date.now();
  v.seen('aaaaaaaa-1', t);
  v.seen('bbbbbbbb-2', t);
  v.seen('aaaaaaaa-1', t + 1000);
  v.seen('<script>', t); // ungültig
  assert.deepEqual([v.stats(t + 2000).online, v.stats(t + 2000).today], [2, 2]);
  assert.equal(v.stats(t + 120_000).online, 0, 'nach einer Minute nicht mehr online');
  await v.save();
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /aaaaaaaa/, 'keine Kennungen im Klartext');

  const again = new Visitors(file, () => day, () => {});
  await again.load();
  again.seen('aaaaaaaa-1', t + 5000);
  assert.equal(again.stats(t + 5000).today, 2, 'Neustart zählt nicht doppelt');

  day = 20261022;
  again.seen('cccccccc-3', t + 86_400_000);
  const s = again.stats(t + 86_400_000);
  assert.equal(s.today, 1);
  assert.equal(s.yesterday, 2);
});
