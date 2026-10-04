import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openGtfs } from '../src/gtfs-source.js';
import { loadGtfs } from '../src/gtfs-loader.js';
import { ensureExtract } from '../src/gtfs-extract.js';
import { modeFilter, ALL_MODES } from '../src/modes.js';

function writeFeed(dir) {
  const files = {
    'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nA,Bahn,https://example.org,Europe/Zurich\n',
    'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type\nR1,A,IC1,,IC,102\nB1,A,31,,B,700\n',
    'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,parent_station\nX,"Bern",46.949,7.439,\nY,"Zürich HB",47.378,8.540,\nZ,"Bus",47.0,8.0,\n',
    // WE: nur Wochenende; WD: werktags, aber nicht am 2026-10-05, dafür am Sonntag 2026-10-04
    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n'
      + 'WE,0,0,0,0,0,1,1,20261001,20261031\nWD,1,1,1,1,1,0,0,20261001,20261031\n',
    'calendar_dates.txt': 'service_id,date,exception_type\nWD,20261005,2\nWD,20261004,1\nONLY,20261003,1\n',
    'trips.txt': 'route_id,service_id,trip_id,trip_headsign,trip_short_name\nR1,WE,T1,Zürich HB,701\nR1,WD,T2,Zürich HB,702\nR1,ONLY,T3,Zürich HB,703\nB1,WD,BUS,Bus,1\n',
    'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n'
      + ['T1', 'T2', 'T3'].map((t) => `${t},08:00:00,08:00:00,X,1\n${t},09:00:00,09:00:00,Y,2\n`).join('')
      + 'BUS,08:00:00,08:00:00,Z,1\nBUS,08:10:00,08:10:00,X,2\n',
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
}

async function loadData(dir, centerDay, modes = ['rail']) {
  const src = await openGtfs(dir);
  return loadGtfs(src, { routeTypes: modeFilter(modes), centerDay, log: () => {} });
}
async function load(dir, centerDay) {
  const data = await loadData(dir, centerDay);
  return Object.fromEntries([...data.services].map(([d, s]) => [d, [...s].sort()]));
}
const times = (data) => Object.fromEntries([...data.trips].map(([id, t]) => [id, [t.route.mode, [...t.arr], [...t.dep]]]));

test('Bahn-Auszug liefert dieselben Verkehrstage und nur Bahnfahrten', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-'));
  const feed = path.join(base, 'feed');
  fs.mkdirSync(feed);
  writeFeed(feed);
  const extract = await ensureExtract(feed, path.join(base, 'rail'), modeFilter(['rail']), () => {});

  assert.ok(fs.existsSync(path.join(extract, 'service_days.txt')));
  assert.ok(!fs.readFileSync(path.join(extract, 'trips.txt'), 'utf8').includes('BUS'));
  assert.ok(!fs.existsSync(path.join(extract, 'stop_times.txt')), 'Haltezeiten nur binär');
  const rail = await loadData(extract, 20261006);
  assert.deepEqual([...rail.trips.keys()].sort(), ['T2']);
  assert.ok(!rail.stops.id.includes('Z'), 'Bushaltestelle nicht geladen');

  for (const day of [20261003, 20261005, 20261006]) {
    assert.deepEqual(await load(extract, day), await load(feed, day), `Tag ${day}`);
  }
  // Fr 2.10. WD · Sa 3.10. WE+ONLY · So 4.10. WE+WD (Zusatztag) · Mo 5.10. nichts (Ausfall)
  assert.deepEqual(await load(extract, 20261004), {
    20261003: ['ONLY', 'WE'], 20261004: ['WD', 'WE'], 20261005: [],
  });
});

test('Auszug mit allen Verkehrsmitteln: Index liefert dieselben Fahrten wie das Original', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-all-'));
  const feed = path.join(base, 'feed');
  fs.mkdirSync(feed);
  writeFeed(feed);
  const extract = await ensureExtract(feed, path.join(base, 'all'), modeFilter(ALL_MODES), () => {});
  assert.ok(fs.existsSync(path.join(extract, 'stop_times.idx')));
  const viaIndex = times(await loadData(extract, 20261006, ALL_MODES));
  const original = times(await loadData(feed, 20261006, ALL_MODES));
  assert.deepEqual(viaIndex, original);
  assert.equal(viaIndex.BUS[0], 'bus');
  assert.equal(viaIndex.T2[0], 'rail');
});
