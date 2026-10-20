#!/bin/sh
set -eu

data_dir="$(pwd)/.local/postgres"
mkdir -p .local

if [ ! -f "$data_dir/PG_VERSION" ]; then
  initdb -D "$data_dir" -U pricing_bootstrap --auth-local=trust --auth-host=trust
fi

if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  pg_ctl -D "$data_dir" -l "$(pwd)/.local/postgres.log" -o '-h 127.0.0.1 -p 5432' start
fi

if ! psql -h 127.0.0.1 -U pricing_bootstrap -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'pricing'" | grep -q 1; then
  createdb -h 127.0.0.1 -U pricing_bootstrap pricing
  psql -h 127.0.0.1 -U pricing_bootstrap -d pricing -f db/init/01-roles.sql
fi
