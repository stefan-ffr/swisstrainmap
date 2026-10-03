// Erzeugt einen kleinen, künstlichen Demo-Fahrplan (GTFS als Verzeichnis)
// mit echten Bahnhofskoordinaten – zum Ausprobieren ohne Download.
//   node scripts/make-demo-gtfs.js data/demo-gtfs
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'data/demo-gtfs';

const STOPS = {
  GE: ['Genève', 46.2102, 6.1424], NY: ['Nyon', 46.3836, 6.2393], MO: ['Morges', 46.5113, 6.4945],
  LS: ['Lausanne', 46.5168, 6.6291], RO: ['Romont FR', 46.6929, 6.9187], FR: ['Fribourg/Freiburg', 46.8030, 7.1512],
  BN: ['Bern', 46.9490, 7.4392], OL: ['Olten', 47.3519, 7.9077], AA: ['Aarau', 47.3914, 8.0513],
  ZH: ['Zürich HB', 47.3779, 8.5403], ZF: ['Zürich Flughafen', 47.4504, 8.5624], WI: ['Winterthur', 47.5003, 8.7238],
  WIL: ['Wil SG', 47.4622, 9.0427], SG: ['St. Gallen', 47.4232, 9.3700], TH: ['Thun', 46.7548, 7.6296],
  SP: ['Spiez', 46.6863, 7.6800], VP: ['Visp', 46.2940, 7.8813], BR: ['Brig', 46.3195, 7.9882],
  ZG: ['Zug', 47.1737, 8.5154], LZ: ['Luzern', 47.0502, 8.3102], BS: ['Basel SBB', 47.5476, 7.5897],
  LI: ['Liestal', 47.4842, 7.7313], RF: ['Rheinfelden', 47.5535, 7.7916], FK: ['Frick', 47.5084, 8.0145],
  BG: ['Brugg AG', 47.4808, 8.2084], BD: ['Baden', 47.4764, 8.3077], ST: ['Zürich Stadelhofen', 47.3667, 8.5486],
  SB: ['Stettbach', 47.3972, 8.5964], DI: ['Dietlikon', 47.4176, 8.6189], EF: ['Effretikon', 47.4255, 8.6869],
};

// [route_id, short_name, category, headway (min), first offset (min), [[stop, minutes from start], …]]
const LINES = [
  ['IC1', 'IC1', 'IC', 30, 2, [['GE', 0], ['NY', 13], ['MO', 27], ['LS', 36], ['FR', 82], ['BN', 104], ['ZH', 162], ['ZF', 174], ['WI', 187], ['WIL', 206], ['SG', 225]]],
  ['IC6', 'IC6', 'IC', 60, 28, [['BS', 0], ['OL', 25], ['BN', 55], ['TH', 73], ['SP', 83], ['VP', 110], ['BR', 118]]],
  ['IR70', 'IR70', 'IR', 30, 5, [['ZH', 0], ['ZG', 24], ['LZ', 46]]],
  ['IR36', 'IR36', 'IR', 30, 12, [['BS', 0], ['LI', 10], ['OL', 27], ['AA', 37], ['ZH', 62]]],
  ['RE', 'RE', 'RE', 60, 37, [['BS', 0], ['RF', 10], ['FK', 25], ['BG', 37], ['BD', 45], ['ZH', 62]]],
  ['S12', 'S12', 'S', 15, 3, [['ZH', 0], ['ST', 3], ['SB', 9], ['DI', 13], ['EF', 18], ['WI', 31]]],
  ['R', 'R', 'R', 60, 15, [['LS', 0], ['RO', 30], ['FR', 47], ['BN', 72]]],
];

const pad = (n) => String(n).padStart(2, '0');
const hms = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}:00`;
const csv = (rows) => rows.map((r) => r.join(',')).join('\n') + '\n';

const files = {
  'agency.txt': [['agency_id', 'agency_name', 'agency_url', 'agency_timezone'], ['DEMO', 'Demo-Bahn', 'https://example.org', 'Europe/Zurich']],
  'calendar.txt': [['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
    ['ALL', 1, 1, 1, 1, 1, 1, 1, '20200101', '20991231']],
  'stops.txt': [['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
    ...Object.entries(STOPS).map(([id, [name, lat, lon]]) => [id, `"${name}"`, lat, lon])],
  'routes.txt': [['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_desc', 'route_type']],
  'trips.txt': [['route_id', 'service_id', 'trip_id', 'trip_headsign', 'trip_short_name', 'direction_id']],
  'stop_times.txt': [['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence']],
};

let number = 100;
for (const [routeId, short, cat, headway, first, stops] of LINES) {
  files['routes.txt'].push([routeId, 'DEMO', short, `"${STOPS[stops[0][0]][0]} – ${STOPS[stops.at(-1)[0]][0]}"`, cat, 2]);
  const total = stops.at(-1)[1];
  const directions = [stops, stops.map(([s, m]) => [s, total - m]).reverse()];
  directions.forEach((dirStops, dir) => {
    for (let start = 5 * 60 + first; start < 24 * 60 + 30; start += headway) {
      const tripId = `${routeId}-${dir}-${start}`;
      const headsign = STOPS[dirStops.at(-1)[0]][0];
      files['trips.txt'].push([routeId, 'ALL', tripId, `"${headsign}"`, number++, dir]);
      dirStops.forEach(([stop, m], i) => {
        const arr = start + m;
        const dep = i === 0 || i === dirStops.length - 1 ? arr : arr + 1; // 1 Minute Halt
        files['stop_times.txt'].push([tripId, hms(arr), hms(dep), stop, i + 1]);
      });
    }
  });
}

fs.mkdirSync(outDir, { recursive: true });
for (const [name, rows] of Object.entries(files)) fs.writeFileSync(path.join(outDir, name), csv(rows));
console.log(`Demo-GTFS geschrieben nach ${outDir} (${files['trips.txt'].length - 1} Fahrten)`);
