# Swiss Train Map

Live-Karte aller Züge in der Schweiz – nachgebaut mit offenen Daten:

- **Fahrplan:** GTFS-Fahrplan von [opentransportdata.swiss](https://opentransportdata.swiss)
- **Echtzeit:** GTFS-RT Trip Updates (Verspätungen, Ausfälle) von opentransportdata.swiss
- **Gleisnetz:** OpenStreetMap-Gleise (via Overpass), damit die Züge den Strecken entlang fahren
- **Karte:** OpenStreetMap / CARTO als Grundkarte, darüber [OpenRailwayMap](https://www.openrailwaymap.org) (Infrastruktur, Höchstgeschwindigkeiten, Signale, Elektrifizierung)

## Wie funktioniert das?

Es gibt in der Schweiz keine öffentlichen GPS-Positionen der Züge. Die Position wird deshalb – wie bei den
bekannten Zugradar-Karten – **berechnet**:

1. Beim Start liest der Server den GTFS-Fahrplan ein (nur Bahn-`route_type`s 2 und 100–117 und nur Fahrten
   von gestern/heute/morgen, damit der Speicher klein bleibt). Bei Tageswechsel wird neu geladen.
2. Alle 35 s holt er GTFS-RT Trip Updates und rechnet die Verspätungen auf die Halte der Fahrt um
   (Verspätungen werden auf nachfolgende Halte übertragen, ausgefallene Fahrten ausgeblendet).
3. Das Gleisnetz der Schweiz wird aus OpenStreetMap geladen (`railway=rail|narrow_gauge|light_rail|funicular`,
   ohne Rangiergleise). Für jedes Paar aufeinanderfolgender Halte sucht der Server per A* den Weg über die
   Gleise – über gerichtete Gleisabschnitte, sodass Züge an Weichen nicht „umkehren“ (max. 70° Richtungsänderung
   pro Knoten, notfalls 110°). Die Wege werden vereinfacht, in `data/rail-legs.json` gespeichert und bei
   späteren Starts wiederverwendet; das Gleisnetz wird nur geladen, wenn neue Abschnitte fehlen. Findet sich
   kein plausibler Weg (z. B. ausserhalb des Kartenausschnitts), fährt der Zug auf der Luftlinie.
4. `/api/trains` liefert für jeden fahrenden Zug den aktuellen Halt plus die nächsten Wegpunkte mit
   (erwarteten) Ankunfts-/Abfahrtszeiten.
   Jeder Wegpunkt trägt die ID des folgenden Streckenabschnitts.
5. Der Browser holt die Geometrie der Abschnitte einmalig (`/api/legs`), interpoliert die Position entlang der
   Gleise und animiert die Züge flüssig; neue Positionsdaten alle 10 s.

## Starten

```bash
npm install

# Demo mit künstlichem Mini-Fahrplan (ohne Download, sofort lauffähig)
npm run demo

# Echte Daten (Fahrplan wird beim ersten Start heruntergeladen)
GTFS_RT_API_KEY=<dein-key> npm start
```

Dann <http://localhost:8080> öffnen.

Mit Docker:

```bash
docker build -t swisstrainmap .
docker run -p 8080:8080 -v "$(pwd)/data:/app/data" -e GTFS_RT_API_KEY=<dein-key> swisstrainmap
```

### API-Key

Für die Echtzeitdaten braucht es einen (kostenlosen) Key von
[opentransportdata.swiss](https://opentransportdata.swiss) für die API *GTFS-RT*. Ohne Key läuft die Karte
rein nach Fahrplan. Den Key gibt es im [API-Manager](https://api-manager.opentransportdata.swiss) (Produkt *GTFS-RT*, App anlegen,
Redirect-URLs leer lassen). Er wird als `Authorization: Bearer <key>` gesendet. Die API erlaubt nur
je nach Plan nur **2–5 Abfragen pro Minute** (aktueller GTFS-RT-Plan: 5/min). Der Server fragt standardmässig
alle 35 s ab (mit `GTFS_RT_INTERVAL` bis minimal 12 s), wartet bei
HTTP 429 und speichert den letzten Feed in `data/gtfs-rt.pb`, damit ein Neustart sofort Daten hat und das
Limit nicht verletzt. Die Browser greifen nie selbst auf die API zu – egal wie viele Leute die Karte offen
haben, es bleibt bei einer Abfrage alle 35 s.

Hinweis: GPS-Positionen der Züge werden nicht veröffentlicht; die Karte schätzt die Position immer aus
Fahrplan und Prognose.

## Konfiguration

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | `8080` | HTTP-Port |
| `GTFS_PATH` | – | Lokaler Fahrplan (ZIP oder entpacktes Verzeichnis). Wenn gesetzt, wird nichts heruntergeladen. |
| `GTFS_URL` | Permalink *timetable-2026-gtfs2020* | Download-URL des GTFS-ZIP. Zum Fahrplanwechsel im Dezember auf den neuen Datensatz anpassen. |
| `GTFS_CACHE_FILE` | `data/gtfs.zip` | Ablage des heruntergeladenen Fahrplans |
| `GTFS_MAX_AGE_HOURS` | `24` | Danach wird der Fahrplan neu heruntergeladen |
| `GTFS_RT_URL` | `https://api.opentransportdata.swiss/la/gtfs-rt` | GTFS-RT-Endpunkt |
| `GTFS_RT_API_KEY` | – | API-Key für GTFS-RT |
| `GTFS_RT_INTERVAL` | `35` | Abfrageintervall GTFS-RT in Sekunden (Minimum 12; beim Plan mit 5 Abfragen/min z. B. `15`) |
| `GTFS_RT_CACHE_FILE` | `data/gtfs-rt.pb` | Letzter GTFS-RT-Feed (für Neustarts) |
| `RAIL_ROUTING` | `1` | `0` = Gleisnetz nicht verwenden (Luftlinie) |
| `RAIL_OSM_PATH` | – | Lokale Overpass-JSON-Datei mit dem Gleisnetz (statt Download) |
| `OVERPASS_URL` | `https://overpass.osm.ch/api/interpreter,https://overpass-api.de/api/interpreter` | Overpass-Server (kommagetrennt, der Reihe nach versucht) |
| `BBOX` | `45.75,5.85,47.85,10.55` | Fahrten ohne Halt in diesem Gebiet werden ignoriert (der Feed enthält z. B. auch SNCF-Züge Paris–Lyon) |
| `RAIL_OSM_CACHE_FILE` | `data/rail-osm.json` | Ablage des heruntergeladenen Gleisnetzes |
| `RAIL_OSM_MAX_AGE_DAYS` | `30` | Danach wird das Gleisnetz neu geladen (nur falls Abschnitte fehlen) |
| `RAIL_LEGS_CACHE_FILE` | `data/rail-legs.json` | Berechnete Streckenabschnitte |
| `ROUTE_TYPES` | `2,100,…,117` | GTFS `route_type`s, die als Zug gelten (z. B. zusätzlich `400,900` für Metro/Tram) |

## API

- `GET /api/trains` – alle fahrenden Züge: Name, Kategorie, Zugnummer, Ziel, Verspätung, aktueller/nächster
  Halt und `points: [[lat, lon, ankunftMs, abfahrtMs], …]`
- `GET /api/legs?ids=1,2,…` – Geometrie der Streckenabschnitte als Google-Polyline (`""` = Luftlinie,
  `null` = wird noch berechnet)
- `GET /api/trip/<tripId>|<YYYYMMDD>` – Halteliste mit Soll- und Prognosezeiten und Streckenverlauf
- `GET /api/status` – Zustand von Fahrplan- und Echtzeit-Import

## Projektstruktur

```
src/server.js              HTTP-Server, Laden/Neuladen des Fahrplans
src/gtfs-source.js         ZIP/Verzeichnis lesen, Download mit Cache
src/gtfs-loader.js         GTFS-Import (gefiltert auf Bahn und Datumsfenster)
src/timetable.js           Positionsberechnung inkl. Verspätungen
src/realtime.js            GTFS-RT-Abfrage und -Dekodierung
src/rail-network.js        OSM-Gleisnetz laden, Wegsuche (A*) zwischen Halten
src/legs.js                Streckenabschnitte verwalten und zwischenspeichern
src/polyline.js            Linien vereinfachen und kodieren
public/                    Leaflet-Frontend
scripts/make-demo-gtfs.js  Demo-Fahrplan und Demo-Gleisnetz erzeugen
test/                      Tests (npm test)
```

## Grenzen & Ideen für später

- **Streckenwahl geschätzt:** Der Schweizer GTFS-Feed enthält keine `shapes.txt` und keine Durchfahrtspunkte.
  Zwischen zwei Halten wird daher der kürzeste Weg auf den Gleisen angenommen. Fährt ein Zug planmässig einen
  Umweg (z. B. Bergstrecke statt Basistunnel ohne Halt dazwischen), stimmt die gezeichnete Strecke nicht.
- **Gleichmässige Geschwindigkeit:** Zwischen zwei Halten fährt der Zug mit konstantem Tempo (kein Anfahren/Bremsen).
- Der erste Download des Gleisnetzes über Overpass kann einige Minuten dauern und braucht beim Einlesen
  rund 1–2 GB RAM; danach reichen die gespeicherten Abschnitte.
- **Keine echten GPS-Daten:** Die Position ist eine Schätzung aus Fahrplan + Prognose.
- Der Landesfahrplan (inkl. Bus) ist gross; der erste Import dauert je nach Rechner etwa 1–2 Minuten und
  braucht einige hundert MB RAM.
- Weitere Ideen: Trams/Busse (`ROUTE_TYPES`), Störungsmeldungen (GTFS-RT Service Alerts), Abfahrtstafeln
  pro Bahnhof, WebSocket statt Polling.

## Lizenzen der Daten

- Fahrplan- und Echtzeitdaten: opentransportdata.swiss (Nutzungsbedingungen beachten)
- Kartendaten: © OpenStreetMap-Mitwirkende (ODbL), OpenRailwayMap (CC-BY-SA), CARTO
