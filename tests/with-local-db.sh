#!/bin/sh
# Use an isolated Unix socket; no project credentials or network database connections.
set -eu

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 command [argument ...]" >&2
  exit 2
fi

if [ -n "${CBT_PG_BIN:-}" ]; then
  PATH="$CBT_PG_BIN:$PATH"
elif command -v brew >/dev/null && [ -d "$(brew --prefix postgresql@17)/bin" ]; then
  PATH="$(brew --prefix postgresql@17)/bin:$PATH"
fi
export PATH

if ! command -v initdb >/dev/null; then
  echo 'Install PostgreSQL 17 binaries or set CBT_PG_BIN.' >&2
  exit 2
fi

unset PGDATABASE PGUSER PGPASSWORD PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS
cbt_db_temp="$(mktemp -d /tmp/cbt-test.XXXXXXXX)"
trap 'pg_ctl -D "$cbt_db_temp/data" -m fast -w stop >/dev/null 2>&1 || true; rm -rf "$cbt_db_temp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export PGHOST="$cbt_db_temp" PGPORT=55432 PGDATABASE=cbt_synthetic PGUSER=postgres
export CBT_TEST_DATABASE=1
initdb -D "$cbt_db_temp/data" -U "$PGUSER" --no-locale --encoding=UTF8 --auth=trust >/dev/null
cbt_pg_options="-k $PGHOST -p $PGPORT -c listen_addresses=''"
if [ "${CBT_CRON:-auto}" != 0 ] && [ -f "$(pg_config --sharedir)/extension/pg_cron.control" ]; then
  cbt_pg_options="$cbt_pg_options -c shared_preload_libraries=pg_cron -c cron.database_name=$PGDATABASE -c cron.use_background_workers=on"
  export CBT_TEST_CRON=1
elif [ "${CBT_CRON:-auto}" = 1 ]; then
  echo 'pg_cron is required but unavailable for these PostgreSQL binaries.' >&2
  exit 2
else
  export CBT_TEST_CRON=0
fi
pg_ctl -D "$cbt_db_temp/data" -l "$cbt_db_temp/postgres.log" -o "$cbt_pg_options" -w start >/dev/null
createdb "$PGDATABASE"
cbt_project="$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)"
cd "$cbt_project"
psql -Xq -v ON_ERROR_STOP=1 --single-transaction -f tests/baseline.sql
for cbt_migration in supabase/migrations/*.sql; do
  [ -f "$cbt_migration" ] || continue
  if [ "${CBT_STUDENT_ONLY:-0}" = 1 ]; then
    case "$cbt_migration" in
      *_cbt_staff.sql) continue ;;
    esac
  fi
  case "$cbt_migration:$CBT_TEST_CRON" in
    *_cbt_cron.sql:0)
      echo 'pg_cron unavailable or disabled; testing its finalizer directly.' >&2
      continue
      ;;
  esac
  psql -Xq -v ON_ERROR_STOP=1 --single-transaction -f "$cbt_migration"
done
"$@"
