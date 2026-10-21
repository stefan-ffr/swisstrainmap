import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseFormation, evuOf, FormationService } from '../src/formation.js';

test('Formationstext: Sektoren, Einheiten, Klassen, Nummern, Angebote, Status', () => {
  const w = parseFormation('@A,[(LK,2:18#BHP;KW;NF,F,-2:17,1:12#NF)]@B,[(>2:21,WR:20)]#VH');
  assert.deepEqual(w.map((x) => [x.sector, x.unit, x.type, x.number]), [
    ['A', 1, 'LK', null], ['A', 1, '2', 18], ['A', 1, '2', 17], ['A', 1, '1', 12], ['B', 2, '2', 21], ['B', 2, 'WR', 20],
  ]);
  assert.deepEqual(w[1].offers, ['BHP', 'KW', 'NF']);
  assert.deepEqual(w[2].status, ['geschlossen']);
  assert.deepEqual(w[4].status, ['Gruppeneinstieg']);
  assert.deepEqual(w[5].offers, ['VH'], 'Angebot der Gruppe beim letzten Wagen');
  assert.deepEqual(parseFormation(''), []);
});

test('Betreiber -> EVU-Code', () => {
  assert.equal(evuOf('Schweizerische Bundesbahnen SBB'), 'SBBP');
  assert.equal(evuOf('BLS AG (bls)'), 'BLSP');
  assert.equal(evuOf('Schweizerische Südostbahn (sob)'), 'SOB');
  assert.equal(evuOf('Rhätische Bahn'), 'RhB');
  assert.equal(evuOf('Verkehrsbetriebe Zürich'), null);
});

test('Abfrage mit Zwischenspeicher, 404 und Limit', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(u.searchParams.toString());
    if (u.searchParams.get('trainNumber') === '999') { res.writeHead(404); return res.end('{}'); }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      lastUpdate: '2026-10-05T10:00:00Z',
      formations: [{ formationVehicles: [{ vehicleIdentifier: { typeCodeName: 'RABe 501' } }, { vehicleIdentifier: { typeCodeName: 'RABe 501' } }] }],
      formationsAtScheduledStops: [
        { scheduledStop: { stopPoint: { uic: 8503000, name: 'Zürich HB' }, track: '31' }, formationShort: { formationShortString: '@A,[(1:1,2:2#VH)]', vehicleGoals: [] } },
        { scheduledStop: { stopPoint: { uic: 8505000, name: 'Luzern' }, track: '' }, formationShort: { formationShortString: '' } },
      ],
    }));
  });
  await new Promise((r) => srv.listen(0, r));
  try {
    const f = new FormationService({ url: `http://localhost:${srv.address().port}/formations_full`, apiKey: 'k', perMinute: 3, log: () => {} });
    const a = await f.get('SBBP', '2026-10-05', 1009);
    assert.deepEqual(a.types, ['RABe 501']);
    assert.equal(a.stops.length, 1, 'Halte ohne Formation weggelassen');
    assert.equal(a.stops[0].track, '31');
    await f.get('SBBP', '2026-10-05', 1009); // aus dem Zwischenspeicher
    assert.equal(seen.length, 1);
    assert.match(seen[0], /evu=SBBP&operationDate=2026-10-05&trainNumber=1009/);
    await assert.rejects(f.get('SBBP', '2026-10-05', 999), (e) => e.status === 404);
    await assert.rejects(f.get('SBBP', '2026-10-05', 999), (e) => e.status === 404); // gemerkt
    assert.equal(seen.length, 2);
    await f.get('SBBP', '2026-10-05', 1);
    await assert.rejects(f.get('SBBP', '2026-10-05', 2), (e) => e.status === 429, 'nach 3 Abfragen pro Minute gesperrt');
  } finally {
    srv.close();
  }
});

test('reisezuege.ch: Zugseite, Wochentage, Klassen', async () => {
  const { parseTrainPage, parseDays, classOf } = await import('../src/reisezuege.js');
  const page = '<p>Fahrplanperioden</p><table><tr><td class="mainfont" style="width: 824px; color: red;"><b>Montag - Freitag<br />'
    + '<img src="images/zugbilder/x_at_v.jpg" onclick="getdetail(\'getwagendetail.php?tfah_id=1&amp;fpos=1\');" alt="SBB RABe 501 At2" />'
    + '<img src="images/zugbilder/x_wr.jpg" onclick="getdetail(\'getwagendetail.php?tfah_id=2&amp;fpos=2\');" alt="SBB RABe 501 WR6" />'
    + '<td class="mainfont" style="width: 824px; color: red;"><b>Samstag, Sonntag<br />'
    + '<img src="images/zugbilder/re460.jpg" onclick="getdetail(\'getwagendetail.php?tfah_id=3\');" alt="SBB Re 460" /></table>';
  const blocks = parseTrainPage(page);
  assert.deepEqual(blocks.map((b) => b.days), [[1, 2, 3, 4, 5], [0, 6]]);
  assert.deepEqual(blocks[0].wagons[0], { file: 'x_at_v.jpg', id: 1, name: 'SBB RABe 501 At2' });
  assert.equal(parseDays('täglich'), null);
  assert.deepEqual(['SBB RABe 501 At2', 'SBB IC2000 AB', 'SBB EW IV WRm', 'SBB EW IV B', 'SBB Re 460', 'TPF B (Domino)'].map(classOf), ['1', '12', 'WR', '2', 'LK', '2']);
});
