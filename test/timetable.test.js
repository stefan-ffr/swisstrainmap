import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { openGtfs } from '../src/gtfs-source.js';
import { loadGtfs } from '../src/gtfs-loader.js';
import { Timetable } from '../src/timetable.js';
import { RealtimeStore } from '../src/realtime.js';
import { serviceDayStart, parseGtfsTime, addDays } from '../src/time.js';

const TZ = 'Europe/Zurich';
const DAY = 20261003;
let tt;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtfs-'));
  execFileSync(process.execPath, ['scripts/make-demo-gtfs.js', dir]);
  const src = await openGtfs(dir);
  const data = await loadGtfs(src, { routeTypes: new Set([2]), centerDay: DAY, log: () => {} });
  tt = new Timetable(data, TZ);
});

test('Zeitfunktionen', () => {
  assert.equal(parseGtfsTime('25:10:05'), 25 * 3600 + 605);
  assert.equal(parseGtfsTime(''), -1);
  assert.equal(addDays(20261231, 1), 20270101);
  // Sommerzeit: Mitternacht Zürich = 22:00 UTC am Vortag
  assert.equal(new Date(serviceDayStart(20260701, TZ)).toISOString(), '2026-06-30T22:00:00.000Z');
  // Winterzeit
  assert.equal(new Date(serviceDayStart(20260115, TZ)).toISOString(), '2026-01-14T23:00:00.000Z');
});

const at = (hhmm) => serviceDayStart(DAY, TZ) + parseGtfsTime(`${hhmm}:00`) * 1000;
const ir70 = (list) => list.find((t) => t.id === `IR70-0-305|${DAY}`);

test('Zug zwischen zwei Halten wird interpoliert', () => {
  // IR70-0-305: Zürich HB ab 05:05, Zug an 05:29 / ab 05:30, Luzern an 05:51
  const train = ir70(tt.positions(at('05:17'), null));
  assert.ok(train);
  assert.equal(train.next, 'Zug');
  assert.equal(train.at, null);
  assert.equal(train.points.length, 3);
});

test('Zug hält im Bahnhof', () => {
  const train = ir70(tt.positions(at('05:29') + 30_000, null));
  assert.equal(train.at, 'Zug');
});

test('vor Abfahrt und nach Ankunft nicht sichtbar', () => {
  assert.equal(ir70(tt.positions(at('05:04'), null)), undefined);
  assert.equal(ir70(tt.positions(at('05:52'), null)), undefined);
});

function feed(entities) {
  const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
  const msg = FeedMessage.fromObject({ header: { gtfsRealtimeVersion: '2.0', timestamp: 0 }, entity: entities });
  return FeedMessage.encode(msg).finish();
}

test('Verspätung aus GTFS-RT verschiebt die Position', () => {
  const rt = new RealtimeStore();
  rt.ingestBuffer(feed([{
    id: '1',
    tripUpdate: {
      trip: { tripId: 'IR70-0-305', startDate: String(DAY) },
      stopTimeUpdate: [{ stopSequence: 1, departure: { delay: 600 } }],
    },
  }]));
  // nach Fahrplan schon unterwegs, mit 10 Minuten Verspätung noch nicht abgefahren
  assert.ok(ir70(tt.positions(at('05:10'), null)));
  assert.equal(ir70(tt.positions(at('05:10'), rt)), undefined);
  const late = ir70(tt.positions(at('05:52'), rt));
  assert.equal(late.next, 'Luzern');
  assert.equal(late.delay, 600);
  assert.equal(late.rt, true);
});

test('ausgefallene Fahrt wird ausgeblendet', () => {
  const rt = new RealtimeStore();
  rt.ingestBuffer(feed([{ id: '1', tripUpdate: { trip: { tripId: 'IR70-0-305', startDate: String(DAY), scheduleRelationship: 'CANCELED' } } }]));
  assert.equal(ir70(tt.positions(at('05:17'), rt)), undefined);
});

test('Fahrtdetails', () => {
  const trip = tt.trip(`IR70-0-305|${DAY}`, null);
  assert.deepEqual(trip.stops.map((s) => s.name), ['Zürich HB', 'Zug', 'Luzern']);
  assert.equal(trip.stops[0].dep, at('05:05'));
  assert.equal(tt.trip('gibtsnicht|1', null), null);
});
