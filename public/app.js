/* global L */
'use strict';

const POLL_MS = 10_000;
const ANIM_MS = 250;
const LABEL_MIN_ZOOM = 11;

// Verkehrsmittel: Züge immer, alle anderen erst ab einer Zoomstufe (sonst
// wären es landesweit tausende Fahrzeuge). Abgefragt wird dann nur der Ausschnitt.
const MODES = {
  rail: { label: 'Züge', minZoom: 0, color: null, radius: 6 },
  ship: { label: 'Schiffe', minZoom: 10, color: '#0c8599', radius: 6 },
  metro: { label: 'Metro', minZoom: 11, color: '#a61e4d', radius: 5 },
  funicular: { label: 'Standseilbahnen', minZoom: 11, color: '#6741d9', radius: 5 },
  cable: { label: 'Luftseilbahnen', minZoom: 11, color: '#795548', radius: 5 },
  tram: { label: 'Trams', minZoom: 12, color: '#d6336c', radius: 5 },
  bus: { label: 'Busse', minZoom: 13, color: '#e8a400', radius: 4 },
};
const hiddenModes = new Set();

const CATEGORY_COLORS = {
  IC: '#d40000', ICE: '#d40000', EC: '#d40000', TGV: '#d40000', RJ: '#d40000', RJX: '#d40000', EN: '#d40000', NJ: '#d40000', ICN: '#d40000',
  IR: '#ef7d00', PE: '#9c5b00',
  RE: '#7a3db8',
  S: '#1f6fd1', SN: '#1f6fd1',
  R: '#2e9b45',
};
const colorOf = (cat) => CATEGORY_COLORS[cat] || '#5f6b7a';
const colorFor = (t) => (t.mode && t.mode !== 'rail' ? MODES[t.mode]?.color ?? '#5f6b7a' : colorOf(t.cat));
const modeActive = (mode) => !hiddenModes.has(mode) && map.getZoom() >= (MODES[mode]?.minZoom ?? 0);

// --- Karte ------------------------------------------------------------------

const map = L.map('map', { preferCanvas: true, zoomControl: false }).setView([46.82, 8.22], 8);
L.control.zoom({ position: 'topright' }).addTo(map);

const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende';
const swisstopo = (layer) => L.tileLayer(`https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/3857/{z}/{x}/{y}.jpeg`, {
  maxZoom: 19, maxNativeZoom: 18, attribution: '&copy; <a href="https://www.swisstopo.admin.ch/">swisstopo</a>',
});
const baseLayers = {
  'Landeskarte grau (swisstopo)': swisstopo('ch.swisstopo.pixelkarte-grau'),
  'Landeskarte farbig (swisstopo)': swisstopo('ch.swisstopo.pixelkarte-farbe'),
  OpenStreetMap: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osmAttr }),
};
const ormAttr = `${osmAttr} · Bahninfrastruktur: <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a> (CC-BY-SA)`;
const orm = (style) => L.tileLayer(`https://{s}.tiles.openrailwaymap.org/${style}/{z}/{x}/{y}.png`, {
  subdomains: 'abc', maxZoom: 19, tileSize: 256, attribution: ormAttr,
});
const overlays = {
  'OpenRailwayMap: Infrastruktur': orm('standard'),
  'OpenRailwayMap: Höchstgeschwindigkeit': orm('maxspeed'),
  'OpenRailwayMap: Signale': orm('signals'),
  'OpenRailwayMap: Elektrifizierung': orm('electrification'),
};
baseLayers['Landeskarte grau (swisstopo)'].addTo(map);
overlays['OpenRailwayMap: Infrastruktur'].addTo(map);
L.control.layers(baseLayers, overlays, { position: 'topright' }).addTo(map);

const trainLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);

// --- Zustand ----------------------------------------------------------------

const trains = new Map(); // id -> { data, marker }
const hiddenCats = new Set();
let clockOffset = 0; // Serverzeit - Browserzeit
let selectedId = null;
let follow = false; // Karte folgt dem ausgewählten Fahrzeug
const FOLLOW_ZOOM = 15;
let query = '';

const now = () => Date.now() + clockOffset;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' });

function delayClass(sec) {
  if (sec < 180) return 'delay-ok';
  if (sec < 360) return 'delay-warn';
  return 'delay-bad';
}
const delayStroke = (t) => (!t.rt ? '#ffffff' : { 'delay-ok': '#2e9b45', 'delay-warn': '#e69500', 'delay-bad': '#d62b2b' }[delayClass(t.delay)]);
const delayText = (sec) => (Math.abs(sec) < 60 ? 'pünktlich' : `${sec > 0 ? '+' : ''}${Math.round(sec / 60)}'`);
const label = (t) => `${t.alert ? '⚠ ' : ''}${t.name}${t.num ? ` ${t.num}` : ''}`;

// Störungsmeldungen (GTFS-SA)
const EFFECTS = {
  NO_SERVICE: 'Kein Betrieb', REDUCED_SERVICE: 'Eingeschränkter Betrieb', SIGNIFICANT_DELAYS: 'Grosse Verspätungen',
  DETOUR: 'Umleitung', ADDITIONAL_SERVICE: 'Zusätzliche Fahrten', MODIFIED_SERVICE: 'Geänderter Betrieb',
  STOP_MOVED: 'Halt verschoben', ACCESSIBILITY_ISSUE: 'Barrierefreiheit eingeschränkt',
};
const fmtDate = (ms) => new Date(ms).toLocaleString('de-CH', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' });
function alertHtml(a, open = openAlerts.has(a.id)) {
  const period = a.start || a.end ? `<span class="period">${a.start ? fmtDate(a.start) : ''} – ${a.end ? fmtDate(a.end) : 'offen'}</span>` : '';
  const effect = EFFECTS[a.effect] ? `<span class="effect">${EFFECTS[a.effect]}</span>` : '';
  const more = [
    a.description && `<p>${esc(a.description).replace(/\n/g, '<br>')}</p>`,
    a.routes?.length && `<p class="sub">Linien: ${a.routes.map(esc).join(', ')}</p>`,
    a.stops?.length && `<p class="sub">Halte: ${a.stops.map((x) => `<a href="#" class="fly" data-lat="${x.lat}" data-lon="${x.lon}">${esc(x.name)}</a>`).join(', ')}</p>`,
    a.url && `<p><a href="${esc(a.url)}" target="_blank" rel="noopener">Mehr Infos</a></p>`,
  ].filter(Boolean).join('');
  return `<details class="alert" data-id="${esc(a.id)}" ${open ? 'open' : ''}><summary>⚠ ${esc(a.header || EFFECTS[a.effect] || 'Störung')} ${effect}${period}</summary>${more}</details>`;
}
// aufgeklappte Meldungen bleiben offen, auch wenn die Ansicht neu gezeichnet wird
const openAlerts = new Set();
document.addEventListener('toggle', (ev) => {
  const id = ev.target.dataset?.id;
  if (!ev.target.matches?.('details.alert') || !id) return;
  if (ev.target.open) openAlerts.add(id); else openAlerts.delete(id);
}, true);
// Links «Halt» in Meldungen: zur Haltestelle springen
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('a.fly');
  if (!a) return;
  ev.preventDefault();
  setFollow(false);
  map.flyTo([Number(a.dataset.lat), Number(a.dataset.lon)], 16, { duration: 0.8 });
});

// --- Streckengeometrie ------------------------------------------------------

const legs = new Map(); // id -> { coords, cum, total } | null (keine Geometrie: Luftlinie)
let legsVersion = null;
let legsLoading = false;

function decodePolyline(str) {
  const coords = [];
  let i = 0, lat = 0, lon = 0;
  const dec = () => {
    let result = 0, shift = 0, b;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) { lat += dec(); lon += dec(); coords.push([lat / 1e5, lon / 1e5]); }
  return coords;
}

function makeLeg(encoded) {
  if (!encoded) return null;
  const coords = decodePolyline(encoded);
  const cum = [0];
  for (let k = 1; k < coords.length; k++) {
    const [a, b] = [coords[k - 1], coords[k]];
    const dx = (b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180), dy = b[0] - a[0];
    cum.push(cum[k - 1] + Math.hypot(dx, dy));
  }
  return { coords, cum, total: cum[cum.length - 1] };
}

/** Holt fehlende Legs (in Blöcken); noch nicht berechnete werden später erneut angefragt. */
async function loadLegs(version, ids) {
  if (version !== legsVersion) { legs.clear(); legsVersion = version; }
  const missing = [...new Set(ids)].filter((id) => id >= 0 && !legs.has(id));
  if (!missing.length || legsLoading) return;
  legsLoading = true;
  try {
    for (let k = 0; k < missing.length; k += 500) {
      const res = await fetch(`api/legs?ids=${missing.slice(k, k + 500).join(',')}`);
      const body = await res.json();
      if (body.version !== legsVersion) return;
      for (const [id, enc] of Object.entries(body.legs)) {
        if (enc !== null) legs.set(Number(id), makeLeg(enc));
      }
    }
  } catch { /* nächster Versuch beim nächsten Poll */ } finally {
    legsLoading = false;
  }
}

function alongLeg(leg, f) {
  const d = f * leg.total;
  const { coords, cum } = leg;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
  const span = cum[hi] - cum[lo];
  const g = span > 0 ? (d - cum[lo]) / span : 0;
  return [coords[lo][0] + (coords[hi][0] - coords[lo][0]) * g, coords[lo][1] + (coords[hi][1] - coords[lo][1]) * g];
}

/** Standort eines haltenden Zugs: Anfang des folgenden bzw. Ende des vorherigen Legs. */
function stopPosition(points, j) {
  const out = legs.get(points[j][4]);
  if (out) return out.coords[0];
  const inc = j > 0 ? legs.get(points[j - 1][4]) : null;
  if (inc) return inc.coords[inc.coords.length - 1];
  return [points[j][0], points[j][1]];
}

/** Position zum Zeitpunkt t aus den Wegpunkten [lat, lon, ankunft, abfahrt, legId]. */
function positionAt(points, t) {
  if (t < points[0][3]) return stopPosition(points, 0);
  for (let j = 0; j < points.length - 1; j++) {
    const a = points[j], b = points[j + 1];
    if (t <= b[2]) {
      const f = b[2] > a[3] ? Math.max(0, (t - a[3]) / (b[2] - a[3])) : 1;
      const leg = legs.get(a[4]);
      if (leg) return alongLeg(leg, f);
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    if (t < b[3]) return stopPosition(points, j + 1);
  }
  return stopPosition(points, points.length - 1);
}

function matches(t) {
  if (!modeActive(t.mode || 'rail')) return false;
  if ((t.mode || 'rail') === 'rail' && hiddenCats.has(t.cat)) return false;
  if (!query) return true;
  return [t.name, t.num, label(t), t.to, t.next, t.at, t.op, t.extra && 'extrafahrt'].some((s) => s && String(s).toLowerCase().includes(query));
}

// --- Daten laden ------------------------------------------------------------

async function fetchTrains(params) {
  const res = await fetch(`api/trains?${new URLSearchParams(params)}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

let pollSeq = 0;
async function poll() {
  const seq = ++pollSeq;
  try {
    // Züge landesweit (für Übersicht und Statistik), übrige Verkehrsmittel nur im Ausschnitt
    const others = Object.keys(MODES).filter((m) => m !== 'rail' && modeActive(m));
    const b = map.getBounds().pad(0.3);
    const requests = [fetchTrains({ modes: 'rail' })];
    if (others.length) {
      requests.push(fetchTrains({ modes: others.join(','), bbox: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => v.toFixed(4)).join(',') }));
    }
    const bodies = await Promise.all(requests);
    if (seq !== pollSeq) return; // neuere Abfrage unterwegs
    const body = { ...bodies[0], trains: bodies.flatMap((x) => x.trains) };
    clockOffset = body.serverTime - Date.now();
    const seen = new Set();
    for (const t of body.trains) {
      seen.add(t.id);
      let entry = trains.get(t.id);
      if (!entry) {
        const marker = L.circleMarker(positionAt(t.points, now()), { radius: MODES[t.mode]?.radius ?? 6, weight: 2, fillOpacity: 0.95, bubblingMouseEvents: false });
        marker.on('click', () => select(t.id));
        entry = { marker };
        trains.set(t.id, entry);
      }
      entry.data = t;
      entry.marker.setStyle({ fillColor: colorFor(t), color: delayStroke(t) });
    }
    for (const [id, entry] of trains) {
      if (!seen.has(id)) { trainLayer.removeLayer(entry.marker); trains.delete(id); }
    }
    applyFilter();
    updateStats();
    loadLegs(body.legsVersion, body.trains.flatMap((t) => t.points.map((p) => p[4])));
    if (selectedId) showDetails(selectedId);
  } catch (err) {
    $('stats').textContent = `Keine Daten: ${err.message}`;
  }
}

async function pollStatus() {
  try {
    const s = await (await fetch('api/status')).json();
    const rt = s.realtime;
    let text = rt.enabled
      ? `Echtzeit: ${rt.trips} Fahrten mit Prognose${rt.lastSuccess ? `, Stand ${fmtTime(Date.parse(rt.lastSuccess))}` : ''}`
      : 'Echtzeit aus – Positionen nach Fahrplan (GTFS_RT_API_KEY setzen)';
    if (rt.lastError) text += ` · Fehler: ${rt.lastError}`;
    if (s.alerts?.enabled && s.alerts.lastSuccess) {
      $('alerts-btn').hidden = false;
      $('alerts-btn').textContent = `Störungen (${s.alerts.alerts})`;
    }
    const lg = s.legs;
    if (lg?.error) text += ` · Gleisnetz: ${lg.error}`;
    else if (lg?.running) text += ` · Strecken werden berechnet: ${lg.done}/${lg.total}`;
    else if (lg?.total) text += ` · ${lg.routed}/${lg.total} Abschnitte auf Gleisen`;
    $('status').textContent = text;
  } catch { /* ignorieren */ }
}

// --- Darstellung ------------------------------------------------------------

function animate() {
  const t = now();
  for (const { data, marker } of trains.values()) {
    if (trainLayer.hasLayer(marker)) marker.setLatLng(positionAt(data.points, t));
  }
  const followed = follow && selectedId && trains.get(selectedId)?.marker;
  if (followed) map.panTo(followed.getLatLng(), { animate: true, duration: ANIM_MS / 1000, easeLinearity: 1, noMoveStart: true });
  $('clock').textContent = new Date(t).toLocaleTimeString('de-CH', { timeZone: 'Europe/Zurich' });
}

function applyFilter() {
  for (const [id, { data, marker }] of trains) {
    const visible = matches(data) || id === selectedId;
    if (visible && !trainLayer.hasLayer(marker)) trainLayer.addLayer(marker);
    if (!visible && trainLayer.hasLayer(marker)) trainLayer.removeLayer(marker);
  }
  updateLabels();
}

function updateLabels() {
  const zoom = map.getZoom();
  const bounds = map.getBounds().pad(0.2);
  for (const { data, marker } of trains.values()) {
    const minZoom = Math.max(LABEL_MIN_ZOOM, (MODES[data.mode]?.minZoom ?? 0) + 1);
    const want = zoom >= minZoom && trainLayer.hasLayer(marker) && bounds.contains(marker.getLatLng());
    const has = !!marker.getTooltip();
    if (want && !has) marker.bindTooltip(label(data), { permanent: true, direction: 'right', offset: [6, 0], className: 'train-label' });
    else if (!want && has) marker.unbindTooltip();
  }
}

function updateStats() {
  const counts = new Map(), perMode = {};
  let late = 0;
  for (const { data } of trains.values()) {
    const mode = data.mode || 'rail';
    if (!matches(data)) continue;
    perMode[mode] = (perMode[mode] || 0) + 1;
    if (mode === 'rail') counts.set(data.cat, (counts.get(data.cat) || 0) + 1);
    if (data.rt && data.delay >= 180) late++;
  }
  const parts = Object.keys(MODES).filter((m) => perMode[m]).map((m) => `${perMode[m]} ${MODES[m].label}`);
  $('stats').textContent = `${parts.join(' · ') || 'Keine Fahrzeuge'} unterwegs${late ? ` · ${late} mit ≥ 3' Verspätung` : ''}`;

  const zoom = map.getZoom();
  $('modes').innerHTML = Object.entries(MODES).map(([m, cfg]) => {
    const tooFar = zoom < cfg.minZoom;
    const dot = cfg.color ?? CATEGORY_COLORS.IC;
    const hint = tooFar ? ` <small>ab Zoom ${cfg.minZoom}</small>` : '';
    return `<li data-mode="${m}" class="${hiddenModes.has(m) ? 'off' : ''} ${tooFar ? 'far' : ''}"><i style="background:${dot}"></i>${cfg.label}${hint}</li>`;
  }).join('');

  const legend = $('legend');
  const cats = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  legend.innerHTML = cats.map((c) => `<li data-cat="${esc(c)}" class="${hiddenCats.has(c) ? 'off' : ''}" style="background:${colorOf(c)}">${esc(c)} ${counts.get(c)}</li>`).join('');
}

$('modes').addEventListener('click', (e) => {
  const mode = e.target.closest('li')?.dataset.mode;
  if (!mode) return;
  if (hiddenModes.has(mode)) hiddenModes.delete(mode); else hiddenModes.add(mode);
  applyFilter();
  updateStats();
  poll();
});

$('legend').addEventListener('click', (e) => {
  const cat = e.target.closest('li')?.dataset.cat;
  if (!cat) return;
  if (hiddenCats.has(cat)) hiddenCats.delete(cat); else hiddenCats.add(cat);
  applyFilter();
  updateStats();
});

$('search').addEventListener('input', (e) => {
  query = e.target.value.trim().toLowerCase();
  applyFilter();
  updateStats();
});

// Nach Verschieben/Zoomen: Beschriftungen anpassen und Ausschnitt neu laden
let moveTimer = null;
map.on('moveend zoomend', () => {
  updateLabels();
  applyFilter();
  updateStats();
  clearTimeout(moveTimer);
  moveTimer = setTimeout(poll, 300);
});

// --- Detailansicht einer Fahrt ---------------------------------------------

function select(id) {
  selectedId = id;
  setFollow(true);
  const marker = trains.get(id)?.marker;
  if (marker) map.setView(marker.getLatLng(), Math.max(map.getZoom(), FOLLOW_ZOOM));
  showDetails(id);
}

function setFollow(on) {
  follow = on;
  const btn = $('follow-btn');
  if (btn) { btn.setAttribute('aria-pressed', String(on)); btn.textContent = on ? 'Verfolgen: an' : 'Verfolgen'; }
}

// Wer die Karte selbst verschiebt, beendet das Verfolgen
map.on('dragstart', () => setFollow(false));

function closeDetails() {
  setFollow(false);
  selectedId = null;
  routeLayer.clearLayers();
  $('details').hidden = true;
  applyFilter();
}

async function showDetails(id) {
  const res = await fetch(`api/trip/${encodeURIComponent(id)}`);
  if (!res.ok || id !== selectedId) return;
  const trip = await res.json();
  const live = trains.get(id)?.data;
  const t = now();

  routeLayer.clearLayers();
  // Leg k verbindet Halt k mit k+1; ohne Geometrie direkt von Halt zu Halt
  const path = trip.stops.flatMap((s, k) => (trip.legs[k] ? decodePolyline(trip.legs[k]) : [[s.lat, s.lon]]));
  const line = L.polyline(path, { color: colorFor(trip), weight: 4, opacity: 0.6 });
  routeLayer.addLayer(line);
  for (const s of trip.stops) routeLayer.addLayer(L.circleMarker([s.lat, s.lon], { radius: 3, color: colorFor(trip), weight: 2, fillColor: '#fff', fillOpacity: 1 }));
  trains.get(id)?.marker.bringToFront();

  const rows = trip.stops.map((s) => {
    const passed = (s.depRt ?? s.arrRt) < t;
    const cur = live && (live.at === s.name || (!live.at && live.next === s.name));
    const cell = (plan, rt) => {
      if (plan == null) return '';
      const d = (rt - plan) / 1000; // Zeiten in ms, Verspätung in s
      const extra = trip.rt && Math.abs(d) >= 60 ? ` <span class="${delayClass(d)}">${delayText(d)}</span>` : '';
      return fmtTime(plan) + extra;
    };
    const warn = s.alerts ? ` <span class="warn" title="${esc(s.alerts.map((i) => trip.alerts[i].header).join(' · '))}">⚠</span>` : '';
    return `<tr class="stop ${passed ? 'past' : ''} ${cur ? 'cur' : ''}" data-lat="${s.lat}" data-lon="${s.lon}" title="Zu ${esc(s.name)} springen"><td>${esc(s.name)}${warn}</td><td class="t">${cell(s.arr, s.arrRt)}</td><td class="t">${cell(s.dep, s.depRt)}</td></tr>`;
  }).join('');

  const delay = live && trip.rt ? ` · <span class="${delayClass(live.delay)}">${delayText(live.delay)}</span>` : '';
  const where = live ? (live.at ? `Halt in ${esc(live.at)}` : `Fährt nach ${esc(live.next)}`) : 'nicht unterwegs';
  $('details').innerHTML = `
    <button class="close" title="Schliessen">✕</button>
    <h2 style="color:${colorFor(trip)}">${esc(trip.name)} ${esc(trip.num || '')} → ${esc(trip.to || trip.stops.at(-1).name)}</h2>
    <div class="sub">${trip.extra ? '<b>Extrafahrt</b> (nicht im Fahrplan) · ' : ''}${esc(trip.op)}${trip.op ? ' · ' : ''}${where}${delay}${trip.canceled ? ' · <b class="delay-bad">fällt aus</b>' : ''}${trip.rt ? '' : ' · nur Fahrplan'}</div>
    <div class="actions">
      <button id="follow-btn" class="link-btn" type="button" aria-pressed="${follow}">${follow ? 'Verfolgen: an' : 'Verfolgen'}</button>
      <button id="route-btn" class="link-btn" type="button">Ganze Strecke</button>
    </div>
    ${(trip.alerts || []).slice(0, trip.alertsWhole).map((a) => alertHtml(a)).join('')}
    <table><tr><td></td><td class="t">an</td><td class="t">ab</td></tr>${rows}</table>
    ${trip.alerts?.length > trip.alertsWhole ? `<h3>Hinweise zu Halten</h3>${trip.alerts.slice(trip.alertsWhole).map((a) => alertHtml(a)).join('')}` : ''}`;
  $('details').hidden = false;
  $('details').querySelector('.close').onclick = closeDetails;
  $('follow-btn').onclick = () => {
    setFollow(!follow);
    const marker = trains.get(id)?.marker;
    if (follow && marker) map.setView(marker.getLatLng(), Math.max(map.getZoom(), FOLLOW_ZOOM));
  };
  $('route-btn').onclick = () => {
    setFollow(false);
    map.fitBounds(line.getBounds(), { paddingTopLeft: [window.innerWidth > 600 ? 360 : 20, 40], paddingBottomRight: [40, 40] });
  };
  // Halt anklicken: dorthin springen
  $('details').querySelector('table').onclick = (ev) => {
    const row = ev.target.closest('tr.stop');
    if (!row) return;
    setFollow(false);
    map.flyTo([Number(row.dataset.lat), Number(row.dataset.lon)], 16, { duration: 0.8 });
  };
}

map.on('click', () => { if (selectedId) closeDetails(); });

// --- Extrafahrten (auch bereits beendete) ------------------------------------

function stopRows(stops, t, rtKnown) {
  return stops.map((s) => {
    const passed = (s.depRt ?? s.arrRt) < t;
    const cell = (plan, rt) => {
      if (plan == null) return '';
      const d = (rt - plan) / 1000;
      const extra = rtKnown && Math.abs(d) >= 60 ? ` <span class="${delayClass(d)}">${delayText(d)}</span>` : '';
      return fmtTime(plan) + extra;
    };
    return `<tr class="${passed ? 'past' : ''}"><td>${esc(s.name)}</td><td class="t">${cell(s.arr, s.arrRt)}</td><td class="t">${cell(s.dep, s.depRt)}</td></tr>`;
  }).join('');
}

async function showExtras() {
  selectedId = null;
  routeLayer.clearLayers();
  const res = await fetch('api/extras');
  const { extras } = await res.json();
  const box = $('details');
  const items = extras.map((e, i) => {
    const live = trains.has(`${e.tripId}|${e.day}`);
    return `<li data-i="${i}"><span class="t">${fmtTime(e.dep)}</span><span>${esc(e.name)} ${esc(e.num || '')} ${esc(e.from)} → ${esc(e.to)}</span>${live ? '<span class="live">unterwegs</span>' : `<span class="t">${e.delay >= 60 ? `<span class="${delayClass(e.delay)}">${delayText(e.delay)}</span>` : ''}</span>`}</li>`;
  }).join('');
  box.innerHTML = `
    <button class="close" title="Schliessen">✕</button>
    <h2>Extrafahrten heute</h2>
    <div class="sub">${extras.length} Fahrten, die nicht im Fahrplan stehen (Extrazüge, Ersatzbusse, Verstärkungskurse) – auch bereits beendete.</div>
    ${extras.length ? `<ul class="extras">${items}</ul>` : '<p class="sub">Heute noch keine.</p>'}`;
  box.hidden = false;
  box.querySelector('.close').onclick = closeDetails;
  box.querySelector('.extras')?.addEventListener('click', (ev) => {
    const e = extras[ev.target.closest('li')?.dataset.i];
    if (!e) return;
    const id = `${e.tripId}|${e.day}`;
    if (trains.has(id)) { select(id); return; }
    // beendet: gespeicherte Halte anzeigen
    box.innerHTML = `
      <button class="close" title="Schliessen">✕</button>
      <h2 style="color:${colorFor(e)}">${esc(e.name)} ${esc(e.num || '')} → ${esc(e.to)}</h2>
      <div class="sub"><b>Extrafahrt</b> · ${esc(e.op)}${e.op ? ' · ' : ''}nicht mehr unterwegs · zuletzt gesehen ${fmtTime(e.lastSeen)}</div>
      <table><tr><td></td><td class="t">an</td><td class="t">ab</td></tr>${stopRows(e.stops, now(), true)}</table>
      <button class="link-btn" id="extras-back" type="button">← alle Extrafahrten</button>`;
    box.querySelector('.close').onclick = closeDetails;
    $('extras-back').onclick = showExtras;
  });
}

$('extras-btn').addEventListener('click', showExtras);

async function showAlerts() {
  selectedId = null;
  setFollow(false);
  routeLayer.clearLayers();
  const { alerts } = await (await fetch('api/alerts')).json();
  const box = $('details');
  const filter = query;
  const shown = filter ? alerts.filter((a) => [a.header, a.description, ...a.routes, ...a.stops.map((x) => x.name)].some((x) => x && x.toLowerCase().includes(filter))) : alerts;
  box.innerHTML = `
    <button class="close" title="Schliessen">✕</button>
    <h2>Störungen und Hinweise</h2>
    <div class="sub">${shown.length} aktuelle Meldungen${filter ? ` zu «${esc(filter)}»` : ''} (Suchfeld filtert)</div>
    ${shown.map((a) => alertHtml(a)).join('') || '<p class="sub">Keine.</p>'}`;
  box.hidden = false;
  box.querySelector('.close').onclick = closeDetails;
}

$('alerts-btn').addEventListener('click', showAlerts);

// --- Start ------------------------------------------------------------------

poll();
pollStatus();
setInterval(poll, POLL_MS);
setInterval(pollStatus, 30_000);
setInterval(animate, ANIM_MS);
