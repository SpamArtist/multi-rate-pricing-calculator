#!/bin/sh
set -eu

if docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  npm run db:up
elif command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
  sh scripts/postgres-podman.sh
elif command -v initdb >/dev/null 2>&1 && command -v pg_ctl >/dev/null 2>&1; then
  sh scripts/postgres-local.sh
else
  printf '%s\n' 'Start Docker Compose or install PostgreSQL server tools (initdb, pg_ctl), then retry.' >&2
  exit 1
fi
npm run db:migrate
npm run check
