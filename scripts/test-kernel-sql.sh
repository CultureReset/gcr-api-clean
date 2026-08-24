#!/usr/bin/env bash
# =============================================================================
# Apply sql/kernel/*.sql to a THROWAWAY Postgres and check what they produced.
# =============================================================================
#
# sql/capability_tables.sql carries a DO NOT RUN banner because it was written
# against the wrong database and never validated anywhere. This script is the
# answer to that: a migration gets exercised before it is ever pointed at
# Supabase, on a cluster that is created here and destroyed at the end.
#
# It never reads a connection string, never sources .env, and cannot reach the
# live project. The only server it talks to is the one it just started on a
# unix socket it owns.
#
# Everything is applied TWICE. A migration that is not re-runnable is a
# migration that cannot be safely retried after a timeout, and the Supabase SQL
# connection for this project times out intermittently — so retrying is not a
# hypothetical.
#
#   ./scripts/test-kernel-sql.sh
#
# Exits 0 if every migration applied twice and every assertion held.
# Exits 0 with a loud SKIPPED if no local Postgres is installed.
# =============================================================================
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
kernel="$repo/sql/kernel"

pgbin=""
for d in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin /opt/homebrew/opt/postgresql*/bin; do
  [ -x "$d/initdb" ] && pgbin="$d"
done
if [ -z "$pgbin" ] && command -v initdb >/dev/null 2>&1; then
  pgbin="$(dirname "$(command -v initdb)")"
fi

if [ -z "$pgbin" ]; then
  echo "SKIPPED — no local PostgreSQL found, so the kernel migrations were NOT tested."
  echo "         Install postgresql (any version >= 14) to run this check."
  echo "         Do not read a green build as evidence these migrations work."
  exit 0
fi

# Postgres refuses to run as root. When this script is run by root — which is
# the case in the container this repo is developed in — the cluster runs as the
# `postgres` system user instead, in a directory that user can reach.
runas=""
if [ "$(id -u)" -eq 0 ]; then
  if ! id postgres >/dev/null 2>&1; then
    echo "SKIPPED — running as root and there is no 'postgres' user to drop to."
    echo "         The kernel migrations were NOT tested."
    exit 0
  fi
  runas="postgres"
  work="$(su postgres -c 'mktemp -d /tmp/gcr-kernel-test.XXXXXX')"
else
  work="$(mktemp -d "${TMPDIR:-/tmp}/gcr-kernel-test.XXXXXX")"
fi

# The migrations have to be somewhere the cluster's user can read them. In this
# container the repo sits under a directory root keeps to itself.
stage="$work/sql"
mkdir -p "$stage"
cp "$kernel"/*.sql "$kernel"/test/*.sql "$stage"/
[ -n "$runas" ] && chown -R "$runas" "$work"

cleanup() {
  if [ -n "$runas" ]; then
    su "$runas" -c "PATH=$pgbin:\$PATH; pg_ctl -D $work/data -m immediate stop" >/dev/null 2>&1 || true
  else
    PATH="$pgbin:$PATH" pg_ctl -D "$work/data" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

run() {  # run <shell-command> as the cluster's user
  if [ -n "$runas" ]; then su "$runas" -c "PATH=$pgbin:\$PATH; $1"
  else PATH="$pgbin:$PATH" bash -c "$1"; fi
}

echo "Starting a throwaway cluster in $work"
run "initdb -D $work/data -U postgres --auth=trust" >/dev/null 2>&1
mkdir -p "$work/sock"; [ -n "$runas" ] && chown "$runas" "$work/sock"
run "pg_ctl -D $work/data -o '-k $work/sock -c listen_addresses=' -l $work/data/log -w start" >/dev/null 2>&1

psql_="psql -h $work/sock -U postgres -d kernel -v ON_ERROR_STOP=1 -q"

run "psql -h $work/sock -U postgres -q -c 'create database kernel'"
run "$psql_ -f $stage/stub_live_schema.sql"
echo "  live-schema stub applied"

for pass in 1 2; do
  for f in "$stage"/0*.sql; do
    base="$(basename "$f")"
    # Captured rather than piped: a pipeline reports the LAST command's status,
    # so `psql | grep` would have reported grep's opinion of psql's failure.
    if ! out="$(run "$psql_ -f $f" 2>&1)"; then
      echo "FAILED on pass $pass: $base"
      echo "$out"
      exit 1
    fi
    echo "$out" | grep -v 'already exists, skipping' | grep -v '^$' || true
    echo "  pass $pass  $base"
  done
done
echo "  every migration applied twice — they are re-runnable"

if ! out="$(run "$psql_ -f $stage/assertions.sql" 2>&1)"; then
  echo "ASSERTIONS FAILED"
  echo "$out"
  exit 1
fi
echo "$out" | grep -v '^$' || true

tables=$(run "psql -h $work/sock -U postgres -d kernel -tAc \"select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'\"")
echo "OK — kernel migrations applied twice and every assertion held (${tables// /} tables)."
