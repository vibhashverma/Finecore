#!/usr/bin/env bash
# Encrypted logical backup (Assessment 14). Schedule via cron/systemd timer on the VM (see infra/deploy/README.md).
#   BACKUP_DATABASE_URL  connection as the schema owner (read access to everything)
#   BACKUP_PASSPHRASE_FILE  file holding the symmetric passphrase (never in git; root-only permissions)
#   BACKUP_DIR (default ./backups), BACKUP_RETENTION_DAYS (default 14)
# Output: fincore-<UTC timestamp>.dump.gpg (+ .sha256). Plaintext never touches disk.
set -euo pipefail

: "${BACKUP_DATABASE_URL:?set BACKUP_DATABASE_URL}"
: "${BACKUP_PASSPHRASE_FILE:?set BACKUP_PASSPHRASE_FILE}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/fincore-$stamp.dump.gpg"

start=$(date +%s)
pg_dump --format=custom --no-password --dbname="$BACKUP_DATABASE_URL" \
  | gpg --batch --yes --quiet --symmetric --cipher-algo AES256 --pinentry-mode loopback \
        --passphrase-file "$BACKUP_PASSPHRASE_FILE" --output "$out"
sha256sum "$out" > "$out.sha256"
echo "backup=$out bytes=$(wc -c < "$out") seconds=$(( $(date +%s) - start )) taken_at=$stamp"

# Retention: delete encrypted backups older than N days.
find "$BACKUP_DIR" -name 'fincore-*.dump.gpg*' -type f -mtime +"$RETENTION" -print -delete
