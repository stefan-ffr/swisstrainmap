// Zugkomposition (Train Formation Service): Wagenreihung, Klassen, Sektoren
// und Angebote (Rollstuhl, Velo, Familie …) eines Zugs an jedem Halt.
// Abgefragt wird nur beim Öffnen einer Fahrt, mit Zwischenspeicher, damit der
// Plan (50 Abfragen/min, 20 000/Tag) reicht.

// EVU-Code der API je Betreiber (agency_name im GTFS)
const EVUS = [
  [/\bSBB\b|Schweizerische Bundesbahnen/i, 'SBBP'],
  [/\bBLS\b/i, 'BLSP'],
  [/Südostbahn|\bSOB\b/i, 'SOB'],
  [/thurbo/i, 'THURBO'],
  [/Rhätische|\bRhB\b/i, 'RhB'],
  [/\bTPF\b|fribourgeois/i, 'TPF'],
  [/\btransN\b|\bTRN\b/i, 'TRN'],
  [/\bMBC\b|Morges-Bière/i, 'MBC'],
  [/Zentralbahn|^zb$/i, 'ZB'],
  [/ÖBB|\bOeBB\b|Österreichische Bundesbahnen/i, 'OeBB'],
];
export const evuOf = (agency) => EVUS.find(([re]) => re.test(agency || ''))?.[1] ?? null;

const STATUS = { '-': 'geschlossen', '>': 'Gruppeneinstieg', '=': 'reserviert für Durchreise', '%': 'offen, nicht bedient' };

/**
 * Zerlegt den formationShortString, z. B.
 *   @A,[(LK,2:18#BHP;KW;NF,2:17,1:12#NF)]@B,[(2:21,WR:20)]
 * @X = Sektor, ( … ) = Fahrzeugeinheit, Typ:Wagennummer#Angebote, F = Lücke,
 * vorangestellt -, >, =, % = Status (geschlossen …).
 * @returns [{ sector, unit, type, number, offers: [], status: [] }]
 */
export function parseFormation(str) {
  const wagons = [];
  let sector = '', unit = 0;
  for (const tok of String(str || '').match(/@[A-Z]|[[\](),\\]|[^@[\](),\\]+/g) ?? []) {
    if (tok[0] === '@') { sector = tok[1]; continue; }
    if (tok === '(') { unit++; continue; }
    if ('[](),\\'.includes(tok)) continue;
    const t = tok.trim();
    if (!t || t === 'F') continue; // F: Lücke (fiktiver Wagen)
    if (t[0] === '#') { // Angebote der ganzen Gruppe: beim letzten Wagen
      wagons.at(-1)?.offers.push(...t.slice(1).split(';').filter(Boolean));
      continue;
    }
    let k = 0;
    const status = [];
    while (k < t.length && STATUS[t[k]]) status.push(STATUS[t[k++]]);
    const m = /^([A-Z0-9]+)(?::(\d+))?(?:#(.*))?$/.exec(t.slice(k));
    if (!m) continue;
    wagons.push({ sector, unit, type: m[1], number: m[2] ? Number(m[2]) : null, offers: m[3] ? m[3].split(';').filter(Boolean) : [], status });
  }
  return wagons;
}

/** Antwort der API auf das Nötige reduzieren. */
export function simplify(json) {
  const vehicles = json.formations?.[0]?.formationVehicles ?? [];
  const types = [];
  for (const v of vehicles) {
    const name = v.vehicleIdentifier?.typeCodeName || v.vehicleIdentifier?.typeCode;
    if (name && !types.includes(String(name))) types.push(String(name));
  }
  return {
    lastUpdate: json.lastUpdate ?? null,
    types,
    stops: (json.formationsAtScheduledStops ?? []).map((f) => ({
      name: f.scheduledStop?.stopPoint?.name ?? '',
      uic: f.scheduledStop?.stopPoint?.uic ?? null,
      track: f.scheduledStop?.track ?? null,
      wagons: parseFormation(f.formationShort?.formationShortString),
      goals: (f.formationShort?.vehicleGoals ?? []).map((g) => ({
        from: g.fromVehicleAtPosition, to: g.toVehicleAtPosition, destination: g.destinationStopPoint?.name ?? '',
      })),
    })).filter((s) => s.wagons.length),
  };
}

export class FormationService {
  constructor({ url, apiKey, enabled = false, perMinute = 45, perDay = 19000, log = console.log }) {
    Object.assign(this, { url, apiKey, perMinute, perDay, log });
    this.enabled = !!(apiKey || enabled);
    this.cache = new Map(); // evu|datum|nummer -> { until, value | error }
    this.recent = [];
    this.day = null;
    this.today = 0;
    this.status = { enabled: this.enabled, requests: 0, lastError: null };
  }

  /** Komposition eines Zugs (evu z. B. 'SBBP', date 'YYYY-MM-DD'); wirft mit .status bei Fehlern. */
  async get(evu, date, trainNumber) {
    const key = `${evu}|${date}|${trainNumber}`;
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) {
      if (hit.error) throw hit.error;
      return hit.value;
    }
    if (hit?.pending) return hit.pending;

    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.today = 0; }
    this.recent = this.recent.filter((t) => t > now - 60_000);
    if (this.recent.length >= this.perMinute || this.today >= this.perDay) {
      throw Object.assign(new Error('Abfragelimit erreicht – bitte gleich nochmals versuchen'), { status: 429 });
    }
    this.recent.push(now);
    this.today++;
    this.status.requests++;

    const pending = (async () => {
      const params = new URLSearchParams({ evu, operationDate: date, trainNumber: String(trainNumber), includeOperationalStops: 'false' });
      const headers = { Accept: 'application/json' };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      try {
        const res = await fetch(`${this.url}?${params}`, { headers });
        if (!res.ok) {
          const text = (await res.text()).slice(0, 200);
          const msg = res.status === 401 || res.status === 403
            ? 'kein Zugriff – API-Key für den Train Formation Service prüfen'
            : res.status === 404 || res.status === 204 ? 'keine Kompositionsdaten für diesen Zug' : `${res.status} ${text}`;
          throw Object.assign(new Error(msg), { status: res.status === 204 ? 404 : res.status });
        }
        const text = await res.text();
        if (!text.trim()) throw Object.assign(new Error('keine Kompositionsdaten für diesen Zug'), { status: 404 });
        const json = JSON.parse(text);
        const value = simplify(json);
        if (!value.stops.length) {
          // Format prüfen: welche Felder kamen an?
          this.log(`Zugkomposition ${evu} ${trainNumber} ${date}: keine Wagen erkannt – Antwort (${res.status}, ${text.length} Bytes) beginnt mit ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
        }
        this.cache.set(key, { until: Date.now() + 10 * 60_000, value });
        return value;
      } catch (err) {
        err.status ??= 502;
        this.status.lastError = `${new Date().toISOString()}: ${err.message}`;
        this.log(`Zugkomposition ${evu} ${trainNumber} ${date}: ${err.message}`);
        // «gibt es nicht» länger merken, Fehler kurz
        this.cache.set(key, { until: Date.now() + (err.status === 404 ? 3600_000 : 60_000), error: err });
        throw err;
      }
    })();
    this.cache.set(key, { until: 0, pending });
    if (this.cache.size > 5000) for (const [k, v] of this.cache) if (v.until < Date.now() && !v.pending) this.cache.delete(k);
    return pending;
  }
}
