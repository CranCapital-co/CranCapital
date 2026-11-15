#!/usr/bin/env bash
# Stops the local Supabase stack started by start.sh (data is kept).
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${CRAN_PGDATA:-/var/tmp/crancapital-pg}"
docker rm -f cc-auth cc-rest cc-realtime >/dev/null 2>&1 || true
pkill -f "$HERE/gateway.mjs" 2>/dev/null || true
if [[ -f "$DATA/PG_VERSION" ]]; then
  if [[ $(id -u) == 0 ]]; then runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$DATA" stop -m fast >/dev/null 2>&1 || true
  else /usr/lib/postgresql/16/bin/pg_ctl -D "$DATA" stop -m fast >/dev/null 2>&1 || true; fi
fi
echo "stopped"
