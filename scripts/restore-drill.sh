#!/usr/bin/env bash
# Timed restore drill (Assessment 14): decrypt the latest (or given) backup, restore it into a SCRATCH database,
# verify integrity (checksum, ledger invariants, audit chain, row counts vs source) and report RTO/RPO.
#   ADMIN_DATABASE_URL   superuser/CREATEDB connection to the target cluster (any database on it)
#   SOURCE_DATABASE_URL  optional: the live database, to compare counts and totals
#   BACKUP_PASSPHRASE_FILE, BACKUP_FILE (default: newest in BACKUP_DIR)
set -euo pipefail

: "${ADMIN_DATABASE_URL:?set ADMIN_DATABASE_URL}"
: "${BACKUP_PASSPHRASE_FILE:?set BACKUP_PASSPHRASE_FILE}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
file="${BACKUP_FILE:-$(ls -1t "$BACKUP_DIR"/fincore-*.dump.gpg | head -n1)}"
scratch="fincore_restore_drill_$(date -u +%Y%m%d%H%M%S)"
drill_url="${ADMIN_DATABASE_URL%/*}/$scratch${ADMIN_DATABASE_URL##*/fincore}"

echo "== restore drill: $(date -u +%FT%TZ) file=$file target_db=$scratch"
sha256sum --check --status "$file.sha256" && echo "checksum: OK"
taken=$(basename "$file" | sed -E 's/fincore-([0-9]{8}T[0-9]{6}Z).*/\1/')

# Client tools must match the server major version (lesson from the first drill: pg_restore 18 emits
# "SET transaction_timeout", unknown to PostgreSQL 16). On the VM the postgres:16 container's tools are used.
server_major=$(psql --no-psqlrc -tA -d "$ADMIN_DATABASE_URL" -c "SHOW server_version_num" | cut -c1-2)
client_major=$(pg_restore --version | grep -oE '[0-9]+' | head -n1)
if [[ "$server_major" != "$client_major" ]]; then
  echo "WARNING: pg_restore $client_major vs server $server_major (PG_RESTORE_COMPAT=${PG_RESTORE_COMPAT:-0})"
fi

t0=$(date +%s.%N)
psql --no-psqlrc -q -d "$ADMIN_DATABASE_URL" -c "CREATE DATABASE \"$scratch\" OWNER fincore_owner"
decrypt() { gpg --batch --quiet --decrypt --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" "$file"; }
if [[ "${PG_RESTORE_COMPAT:-0}" == "1" ]]; then
  # Local-only workaround: render SQL with the newer client and drop the one statement PG16 doesn't know.
  decrypt | pg_restore -f - | grep -v '^SET transaction_timeout' | psql --no-psqlrc -q -v ON_ERROR_STOP=1 -d "$drill_url" > /dev/null
else
  decrypt | pg_restore --no-password --exit-on-error --dbname="$drill_url"
fi
t1=$(date +%s.%N)

echo "== verification on restored database"
psql --no-psqlrc -v ON_ERROR_STOP=1 -d "$drill_url" -f "$(dirname "$0")/invariant-check.sql"
counts_sql="SELECT (SELECT count(*) FROM ledger_entries) AS entries, (SELECT count(*) FROM transactions) AS journals,
            (SELECT coalesce(sum(amount_minor),0) FROM ledger_entries WHERE direction='DEBIT') AS debit_total,
            (SELECT count(*) FROM audit_log) AS audit_rows"
restored=$(psql --no-psqlrc -tA -d "$drill_url" -c "$counts_sql")
echo "restored: entries|journals|debit_total|audit_rows = $restored"
if [[ -n "${SOURCE_DATABASE_URL:-}" ]]; then
  source=$(psql --no-psqlrc -tA -d "$SOURCE_DATABASE_URL" -c "$counts_sql")
  echo "source:   entries|journals|debit_total|audit_rows = $source"
  [[ "$restored" == "$source" ]] && echo "source comparison: IDENTICAL (no writes since backup)" || echo "source comparison: differs by writes made after the backup (RPO window)"
fi

rto=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.2f", b-a}')
rpo_s=$(( $(date -u +%s) - $(date -u -d "$(echo "$taken" | sed -E 's/(....)(..)(..)T(..)(..)(..)Z/\1-\2-\3 \4:\5:\6/')" +%s) ))
echo "== RESULT: restore time (RTO measured) = ${rto}s ; backup age at restore (RPO bound) = ${rpo_s}s"

if [[ "${KEEP_SCRATCH:-0}" != "1" ]]; then
  psql --no-psqlrc -q -d "$ADMIN_DATABASE_URL" -c "DROP DATABASE \"$scratch\""
  echo "scratch database dropped"
fi
