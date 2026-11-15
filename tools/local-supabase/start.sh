#!/usr/bin/env bash
# Starts a local Supabase-compatible stack for testing CranCapital:
#   Postgres 16 + pg_cron (host install), GoTrue, PostgREST and Realtime
#   (Docker, host networking) and a small Node gateway on :54321.
# Linux only. Needs: postgresql-16, postgresql-16-cron, docker, node >= 22.
#   tools/local-supabase/start.sh          start (keeps existing data)
#   tools/local-supabase/start.sh --reset  wipe the database first
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PGBIN=/usr/lib/postgresql/16/bin
DATA="${CRAN_PGDATA:-/var/tmp/crancapital-pg}"
LOGDIR="${CRAN_LOGDIR:-/var/tmp/crancapital-logs}"
eval "$(node "$HERE/config.mjs")"
mkdir -p "$LOGDIR"; chmod 777 "$LOGDIR"

if [[ "${1:-}" == "--reset" ]]; then
  "$HERE/stop.sh" || true
  rm -rf "$DATA"
fi

if ! docker info >/dev/null 2>&1; then
  echo "starting docker daemon"
  setsid nohup dockerd >"$LOGDIR/dockerd.log" 2>&1 </dev/null &
  timeout 30 bash -c 'until docker info >/dev/null 2>&1; do sleep 1; done'
fi

as_pg() { if [[ $(id -u) == 0 ]]; then runuser -u postgres -- "$@"; else "$@"; fi; }

if [[ ! -f "$DATA/PG_VERSION" ]]; then
  mkdir -p "$DATA"
  [[ $(id -u) == 0 ]] && chown postgres:postgres "$DATA"
  as_pg "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
  cat >>"$DATA/postgresql.conf" <<EOF
port = 54322
listen_addresses = '127.0.0.1'
wal_level = logical
max_wal_senders = 10
max_replication_slots = 10
shared_preload_libraries = 'pg_cron'
cron.database_name = 'postgres'
cron.timezone = 'UTC'
timezone = 'UTC'
EOF
  NEW_DB=1
fi

if ! as_pg "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
  as_pg "$PGBIN/pg_ctl" -D "$DATA" -l "$LOGDIR/postgres.log" -w start >/dev/null
fi
psql_() { psql "postgres://postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -q "$@"; }
psql_ -f "$HERE/bootstrap.sql" >/dev/null

run() {
  local name=$1; shift
  if docker ps --format '{{.Names}}' | grep -qx "$name"; then return; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --network host --restart unless-stopped "$@" >/dev/null
}

run cc-auth \
  -e GOTRUE_API_HOST=127.0.0.1 -e GOTRUE_API_PORT=54331 -e PORT=54331 \
  -e API_EXTERNAL_URL="$LOCAL_API_URL/auth/v1" \
  -e GOTRUE_DB_DRIVER=postgres \
  -e GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:postgres@127.0.0.1:54322/postgres" \
  -e GOTRUE_SITE_URL="http://localhost:5173" \
  -e GOTRUE_URI_ALLOW_LIST="http://localhost:5173/**,http://127.0.0.1:5173/**,http://localhost:4173/**" \
  -e GOTRUE_DISABLE_SIGNUP=false \
  -e GOTRUE_JWT_ADMIN_ROLES=service_role -e GOTRUE_JWT_AUD=authenticated \
  -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated -e GOTRUE_JWT_EXP=3600 \
  -e GOTRUE_JWT_SECRET="$LOCAL_JWT_SECRET" \
  -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_MAILER_AUTOCONFIRM=true \
  -e GOTRUE_RATE_LIMIT_VERIFY=100000 -e GOTRUE_RATE_LIMIT_TOKEN_REFRESH=100000 \
  -e GOTRUE_RATE_LIMIT_OTP=100000 -e GOTRUE_RATE_LIMIT_EMAIL_SENT=100000 \
  -e GOTRUE_SMTP_ADMIN_EMAIL=admin@localhost -e GOTRUE_MAILER_OTP_EXP=3600 \
  supabase/gotrue:v2.197.0

run cc-rest \
  -e PGRST_DB_URI="postgres://authenticator:postgres@127.0.0.1:54322/postgres" \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_DB_EXTRA_SEARCH_PATH=public,extensions \
  -e PGRST_JWT_SECRET="$LOCAL_JWT_SECRET" -e PGRST_DB_USE_LEGACY_GUCS=false \
  -e PGRST_SERVER_PORT=54330 -e PGRST_ADMIN_SERVER_PORT=54333 \
  -e PGRST_DB_MAX_ROWS=1000 -e PGRST_DB_CHANNEL_ENABLED=true \
  postgrest/postgrest:v14.18

run cc-realtime \
  -e PORT=54332 -e DB_HOST=127.0.0.1 -e DB_PORT=54322 -e DB_USER=supabase_admin \
  -e DB_PASSWORD=postgres -e DB_NAME=postgres \
  -e DB_AFTER_CONNECT_QUERY='SET search_path TO _realtime' \
  -e DB_ENC_KEY=supabaserealtime -e API_JWT_SECRET="$LOCAL_JWT_SECRET" \
  -e SECRET_KEY_BASE=UpNVntn3cDxHJpq99YMc1T1AQgQpc8kfYTuRgBiYa15BLrx8etQoXz3gZv1/u2oq \
  -e METRICS_JWT_SECRET="$LOCAL_JWT_SECRET" \
  -e ERL_AFLAGS="-proto_dist inet_tcp" -e DNS_NODES="''" -e RLIMIT_NOFILE=10000 \
  -e APP_NAME=realtime -e SEED_SELF_HOST=true -e RUN_JANITOR=true \
  supabase/realtime:v2.148.3

if ! curl -s -o /dev/null "http://127.0.0.1:54321/dev/x" 2>/dev/null; then
  setsid nohup node "$HERE/gateway.mjs" >"$LOGDIR/gateway.log" 2>&1 </dev/null &
fi

echo "waiting for services"
timeout 120 bash -c 'until curl -sf http://127.0.0.1:54331/health >/dev/null; do sleep 1; done' || { echo "auth failed"; docker logs cc-auth | tail -20; exit 1; }
timeout 60 bash -c 'until curl -sf http://127.0.0.1:54330/ >/dev/null; do sleep 1; done' || { echo "rest failed"; docker logs cc-rest | tail -20; exit 1; }
timeout 120 bash -c "until curl -sf -H 'Authorization: Bearer $LOCAL_ANON_KEY' http://127.0.0.1:54332/api/tenants/realtime-dev/health >/dev/null; do sleep 2; done" || { echo "realtime not healthy yet (check: docker logs cc-realtime)"; }
echo "local Supabase ready: API $LOCAL_API_URL  DB $LOCAL_DB_URL"
echo "anon key: $LOCAL_ANON_KEY"
