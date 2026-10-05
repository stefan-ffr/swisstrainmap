# Swiss Train Map

Live-Karte des öffentlichen Verkehrs in der Schweiz – Züge, Trams, Busse, Schiffe und Bergbahnen – nachgebaut mit offenen Daten:

- **Fahrplan:** GTFS-Fahrplan von [opentransportdata.swiss](https://opentransportdata.swiss)
- **Echtzeit:** GTFS-RT Trip Updates (Verspätungen, Ausfälle) von opentransportdata.swiss
- **Gleisnetz:** OpenStreetMap-Gleise (via Overpass), damit die Züge den Strecken entlang fahren
- **Karte:** Landeskarte von swisstopo (grau oder farbig) oder OpenStreetMap als Grundkarte, darüber [OpenRailwayMap](https://www.openrailwaymap.org) (Infrastruktur, Höchstgeschwindigkeiten, Signale, Elektrifizierung)

## Wie funktioniert das?

Es gibt in der Schweiz keine öffentlichen GPS-Positionen der Züge. Die Position wird deshalb – wie bei den
bekannten Zugradar-Karten – **berechnet**:

1. Der Server lädt den GTFS-Fahrplan nur, wenn der Permalink auf eine neue Version zeigt, und erstellt daraus
   einmal einen Auszug für die gewählten Verkehrsmittel (`MODES`): Verkehrstage als kompakte Bitmaske statt
   11 Mio. Kalender-Ausnahmen und ein Index, wo die Haltezeiten jeder Fahrt stehen. Beim Start und bei
   jedem Tageswechsel liest er damit gezielt nur die Fahrten von gestern/heute/morgen.
2. Alle 35 s holt er GTFS-RT Trip Updates und rechnet die Verspätungen auf die Halte der Fahrt um
   (Verspätungen werden auf nachfolgende Halte übertragen, ausgefallene Fahrten ausgeblendet).
   Zusatzfahrten, die nur im Echtzeit-Feed stehen (kurzfristige Extrazüge, Ersatzbusse, Verstärkungskurse),
   werden aus den Halten und Zeiten des Feeds aufgebaut und als „Extrafahrt“ angezeigt. Weil GTFS-RT eine
   Fahrt nur enthält, solange sie läuft, protokolliert der Server jede Extrafahrt (`data/extras.json`, zwei
   Tage); die Liste „Extrafahrten heute“ zeigt auch bereits beendete. Güterzüge sind in keinen offenen Daten
   enthalten.
3. Das Gleisnetz der Schweiz wird aus OpenStreetMap geladen (`railway=rail|narrow_gauge|light_rail|funicular`,
   ohne Rangiergleise). Für jedes Paar aufeinanderfolgender Halte sucht der Server per A* den Weg über die
   Gleise – über gerichtete Gleisabschnitte, sodass Züge an Weichen nicht „umkehren“ (max. 70° Richtungsänderung
   pro Knoten, notfalls 110°). Die Wege werden vereinfacht, in `data/rail-legs.json` gespeichert und bei
   späteren Starts wiederverwendet; das Gleisnetz wird nur geladen, wenn neue Abschnitte fehlen. Findet sich
   kein plausibler Weg (z. B. ausserhalb des Kartenausschnitts), fährt der Zug auf der Luftlinie.
4. `/api/trains` liefert für jeden fahrenden Zug den aktuellen Halt plus die nächsten Wegpunkte mit
   (erwarteten) Ankunfts-/Abfahrtszeiten.
   Jeder Wegpunkt trägt die ID des folgenden Streckenabschnitts.
5. Züge zeigt die Karte immer; die übrigen Verkehrsmittel erst ab einer Zoomstufe (Schiffe ab 10, Metro und
   Bergbahnen ab 11, Trams ab 12, Busse ab 13) und nur für den sichtbaren Ausschnitt (`/api/trains?modes=…&bbox=…`).
   Trams, Metro und Standseilbahnen fahren wie Züge auf den OSM-Gleisen. Busse fahren auf den Strassen, die in
   OSM als Buslinien (`route=bus`/`trolleybus`) eingetragen sind – Einbahnstrassen werden beachtet (ausser mit
   Busausnahme), rechtwinkliges Abbiegen ist erlaubt, Wenden nicht. Schiffe folgen den in OSM gezeichneten
   Schiffskursen (`route=ferry`, ~700 Wege, ~1 MB; Kurse, die am selben Steg enden, werden verbunden) –
   so fahren sie z. B. durch den Aarekanal nach Interlaken statt übers Land. Fehlt ein Kurs und wäre der
   Weg über andere Stege mehr als dreimal so lang, gilt die Luftlinie. Luftseilbahnen fahren in Luftlinie.
6. Der Browser holt die Geometrie der Abschnitte einmalig (`/api/legs`), interpoliert die Position entlang der
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

### Betrieb auf einem VPS (Docker + automatisches HTTPS)

**Einzeiler** (als root oder mit sudo, auf Debian/Ubuntu, Fedora/RHEL/Rocky/Alma oder Alpine):

```bash
curl -fsSL https://raw.githubusercontent.com/stefan-ffr/swisstrainmap/main/deploy/install.sh | bash
```

Ohne curl (z. B. Debian minimal): `wget -qO- https://raw.githubusercontent.com/stefan-ffr/swisstrainmap/main/deploy/install.sh | bash`

Das Skript [`deploy/install.sh`](deploy/install.sh)
1. installiert fehlende Pakete: git, curl, CA-Zertifikate sowie Docker mit Compose-Plugin (über das offizielle
   Skript von get.docker.com, auf Alpine über apk),
2. lädt den Code nach `~/swisstrainmap` (bzw. aktualisiert ihn bei erneutem Aufruf),
3. fragt die Domain und den GTFS-RT-API-Key ab – der Key wird bei der Eingabe nicht angezeigt, mit einer
   einzelnen Abfrage geprüft und in `.env` (nur für den Besitzer lesbar) gespeichert,
4. startet App und Caddy mit `docker compose up -d --build`.

Erneut ausführen aktualisiert die Installation; mit Enter bleibt der bisherige Key erhalten. Ohne Rückfragen:
`DOMAIN=… GTFS_RT_API_KEY=… bash install.sh`. Weitere Variablen: `INSTALL_DIR`, `BRANCH`.

**Von Hand:** Voraussetzungen sind Docker mit Compose-Plugin, die Ports 80 und 443 und ein DNS-Eintrag (A/AAAA)
der Domain auf den Server. Mit allen Verkehrsmitteln braucht der Server im Betrieb rund 1,4 GB RAM und beim einmaligen Erstellen
des Auszugs pro Fahrplan-Version kurz rund 1,6 GB; ein VPS mit 4 GB reicht gut. Auf der Festplatte belegen
Fahrplan, Auszug und Gleisnetz zusammen etwa 1,5 GB in `./data`.

```bash
git clone https://github.com/stefan-ffr/swisstrainmap.git && cd swisstrainmap
cp deploy/env.example .env      # Domain und GTFS_RT_API_KEY eintragen
docker compose up -d --build
docker compose logs -f app      # erster Start: Download + Auszug ≈ 3–4 Minuten
```

Caddy holt das Zertifikat für die Domain automatisch. Updates: `git pull && docker compose up -d --build`.

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
| `GTFS_URL` | Permalink *timetable-{year}-gtfs2020* | Download-URL des GTFS-ZIP. `{year}` wird durch das aktuelle Fahrplanjahr ersetzt – der Fahrplanwechsel im Dezember geht automatisch. |
| `GTFS_CACHE_FILE` | `data/gtfs.zip` | Ablage des heruntergeladenen Fahrplans |
| `GTFS_MAX_AGE_HOURS` | `6` | So oft wird geprüft, ob der Permalink auf eine neue Fahrplan-Version zeigt; nur dann wird neu geladen |
| `MODES` | `rail,tram,metro,bus,ship,cable,funicular` | Verkehrsmittel, die geladen werden (z. B. nur `rail` für eine reine Zugkarte) |
| `FOREIGN_GTFS` | `de=…gtfs.de…,fr=…sncf…,at=…oebb…,it=…trenitalia…` | Fahrpläne der Nachbarländer (`Name=URL`, kommagetrennt; leer = aus; `{year}` = Fahrplanjahr) |
| `FOREIGN_GTFS_MAX_AGE_HOURS` | `24` | So oft wird geprüft, ob es neue ausländische Fahrpläne gibt (geladen wird nur bei Änderung) |
| `GTFS_EXTRACT_DIR` | `data/gtfs-extract` | Auszug für die gewählten Verkehrsmittel, einmal pro Fahrplan-Version erstellt |
| `GTFS_RT_URL` | `https://api.opentransportdata.swiss/la/gtfs-rt` | GTFS-RT-Endpunkt |
| `GTFS_RT_API_KEY` | – | API-Key für GTFS-RT |
| `GTFS_RT_ENABLED` | – | `1` = GTFS-RT auch ohne `GTFS_RT_API_KEY` abfragen (wenn ein Proxy den `Authorization`-Header ergänzt) |
| `GTFS_RT_INTERVAL` | `35` | Abfrageintervall GTFS-RT in Sekunden (Minimum 12; beim Plan mit 5 Abfragen/min z. B. `15`) |
| `EXTRAS_FILE` | `data/extras.json` | Protokoll der Extrafahrten (letzte 2 Tage) |
| `GTFS_RT_CACHE_FILE` | `data/gtfs-rt.pb` | Letzter GTFS-RT-Feed (für Neustarts) |
| `RAIL_ROUTING` | `1` | `0` = Gleisnetz nicht verwenden (Luftlinie) |
| `RAIL_OSM_PATH` | – | Lokale Overpass-JSON-Datei mit dem Gleisnetz (statt Download) |
| `OVERPASS_URL` | `https://overpass.osm.ch/api/interpreter,https://overpass-api.de/api/interpreter` | Overpass-Server (kommagetrennt, der Reihe nach versucht) |
| `BBOX` | `45.75,5.85,47.85,10.55` | Fahrten ohne Halt in diesem Gebiet werden ignoriert (der Feed enthält z. B. auch SNCF-Züge Paris–Lyon) |
| `RAIL_OSM_CACHE_FILE` | `data/rail-osm.json` | Ablage des heruntergeladenen Gleisnetzes |
| `RAIL_OSM_MAX_AGE_DAYS` | `30` | Danach wird das Gleisnetz neu geladen (nur falls Abschnitte fehlen) |
| `RAIL_LEGS_CACHE_FILE` | `data/rail-legs.json` | Berechnete Streckenabschnitte (Gleise und Busstrassen) |
| `ROAD_ROUTING` | `1` | `0` = Busse in Luftlinie statt auf den Strassen der OSM-Buslinien |
| `ROAD_OSM_PATH` | – | Lokale Overpass-JSON-Datei mit dem Busnetz (statt Download) |
| `ROAD_OSM_CACHE_FILE` | `data/road-osm.json` | Ablage des heruntergeladenen Busnetzes (~190 MB) |
| `SHIP_ROUTING` | `1` | `0` = Schiffe in Luftlinie statt auf den OSM-Schiffskursen |
| `SHIP_OSM_PATH` | – | Lokale Overpass-JSON-Datei mit den Schiffskursen (statt Download) |
| `SHIP_OSM_CACHE_FILE` | `data/water-osm.json` | Ablage der heruntergeladenen Schiffskurse |

## API

- `GET /api/trains` – alle fahrenden Züge: Name, Kategorie, Zugnummer, Ziel, Verspätung, aktueller/nächster
  Halt und `points: [[lat, lon, ankunftMs, abfahrtMs], …]`
- `GET /api/legs?ids=1,2,…` – Geometrie der Streckenabschnitte als Google-Polyline (`""` = Luftlinie,
  `null` = wird noch berechnet)
- `GET /api/trip/<tripId>|<YYYYMMDD>` – Halteliste mit Soll- und Prognosezeiten und Streckenverlauf
- `GET /api/extras?day=YYYYMMDD` – Protokoll der Extrafahrten eines Tages (Standard: heute), auch beendete
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

- **Internationale Züge:** Der Schweizer Fahrplan enthält z. B. den ICE 100 nur bis Basel Bad Bf. Der Server lädt
  deshalb zusätzlich die Fahrpläne aus Deutschland (gtfs.de/DELFI, Fernverkehr), Frankreich (SNCF), Österreich (ÖBB-Sollfahrplan) und Italien (Trenitalia) und hängt
  den Laufweg im Ausland an, wenn eine ausländische Fahrt am End- bzw. Anfangshalt und am Halt davor bzw. danach
  zur gleichen Zeit hält (±3 Min.). Die Verlängerung endet vor dem ersten Halt, der wieder in der Schweiz liegt
  (Landesgrenze aus OSM in `src/switzerland.json`) – diese Abschnitte führt der Schweizer Fahrplan schon selbst.
  Trenitalia veröffentlicht nur NeTEx; den GTFS-Feed wandelt das Projekt
  [deryclem/trenitalia-gtfs](https://github.com/deryclem/trenitalia-gtfs) wöchentlich daraus um. Echtzeit gilt nur
  für den Schweizer Teil.
  Im Ausland fahren die Züge auf der Luftlinie zwischen den Halten.
- **Streckenwahl geschätzt:** Der Schweizer GTFS-Feed enthält keine `shapes.txt` und keine Durchfahrtspunkte.
  Zwischen zwei Halten wird daher der kürzeste Weg auf den Gleisen angenommen. Fährt ein Zug planmässig einen
  Umweg (z. B. Bergstrecke statt Basistunnel ohne Halt dazwischen), stimmt die gezeichnete Strecke nicht.
- **Gleichmässige Geschwindigkeit:** Zwischen zwei Halten fährt der Zug mit konstantem Tempo (kein Anfahren/Bremsen).
- Der erste Download des Gleisnetzes über Overpass kann einige Minuten dauern und braucht beim Einlesen
  rund 1–2 GB RAM; danach reichen die gespeicherten Abschnitte.
- **Keine echten GPS-Daten:** Die Position ist eine Schätzung aus Fahrplan + Prognose.
- Der Landesfahrplan (inkl. Bus) ist gross; der erste Import dauert je nach Rechner etwa 1–2 Minuten und
  braucht einige hundert MB RAM.
- Weitere Ideen: Störungsmeldungen (GTFS-RT Service Alerts), Abfahrtstafeln
  pro Bahnhof, WebSocket statt Polling.

## Lizenzen der Daten

- Fahrplan- und Echtzeitdaten: opentransportdata.swiss (Nutzungsbedingungen beachten); Ausland: gtfs.de / DELFI e.V. (CC BY 4.0), SNCF (Open Data), ÖBB (data.oebb.at, CC BY 4.0), Trenitalia über den italienischen NAP / deryclem/trenitalia-gtfs (CC BY 4.0); Landesgrenze © OpenStreetMap-Mitwirkende (ODbL)
- Kartendaten: © swisstopo, © OpenStreetMap-Mitwirkende (ODbL), OpenRailwayMap (CC-BY-SA)
