// Lädt alle Wagenzeichnungen von reisezuege.ch (mit Erlaubnis von Markus Blaser)
// einmalig herunter, z. B. beim Bauen des Docker-Images:
//   node scripts/fetch-drawings.js <Zielordner>
// Höflich: eine Abfrage nach der anderen, 1 s Abstand; vorhandene Bilder
// werden nicht erneut geladen. Bricht bei Netzproblemen nicht ab (der Server
// lädt fehlende Bilder sonst bei Bedarf nach).
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://www.reisezuege.ch/';
const out = path.resolve(process.argv[2] || 'drawings');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// bis zu 3 Versuche mit wachsender Pause – der Server antwortet nicht immer
async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'swisstransportmap (Karte mit Erlaubnis von reisezuege.ch)' } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('leere Antwort');
      return buf;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(attempt * 5000);
    }
  }
}

try {
  fs.mkdirSync(out, { recursive: true });
  const list = (await get(`${BASE}index.php?action=9`)).toString('latin1');
  const files = [...new Set([...list.matchAll(/images\/zugbilder\/([A-Za-z0-9_.-]+\.(?:jpe?g|gif|png))/g)].map((m) => m[1]))];
  console.log(`reisezuege.ch: ${files.length} Zeichnungen`);
  let loaded = 0, failed = 0;
  for (const file of files) {
    const target = path.join(out, file);
    if (fs.existsSync(target)) continue;
    await sleep(1000);
    try {
      fs.writeFileSync(target, await get(`${BASE}images/zugbilder/${file}`));
      loaded++;
    } catch (err) {
      failed++;
      console.log(`  ${file}: ${err.message}`);
    }
  }
  console.log(`reisezuege.ch: ${loaded} geladen, ${failed} fehlgeschlagen, ${files.length - loaded - failed} schon vorhanden`);
} catch (err) {
  console.log(`reisezuege.ch: Zeichnungen nicht geladen – ${err.message}`);
}
