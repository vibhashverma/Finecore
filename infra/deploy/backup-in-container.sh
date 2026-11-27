#!/usr/bin/env bash
# Runs pg_dump INSIDE the postgres:16 container (client = server major version; lesson from the first restore drill),
# encrypts with gpg AES256 on the host, keeps 14 days. Passphrase: /etc/fincore/backup.pass (root 0600).
set -euo pipefail
cd /opt/fincore
set -a; . /etc/fincore/production.env; set +a
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="/opt/fincore/backups/fincore-$stamp.dump.gpg"
docker compose exec -T postgres pg_dump --format=custom -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  | gpg --batch --yes --quiet --symmetric --cipher-algo AES256 --pinentry-mode loopback \
        --passphrase-file /etc/fincore/backup.pass --output "$out"
sha256sum "$out" > "$out.sha256"
find /opt/fincore/backups -name 'fincore-*.dump.gpg*' -mtime +14 -delete
# Off-host copy (recommended): rclone/s3 sync of /opt/fincore/backups to object storage with versioning.
echo "backup ok: $out ($(wc -c < "$out") bytes)"
