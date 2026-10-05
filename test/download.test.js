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

test('Ohne Weiterleitung entscheidet Last-Modified über eine neue Version', async () => {
  let modified = 'Fri, 12 Dec 2025 09:02:01 GMT', downloads = 0, status = 200;
  const srv = http.createServer((req, res) => {
    res.writeHead(status, { 'last-modified': modified });
    if (req.method === 'GET') downloads++;
    res.end(req.method === 'GET' ? `zip ${downloads}` : undefined);
  });
  await new Promise((r) => srv.listen(0, r));
  const url = `http://localhost:${srv.address().port}/GTFS_Fahrplan_2026.zip`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'foreign-at.zip');
  const log = () => {};
  try {
    await ensureDownloaded(url, file, 0, log);
    await ensureDownloaded(url, file, 0, log); // unverändert
    assert.equal(downloads, 1);
    modified = 'Mon, 05 Oct 2026 08:00:00 GMT';
    await ensureDownloaded(url, file, 0, log);
    assert.equal(downloads, 2);
    await ensureDownloaded(url.replace('2026', '2027'), file, 24, log); // neues Fahrplanjahr: sofort prüfen
    assert.equal(downloads, 3);
    status = 404; // Datei verschwunden: vorhandene weiterverwenden
    assert.equal(await ensureDownloaded(url, file, 0, log), file);
    assert.equal(downloads, 3);
  } finally {
    srv.close();
  }
});
