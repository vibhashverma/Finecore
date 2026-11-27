#!/bin/sh
# Postgres container init hook (/docker-entrypoint-initdb.d). Runs once, on an empty data volume.
# Passwords come from the container environment and are never written to disk.
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v dbname="$POSTGRES_DB" \
  -v owner_password="$FINCORE_OWNER_PASSWORD" \
  -v api_password="$FINCORE_API_PASSWORD" \
  -v workers_password="$FINCORE_WORKERS_PASSWORD" \
  -v analytics_password="$FINCORE_ANALYTICS_PASSWORD" \
  -f /fincore/bootstrap/roles.sql
