#!/usr/bin/env bash
# Automatisches Update: schaut, ob es auf GitHub neue Commits gibt, und baut
# dann neu. Läuft per systemd-Timer bzw. cron (eingerichtet von install.sh),
# lässt sich aber auch von Hand starten:
#   sudo bash deploy/update.sh
# Nur Fast-Forward: Lokale Änderungen werden nie überschrieben. Schlägt der
# Build fehl, läuft die bisherige Version weiter.
set -euo pipefail
cd "$(dirname "$0")/.."

# Nie zwei Updates gleichzeitig (ein Build kann länger dauern als das Intervall)
if command -v flock >/dev/null; then
  exec 9>"${TMPDIR:-/tmp}/swisstrainmap-update.lock"
  flock -n 9 || exit 0
fi

# git als Besitzer des Ordners ausführen, damit keine Dateien root gehören
OWNER="$(stat -c %U .)"
if [ "$(id -u)" -eq 0 ] && [ "$OWNER" != "root" ]; then
  if command -v runuser >/dev/null; then
    git() { runuser -u "$OWNER" -- git "$@"; }
  else # z. B. Alpine ohne util-linux
    git() { su "$OWNER" -s /bin/sh -c "git $(printf '%q ' "$@")"; }
  fi
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
[ "$LOCAL" = "$REMOTE" ] && exit 0
if ! git merge-base --is-ancestor HEAD "origin/$BRANCH"; then
  echo "swisstrainmap: lokaler Stand weicht von origin/$BRANCH ab – kein automatisches Update" >&2
  exit 1
fi

echo "swisstrainmap: Update ${LOCAL:0:7} -> ${REMOTE:0:7}"
git merge --quiet --ff-only "origin/$BRANCH"
docker compose up -d --build
docker image prune -f >/dev/null 2>&1 || true
echo "swisstrainmap: Update fertig"
