// Erstellt den Fahrplan-Auszug in einem eigenen Thread: Der Speicher dafür
// (kurz ~1,6 GB) wird beim Beenden des Threads vollständig freigegeben und
// addiert sich nicht zum laufenden Server.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { ensureExtract } from './gtfs-extract.js';
import { modeFilter } from './modes.js';

if (!isMainThread) {
  const { source, outDir, modes } = workerData;
  ensureExtract(source, outDir, modeFilter(modes), (msg) => parentPort.postMessage({ log: msg }))
    .then((dir) => parentPort.postMessage({ dir }))
    .catch((err) => parentPort.postMessage({ error: err.message }));
}

/** Wie ensureExtract, aber in einem Worker-Thread. */
export function ensureExtractInWorker(source, outDir, routeTypes, log = console.log) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { source, outDir, modes: routeTypes.modes } });
    worker.on('message', (m) => {
      if (m.log) log(m.log);
      else if (m.error) reject(new Error(m.error));
      else if (m.dir) resolve(m.dir);
    });
    worker.on('error', reject);
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`Auszug-Thread beendet mit Code ${code}`)); });
  });
}
