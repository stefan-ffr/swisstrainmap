import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDownloaded } from '../src/gtfs-source.js';

test('Versionsprüfung lädt nur neue Fahrplan-Versionen und lässt die ZIP-Datei unverändert', async () => {
  let version = 1, downloads = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/permalink') { res.writeHead(302, { location: `/files/gtfs_v${version}.zip` }); return res.end(); }
    downloads++;
    res.end(`zip ${version}`);
  });
  await new Promise((r) => srv.listen(0, r));
  const url = `http://localhost:${srv.address().port}/permalink`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'gtfs.zip');
  const log = () => {};
  try {
    await ensureDownloaded(url, file, 0, log);
    const mtime = fs.statSync(file).mtimeMs;
    await ensureDownloaded(url, file, 0, log); // Prüfung fällig, gleiche Version
    assert.equal(downloads, 1);
    assert.equal(fs.statSync(file).mtimeMs, mtime, 'ZIP-Zeitstempel unverändert (sonst wird der Auszug neu erstellt)');
    version = 2;
    await ensureDownloaded(url, file, 6, log); // letzte Prüfung < 6 h her: nichts tun
    assert.equal(downloads, 1);
    await ensureDownloaded(url, file, 0, log); // neue Version
    assert.equal(downloads, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), 'zip 2');
  } finally {
    srv.close();
  }
});
