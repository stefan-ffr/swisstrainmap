// Minimaler, schneller Streaming-CSV-Parser für GTFS-Dateien.
import readline from 'node:readline';

export function parseLine(line) {
  if (line.indexOf('"') === -1) return line.split(',');
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Liest eine CSV-Datei zeilenweise und ruft onRow(row, idx, line) auf.
 * idx bildet Spaltennamen auf Positionen ab (fehlende Spalte -> undefined),
 * line ist die Originalzeile. Mit onHeader(line, idx) erhält man die Kopfzeile.
 * Gibt parse=false an, ist row null (schneller, wenn nur line gebraucht wird).
 */
export async function readCsv(stream, onRow, { onHeader, parse = true } = {}) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let idx = null;
  for await (let line of rl) {
    if (idx === null) {
      line = line.replace(/^\uFEFF/, '');
      idx = {};
      parseLine(line).forEach((name, i) => { idx[name.trim()] = i; });
      onHeader?.(line, idx);
      continue;
    }
    if (line === '') continue;
    onRow(parse ? parseLine(line) : null, idx, line);
  }
}
