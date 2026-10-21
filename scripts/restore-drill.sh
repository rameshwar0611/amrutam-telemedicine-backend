#!/usr/bin/env bash
set -euo pipefail
# Only generated test data. No source database deletion and no production target.
source_db=${1:?Pass an isolated source database ending _test}
[[ $source_db =~ ^[a-z0-9_]+_test$ ]] || exit 1
[[ $source_db != *restore* ]] || exit 1
target_db="drill_$(date +%s)_restore_test"
mkdir -p work
umask 077
local_docker=(env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock)
container=$(${local_docker[@]} compose --env-file work/compose.env ps -q postgres)
[[ -n $container ]]
owner=$(${local_docker[@]} exec "$container" sh -c 'printf %s "$POSTGRES_USER"')
${local_docker[@]} exec "$container" pg_dump -U "$owner" -d "$source_db" --format=custom --no-owner --no-acl > work/restore-drill.dump
${local_docker[@]} exec "$container" createdb -U "$owner" "$target_db"
cleanup(){ ${local_docker[@]} exec "$container" dropdb -U "$owner" --force "$target_db"; }
trap cleanup EXIT
${local_docker[@]} exec -i "$container" pg_restore -U "$owner" -d "$target_db" --single-transaction --no-owner --no-acl < work/restore-drill.dump
${local_docker[@]} exec -i "$container" psql -U "$owner" -d "$target_db" -v ON_ERROR_STOP=1 < infra/postgres/restore-runtime-grants.sql
query="SELECT json_build_object('migrations',(SELECT count(*) FROM schema_migrations),'users',(SELECT count(*) FROM users),'consultations',(SELECT count(*) FROM consultations),'prescriptions',(SELECT count(*) FROM prescriptions),'audit',(SELECT count(*) FROM audit_logs),'outbox',(SELECT count(*) FROM outbox_jobs));"
${local_docker[@]} exec "$container" psql -U "$owner" -d "$source_db" -At -c "$query" > work/restore-source.json
${local_docker[@]} exec "$container" psql -U "$owner" -d "$target_db" -At -c "$query" > work/restore-target.json
cmp work/restore-source.json work/restore-target.json
printf '%s\n' 'PASS: isolated pg_dump/restore, row counts and restricted runtime grants. Production PITR, application key recovery and timed regional recovery remain unverified.'
