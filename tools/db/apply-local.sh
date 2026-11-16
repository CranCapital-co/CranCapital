#!/usr/bin/env bash
# Rebuilds CranCapital's game schema in the local database: drops the game
# schema and the public API functions, then applies every migration and
# seed file in order. Player data in the local DB is lost.
#   tools/db/apply-local.sh            all cities
#   CITIES="london" tools/db/apply-local.sh   just London (faster)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB="${LOCAL_DB_URL:-postgres://postgres:postgres@127.0.0.1:54322/postgres}"
PSQL=(psql "$DB" -v ON_ERROR_STOP=1 -q -X)

"${PSQL[@]}" <<'SQL'
select cron.unschedule(jobid) from cron.job where jobname like 'crancapital%';
drop schema if exists game cascade;
do $$
declare r record;
begin
  for r in select p.oid::regprocedure sig, p.prokind from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
    if r.prokind = 'p' then execute 'drop procedure ' || r.sig || ' cascade';
    else execute 'drop function ' || r.sig || ' cascade'; end if;
  end loop;
end $$;
SQL

for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "migration $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
for f in "$ROOT"/supabase/seed/cities/*.sql; do
  city=$(basename "$f" .sql)
  if [[ -n "${CITIES:-}" && " $CITIES " != *" $city "* ]]; then continue; fi
  echo "seed $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
for f in "$ROOT"/supabase/seed/*.sql; do
  echo "seed $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
"${PSQL[@]}" -c "notify pgrst, 'reload schema'"
echo "done"
