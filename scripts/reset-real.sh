#!/usr/bin/env bash
# Wipe the REAL cockpit DB and re-discover clean. Use when :4317's Up Next has accumulated
# stale/noise sessions. Hard-kills the servers, removes data/cockpit.db (+ wal/shm), then
# restarts — the fresh DB re-discovers only genuine sessions (filtered in discover.ts).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
DB="${COCKPIT_DB:-${ROOT}/data/cockpit.db}"

echo "==> hard-killing cockpit servers"
pkill -9 -f 'dist/server/server.js' 2>/dev/null
sleep 1

echo "==> wiping real DB: ${DB}"
rm -f "${DB}" "${DB}-wal" "${DB}-shm"

echo "==> rebuild + restart (fresh DB re-discovers clean)"
bash "${ROOT}/scripts/restart.sh"
