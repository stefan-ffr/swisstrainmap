import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openGtfs } from '../src/gtfs-source.js';
import { loadGtfs } from '../src/gtfs-loader.js';
import { extendWithForeign } from '../src/foreign.js';

const DAY = 20261003;

async function load(dir) {
  return loadGtfs(await openGtfs(dir), { routeTypes: new Set([2]), centerDay: DAY, log: () => {} });
}

test('Internationale Fahrt wird um den Laufweg im Ausland verlängert', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-'));
  const ch = path.join(base, 'ch');
  execFileSync(process.execPath, ['scripts/make-demo-gtfs.js', ch]);

  // "Ausland": eine Fahrt Freiburg – Basel SBB – Liestal zur Zeit des IR36
  // (Basel ab 05:12, Liestal an 05:22) und eine Fahrt, die 8 Minuten neben
  // dem IR36 um 06:12 liegt (ausserhalb der Toleranz von 3 Minuten).
  const de = path.join(base, 'de');
  fs.mkdirSync(de);
  const files = {
    'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nDB,DB,https://example.org,Europe/Berlin\n',
    'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\nR,DB,IC,,2\n',
    'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nFR,"Freiburg Hbf",47.9977,7.8411\nBS,"Basel SBB (DE)",47.5472,7.5893\nLI,"Liestal (DE)",47.4845,7.7316\n',
    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nA,1,1,1,1,1,1,1,20200101,20991231\n',
    'trips.txt': 'route_id,service_id,trip_id\nR,A,MATCH\nR,A,OTHER\n',
    'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n'
      + 'MATCH,04:40:00,04:40:00,FR,1\nMATCH,05:10:00,05:12:00,BS,2\nMATCH,05:22:00,05:22:00,LI,3\n'
      + 'OTHER,05:50:00,05:50:00,FR,1\nOTHER,06:20:00,06:20:00,BS,2\nOTHER,06:30:00,06:30:00,LI,3\n',
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(de, name), content);

  const data = await load(ch);
  const foreign = [{ name: 'de', data: await load(de) }];
  const n = extendWithForeign(data, foreign, 'Europe/Zurich');
  assert.equal(n, 1);
  const trip = data.trips.get('IR36-0-312'); // Basel ab 05:12
  assert.deepEqual(Array.from(trip.stop, (s) => data.stops.name[s]), ['Freiburg Hbf', 'Basel SBB', 'Liestal', 'Olten', 'Aarau', 'Zürich HB']);
  assert.equal(trip.dep[0], 4 * 3600 + 40 * 60);
  assert.ok(trip.seq[0] < trip.seq[1], 'stop_sequence bleibt aufsteigend');
  assert.equal(data.trips.get('IR36-0-372').stop.length, 5, 'IR36 06:12 bleibt unverändert');
});
