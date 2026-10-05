#!/usr/bin/env bash
# Installiert oder aktualisiert Swiss Train Map auf einem Server mit Docker.
#
#   curl -fsSL https://raw.githubusercontent.com/stefan-ffr/swisstrainmap/main/deploy/install.sh | bash
#
# Installiert fehlende Pakete (git, curl, Docker mit Compose-Plugin) auf
# Debian/Ubuntu, Fedora/RHEL/Rocky/Alma und Alpine, fragt Domain und
# API-Keys (GTFS-RT, GTFS-SA) ab (Keys werden bei der Eingabe nicht angezeigt) und
# startet App + Caddy (HTTPS) mit docker compose.
# Ohne Rückfragen, z. B. für Automatisierung:
#   DOMAIN=… GTFS_RT_API_KEY=… GTFS_SA_API_KEY=… bash install.sh
# Weitere Variablen: INSTALL_DIR (Standard ~/swisstrainmap), BRANCH (main), REPO_URL.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/stefan-ffr/swisstrainmap.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/swisstrainmap}"
DEFAULT_DOMAIN="swisstransportmap.juroct.net"
RT_URL="https://api.opentransportdata.swiss/la/gtfs-rt"
SA_URL="https://api.opentransportdata.swiss/la/gtfs-sa"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31mFehler: %s\033[0m\n' "$*" >&2; exit 1; }

# Bei "curl | bash" ist stdin das Skript – Eingaben kommen vom Terminal.
ask() { # ask <Variable> <Frage> [geheim]
  local __var="$1" __prompt="$2" __secret="${3:-}" __value=""
  [ -r /dev/tty ] || die "Kein Terminal für Eingaben. Werte als Umgebungsvariablen übergeben (DOMAIN, GTFS_RT_API_KEY, GTFS_SA_API_KEY)."
  if [ -n "$__secret" ]; then
    read -rs -p "$__prompt" __value </dev/tty; echo >/dev/tty
  else
    read -r -p "$__prompt" __value </dev/tty
  fi
  printf -v "$__var" '%s' "$__value"
}

# --- Voraussetzungen installieren ----------------------------------------------
if [ "$(id -u)" -eq 0 ]; then SUDO=""
elif command -v sudo >/dev/null; then SUDO="sudo"
else die "Bitte als root ausführen oder sudo installieren."
fi

OS_ID="" OS_LIKE=""
if [ -r /etc/os-release ]; then . /etc/os-release; OS_ID="${ID:-}"; OS_LIKE="${ID_LIKE:-}"; fi
is_os() { case " $OS_ID $OS_LIKE " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

install_packages() { # install_packages <paket> …
  if is_os debian || is_os ubuntu; then
    $SUDO apt-get update -qq
    DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq "$@"
  elif is_os fedora || is_os rhel || is_os centos; then
    $SUDO dnf install -y -q "$@"
  elif is_os alpine; then
    $SUDO apk add --no-cache -q "$@"
  else
    die "Unbekanntes System ($OS_ID). Bitte $* selbst installieren."
  fi
}

missing=()
command -v git >/dev/null || missing+=(git)
command -v curl >/dev/null || missing+=(curl)
[ -e /etc/ssl/certs/ca-certificates.crt ] || [ -e /etc/pki/tls/certs/ca-bundle.crt ] || missing+=(ca-certificates)
if [ "${#missing[@]}" -gt 0 ]; then
  say "Installiere ${missing[*]} …"
  install_packages "${missing[@]}"
fi

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  say "Installiere Docker mit Compose-Plugin …"
  if is_os alpine; then
    $SUDO apk add --no-cache -q docker docker-cli-compose
    $SUDO rc-update add docker default >/dev/null
    $SUDO service docker start >/dev/null
  else
    # offizielles Installationsskript von Docker (Debian, Ubuntu, Fedora, RHEL, CentOS …)
    curl -fsSL https://get.docker.com | $SUDO sh >/dev/null
    $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
  fi
fi

# Docker ohne root nur, wenn der Benutzer in der Gruppe docker ist
if [ -z "$SUDO" ] || docker info >/dev/null 2>&1; then DOCKER="docker"; else DOCKER="$SUDO docker"; fi
$DOCKER compose version >/dev/null 2>&1 || die "Docker Compose ist nicht verfügbar."

# --- Code holen ----------------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Aktualisiere $INSTALL_DIR …"
  git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout --quiet "$BRANCH"
  git -C "$INSTALL_DIR" pull --quiet --ff-only origin "$BRANCH"
else
  say "Lade Swiss Train Map nach $INSTALL_DIR …"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# Vorhandene Einstellungen als Vorschlag übernehmen
OLD_DOMAIN=""
if [ -f .env ]; then OLD_DOMAIN="$(grep -E '^DOMAIN=' .env | cut -d= -f2- || true)"; fi

# --- Domain --------------------------------------------------------------------
if [ -z "${DOMAIN:-}" ]; then
  suggestion="${OLD_DOMAIN:-$DEFAULT_DOMAIN}"
  ask DOMAIN "Domain [$suggestion]: "
  DOMAIN="${DOMAIN:-$suggestion}"
fi

# --- API-Keys -------------------------------------------------------------------
# Jedes Produkt im API-Manager (https://api-manager.opentransportdata.swiss) hat
# einen eigenen Key. Bisherige Keys bleiben mit Enter erhalten.
ask_key() { # ask_key <Variable> <Beschreibung> <Prüf-URL>
  local var="$1" what="$2" url="$3" old="" value code
  if [ -f .env ]; then old="$(grep -E "^$var=" .env | cut -d= -f2- || true)"; fi
  if [ -z "${!var+x}" ]; then
    echo
    echo "API-Key für $what"
    if [ -n "$old" ]; then
      ask value "Key (Eingabe unsichtbar, Enter = bisherigen behalten): " secret
      value="${value:-$old}"
    else
      ask value "Key (Eingabe unsichtbar, Enter = ohne): " secret
    fi
  else
    value="${!var}"
  fi
  value="$(printf '%s' "$value" | tr -d '[:space:]')"
  printf -v "$var" '%s' "$value"
  [ -n "$value" ] || return 0
  # Eine einzige Abfrage zählt gegen das Limit (je nach Plan 2–5/min) – unproblematisch.
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 -H "Authorization: Bearer $value" "$url" || true)"
  case "$code" in
    200|302) say "Key für $what funktioniert." ;;
    401|403) warn "Key für $what wird abgelehnt (HTTP $code) – bitte im API-Manager prüfen. Installation läuft trotzdem weiter." ;;
    429) warn "Rate-Limit erreicht (HTTP 429) – Key für $what konnte nicht geprüft werden." ;;
    *) warn "Key für $what konnte nicht geprüft werden (HTTP ${code:-keine Antwort})." ;;
  esac
}
ask_key GTFS_RT_API_KEY "GTFS-RT (Echtzeit-Verspätungen; ohne Key Positionen nach Fahrplan)" "$RT_URL"
ask_key GTFS_SA_API_KEY "GTFS-SA (Störungsmeldungen)" "$SA_URL"

# --- .env schreiben -------------------------------------------------------------
umask 077
{
  echo "# Erzeugt von deploy/install.sh am $(date '+%Y-%m-%d %H:%M')"
  echo "DOMAIN=$DOMAIN"
  echo "GTFS_RT_API_KEY=$GTFS_RT_API_KEY"
  echo "GTFS_SA_API_KEY=$GTFS_SA_API_KEY"
  grep -vE '^(#|DOMAIN=|GTFS_RT_API_KEY=|GTFS_SA_API_KEY=|$)' deploy/env.example
  # eigene Ergänzungen aus einer bestehenden .env behalten
  if [ -f .env ]; then grep -vE '^(#|DOMAIN=|GTFS_RT_API_KEY=|GTFS_SA_API_KEY=|GTFS_RT_INTERVAL=|MODES=|$)' .env || true; fi
} > .env.new
mv .env.new .env
say ".env geschrieben (nur für den Besitzer lesbar)."

# --- Starten -----------------------------------------------------------------------
say "Baue und starte die Container …"
$DOCKER compose up -d --build

echo
say "Fertig. Die Karte ist gleich unter https://$DOMAIN erreichbar."
echo "Der erste Start lädt Fahrplan und Gleisnetz (≈ 3–4 Minuten). Fortschritt:"
echo "  cd $INSTALL_DIR && $DOCKER compose logs -f app"
