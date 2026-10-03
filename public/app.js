/* global L */
'use strict';

const POLL_MS = 10_000;
const ANIM_MS = 250;
const LABEL_MIN_ZOOM = 11;

const CATEGORY_COLORS = {
  IC: '#d40000', ICE: '#d40000', EC: '#d40000', TGV: '#d40000', RJ: '#d40000', RJX: '#d40000', EN: '#d40000', NJ: '#d40000', ICN: '#d40000',
  IR: '#ef7d00', PE: '#9c5b00',
  RE: '#7a3db8',
  S: '#1f6fd1', SN: '#1f6fd1',
  R: '#2e9b45',
};
const colorOf = (cat) => CATEGORY_COLORS[cat] || '#5f6b7a';

// --- Karte ------------------------------------------------------------------

const map = L.map('map', { preferCanvas: true, zoomControl: false }).setView([46.82, 8.22], 8);
L.control.zoom({ position: 'topright' }).addTo(map);

const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende';
const baseLayers = {
  'Hell (CARTO)': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19, attribution: `${osmAttr}, &copy; <a href="https://carto.com/attributions">CARTO</a>`,
  }),
  OpenStreetMap: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osmAttr }),
};
const ormAttr = 'Bahninfrastruktur: <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a> (CC-BY-SA)';
const orm = (style) => L.tileLayer(`https://{s}.tiles.openrailwaymap.org/${style}/{z}/{x}/{y}.png`, {
  subdomains: 'abc', maxZoom: 19, tileSize: 256, attribution: ormAttr,
});
const overlays = {
  'OpenRailwayMap: Infrastruktur': orm('standard'),
  'OpenRailwayMap: Höchstgeschwindigkeit': orm('maxspeed'),
  'OpenRailwayMap: Signale': orm('signals'),
  'OpenRailwayMap: Elektrifizierung': orm('electrification'),
};
baseLayers['Hell (CARTO)'].addTo(map);
overlays['OpenRailwayMap: Infrastruktur'].addTo(map);
L.control.layers(baseLayers, overlays, { position: 'topright' }).addTo(map);

const trainLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);

// --- Zustand ----------------------------------------------------------------

const trains = new Map(); // id -> { data, marker }
const hiddenCats = new Set();
let clockOffset = 0; // Serverzeit - Browserzeit
let selectedId = null;
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
const label = (t) => `${t.name}${t.num ? ` ${t.num}` : ''}`;

/** Position zum Zeitpunkt t aus den Wegpunkten [lat, lon, ankunft, abfahrt]. */
function positionAt(points, t) {
  let p = points[0];
  if (t < p[3]) return [p[0], p[1]];
  for (let j = 0; j < points.length - 1; j++) {
    const a = points[j], b = points[j + 1];
    if (t <= b[2]) {
      const f = b[2] > a[3] ? (t - a[3]) / (b[2] - a[3]) : 1;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    if (t < b[3]) return [b[0], b[1]];
    p = b;
  }
  return [p[0], p[1]];
}

function matches(t) {
  if (hiddenCats.has(t.cat)) return false;
  if (!query) return true;
  return [t.name, t.num, label(t), t.to, t.next, t.at, t.op].some((s) => s && String(s).toLowerCase().includes(query));
}

// --- Daten laden ------------------------------------------------------------

async function poll() {
  try {
    const res = await fetch('api/trains');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    clockOffset = body.serverTime - Date.now();
    const seen = new Set();
    for (const t of body.trains) {
      seen.add(t.id);
      let entry = trains.get(t.id);
      if (!entry) {
        const marker = L.circleMarker(positionAt(t.points, now()), { radius: 6, weight: 2, fillOpacity: 0.95, bubblingMouseEvents: false });
        marker.on('click', () => select(t.id));
        entry = { marker };
        trains.set(t.id, entry);
      }
      entry.data = t;
      entry.marker.setStyle({ fillColor: colorOf(t.cat), color: delayStroke(t) });
    }
    for (const [id, entry] of trains) {
      if (!seen.has(id)) { trainLayer.removeLayer(entry.marker); trains.delete(id); }
    }
    applyFilter();
    updateStats();
    if (selectedId) showDetails(selectedId, false);
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
    $('status').textContent = text;
  } catch { /* ignorieren */ }
}

// --- Darstellung ------------------------------------------------------------

function animate() {
  const t = now();
  for (const { data, marker } of trains.values()) {
    if (trainLayer.hasLayer(marker)) marker.setLatLng(positionAt(data.points, t));
  }
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
  const show = map.getZoom() >= LABEL_MIN_ZOOM;
  const bounds = map.getBounds().pad(0.2);
  for (const { data, marker } of trains.values()) {
    const want = show && trainLayer.hasLayer(marker) && bounds.contains(marker.getLatLng());
    const has = !!marker.getTooltip();
    if (want && !has) marker.bindTooltip(label(data), { permanent: true, direction: 'right', offset: [6, 0], className: 'train-label' });
    else if (!want && has) marker.unbindTooltip();
  }
}

function updateStats() {
  const counts = new Map();
  let visible = 0, late = 0;
  for (const { data } of trains.values()) {
    counts.set(data.cat, (counts.get(data.cat) || 0) + 1);
    if (matches(data)) { visible++; if (data.rt && data.delay >= 180) late++; }
  }
  $('stats').textContent = `${visible} von ${trains.size} Zügen unterwegs${late ? ` · ${late} mit ≥ 3' Verspätung` : ''}`;

  const legend = $('legend');
  const cats = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  legend.innerHTML = cats.map((c) => `<li data-cat="${esc(c)}" class="${hiddenCats.has(c) ? 'off' : ''}" style="background:${colorOf(c)}">${esc(c)} ${counts.get(c)}</li>`).join('');
}

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

map.on('moveend zoomend', updateLabels);

// --- Detailansicht einer Fahrt ---------------------------------------------

function select(id) {
  selectedId = id;
  showDetails(id, true);
}

function closeDetails() {
  selectedId = null;
  routeLayer.clearLayers();
  $('details').hidden = true;
  applyFilter();
}

async function showDetails(id, fit) {
  const res = await fetch(`api/trip/${encodeURIComponent(id)}`);
  if (!res.ok || id !== selectedId) return;
  const trip = await res.json();
  const live = trains.get(id)?.data;
  const t = now();

  routeLayer.clearLayers();
  const line = L.polyline(trip.stops.map((s) => [s.lat, s.lon]), { color: colorOf(trip.cat), weight: 4, opacity: 0.7, dashArray: '6 6' });
  routeLayer.addLayer(line);
  for (const s of trip.stops) routeLayer.addLayer(L.circleMarker([s.lat, s.lon], { radius: 3, color: colorOf(trip.cat), weight: 2, fillColor: '#fff', fillOpacity: 1 }));
  if (fit) map.fitBounds(line.getBounds(), { paddingTopLeft: [window.innerWidth > 600 ? 360 : 20, 40], paddingBottomRight: [40, 40], maxZoom: 12 });
  trains.get(id)?.marker.bringToFront();

  const rows = trip.stops.map((s) => {
    const passed = (s.depRt ?? s.arrRt) < t;
    const cur = live && (live.at === s.name || (!live.at && live.next === s.name));
    const cell = (plan, rt) => {
      if (plan == null) return '';
      const d = rt - plan;
      const extra = trip.rt && Math.abs(d) >= 60 ? ` <span class="${delayClass(d)}">${delayText(d)}</span>` : '';
      return fmtTime(plan) + extra;
    };
    return `<tr class="${passed ? 'past' : ''} ${cur ? 'cur' : ''}"><td>${esc(s.name)}</td><td class="t">${cell(s.arr, s.arrRt)}</td><td class="t">${cell(s.dep, s.depRt)}</td></tr>`;
  }).join('');

  const delay = live && trip.rt ? ` · <span class="${delayClass(live.delay)}">${delayText(live.delay)}</span>` : '';
  const where = live ? (live.at ? `Halt in ${esc(live.at)}` : `Fährt nach ${esc(live.next)}`) : 'nicht unterwegs';
  $('details').innerHTML = `
    <button class="close" title="Schliessen">✕</button>
    <h2 style="color:${colorOf(trip.cat)}">${esc(trip.name)} ${esc(trip.num || '')} → ${esc(trip.to || trip.stops.at(-1).name)}</h2>
    <div class="sub">${esc(trip.op)}${trip.op ? ' · ' : ''}${where}${delay}${trip.canceled ? ' · <b class="delay-bad">fällt aus</b>' : ''}${trip.rt ? '' : ' · nur Fahrplan'}</div>
    <table><tr><td></td><td class="t">an</td><td class="t">ab</td></tr>${rows}</table>`;
  $('details').hidden = false;
  $('details').querySelector('.close').onclick = closeDetails;
}

map.on('click', () => { if (selectedId) closeDetails(); });

// --- Start ------------------------------------------------------------------

poll();
pollStatus();
setInterval(poll, POLL_MS);
setInterval(pollStatus, 30_000);
setInterval(animate, ANIM_MS);
