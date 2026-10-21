#!/usr/bin/env bash
set -euo pipefail
# PostgreSQL entrypoint sources non-executable .sh files. Never enable shell tracing.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --set maintenance_password="$MAINTENANCE_DB_PASSWORD" \
  --set api_password="$API_DB_PASSWORD" --set worker_password="$WORKER_DB_PASSWORD" <<'SQL'
CREATE ROLE amrutam_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'api_password';
CREATE ROLE amrutam_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'worker_password';
CREATE ROLE amrutam_maintenance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'maintenance_password';
SQL
