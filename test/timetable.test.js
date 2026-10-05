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
import { ExtraLog } from '../src/extras.js';
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

test('nur Fahrten im Kartenausschnitt werden berechnet', () => {
  const luzern = [47.0, 8.2, 47.1, 8.4]; // Süd, West, Nord, Ost
  const all = tt.positions(at('05:40'), null);
  const local = tt.positions(at('05:40'), null, { bbox: luzern });
  assert.ok(local.length > 0 && local.length < all.length);
  assert.ok(local.every((t) => t.name === 'IR70'), local.map((t) => t.name).join());
  // Verkehrsmittel-Filter
  assert.equal(tt.positions(at('05:40'), null, { modes: new Set(['bus']) }).length, 0);
});

test('Zusatzfahrt aus GTFS-RT (Extrazug) erscheint mit Halten, Zeiten und Verspätung', () => {
  const rt = new RealtimeStore();
  const sec = (hhmm) => Math.round(at(hhmm) / 1000);
  rt.ingestBuffer(feed([{
    id: 'x',
    tripUpdate: {
      trip: { tripId: 'ojp:extra:sjyid:100001:39001-001', startDate: String(DAY), scheduleRelationship: 'ADDED', routeId: 'unbekannt' },
      stopTimeUpdate: [
        { stopSequence: 1, stopId: 'ZH', departure: { time: sec('06:02'), delay: 120 } },
        { stopSequence: 2, stopId: 'ZG', arrival: { time: sec('06:26'), delay: 120 }, departure: { time: sec('06:27'), delay: 120 } },
        { stopSequence: 3, stopId: 'LZ', arrival: { time: sec('06:48'), delay: 120 } },
      ],
    },
  }]));
  const extra = tt.positions(at('06:10'), rt).find((t) => t.extra);
  assert.ok(extra, 'Extrazug unterwegs');
  assert.equal(extra.num, '39001');
  assert.equal(extra.to, 'Luzern');
  assert.equal(extra.next, 'Zug');
  assert.equal(extra.delay, 120);
  assert.equal(extra.mode, 'rail'); // Halte werden von Zügen bedient
  const detail = tt.trip(extra.id, rt);
  assert.deepEqual(detail.stops.map((s) => s.name), ['Zürich HB', 'Zug', 'Luzern']);
  assert.equal(detail.stops[0].dep, at('06:00')); // Plan = Prognose - Verspätung
  assert.equal(detail.stops[0].depRt, at('06:02'));
  // vor der Abfahrt nicht sichtbar
  assert.equal(tt.positions(at('05:59'), rt).find((t) => t.extra), undefined);
});

test('Protokoll der Extrafahrten: bleibt nach Ende der Fahrt und nach Neustart erhalten', async () => {
  const sec = (hhmm) => Math.round(at(hhmm) / 1000);
  const rt = new RealtimeStore();
  rt.ingestBuffer(feed([{
    id: 'x',
    tripUpdate: {
      trip: { tripId: 'ojp:extra:sjyid:100001:39002-001', startDate: String(DAY), scheduleRelationship: 'ADDED' },
      stopTimeUpdate: [
        { stopSequence: 1, stopId: 'BS', departure: { time: sec('20:51') } },
        { stopSequence: 2, stopId: 'OL', arrival: { time: sec('21:16'), delay: 60 } },
      ],
    },
  }]));
  tt.refreshAdded(rt);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'extras-')), 'extras.json');
  const logA = new ExtraLog(file, () => {});
  const expected = (trip) => tt.expectedTimes(trip, trip.day, trip.dayStart, rt);
  logA.record(tt.added.values(), expected, tt.data.stops, 1000);
  logA.record(tt.added.values(), expected, tt.data.stops, 2000);
  // Fahrt ist beendet und nicht mehr im Feed: Eintrag bleibt
  rt.ingestBuffer(feed([]));
  tt.refreshAdded(rt);
  logA.record(tt.added.values(), expected, tt.data.stops, 3000);
  const [e] = logA.forDay(DAY);
  assert.equal(e.num, '39002');
  assert.equal(e.from, 'Basel SBB');
  assert.equal(e.to, 'Olten');
  assert.equal(e.dep, at('20:51'));
  assert.equal(e.firstSeen, 1000);
  assert.equal(e.lastSeen, 2000);
  assert.equal(e.stops[1].arrRt - e.stops[1].arr, 60_000);
  await logA.saving;
  const logB = new ExtraLog(file, () => {});
  await logB.load();
  assert.deepEqual(logB.forDay(DAY), [e]);
  logB.prune(20261010); // eine Woche später: weg
  assert.equal(logB.forDay(DAY).length, 0);
});

test('Fahrplanjahr wechselt am Sonntag zwischen 10. und 16. Dezember', async () => {
  const { timetableYear } = await import('../src/time.js');
  assert.deepEqual([20251213, 20251214, 20261005, 20261212, 20261213, 20271212].map(timetableYear),
    [2025, 2026, 2026, 2026, 2027, 2028]);
});

test('Störungsmeldungen (GTFS-SA) zu Linie, Halt und Fahrt', async () => {
  const { AlertStore, stationKey } = await import('../src/alerts.js');
  assert.equal(stationKey('ch:1:sloid:3000:7:12'), '8503000');
  assert.equal(stationKey('8503000:0:7'), '8503000');
  assert.equal(stationKey('Parent8503000'), '8503000');

  const { FeedMessage, Alert } = GtfsRealtimeBindings.transit_realtime;
  const text = (de, fr) => ({ translation: [{ text: fr, language: 'fr' }, { text: de, language: 'de' }] });
  const s = (hhmm) => at(hhmm) / 1000;
  const buffer = FeedMessage.encode(FeedMessage.fromObject({
    header: { gtfsRealtimeVersion: '2.0', timestamp: s('05:00') },
    entity: [
      { id: 'linie', alert: { headerText: text('Bauarbeiten Zürich–Luzern', 'Travaux'), effect: Alert.Effect.REDUCED_SERVICE,
        activePeriod: [{ start: s('05:00'), end: s('23:00') }], informedEntity: [{ routeId: 'IR70' }] } },
      { id: 'halt', alert: { headerText: text('Lift in Zug ausser Betrieb', 'Ascenseur'), effect: Alert.Effect.ACCESSIBILITY_ISSUE,
        informedEntity: [{ stopId: 'ZG' }] } },
      { id: 'vorbei', alert: { headerText: text('Gestern', 'Hier'), activePeriod: [{ start: s('01:00'), end: s('02:00') }],
        informedEntity: [{ trip: { tripId: 'IR70-0-305' } }] } },
    ],
  })).finish();
  const alerts = new AlertStore('de');
  alerts.ingestBuffer(Buffer.from(buffer));
  assert.equal(alerts.status.alerts, 3);
  assert.equal(alerts.active(at('05:17')).length, 2, 'abgelaufene Meldung nicht aktiv');

  const t = at('05:17');
  const ir = ir70(tt.positions(t, null, {}, alerts));
  assert.equal(ir.alert, true, 'Linie betroffen');
  const detail = tt.trip(`IR70-0-305|${DAY}`, null, alerts, t);
  assert.deepEqual(detail.alerts.map((a) => a.header), ['Bauarbeiten Zürich–Luzern', 'Lift in Zug ausser Betrieb']);
  assert.equal(detail.alertsWhole, 1);
  assert.deepEqual(detail.stops.find((x) => x.name === 'Zug').alerts, [1]);
  assert.equal(detail.alerts[0].routes[0], 'IR70');
  assert.equal(detail.alerts[1].stops[0].name, 'Zug');
});
