#!/bin/sh
set -eu

container_name="multi-rate-pricing-postgres"
roles_file="$(pwd)/db/init/01-roles.sql"

if podman container exists "$container_name"; then
  podman start "$container_name" >/dev/null
else
  podman run -d \
    --name "$container_name" \
    -e POSTGRES_USER=pricing_bootstrap \
    -e POSTGRES_PASSWORD=pricing_bootstrap \
    -e POSTGRES_DB=pricing \
    -p 127.0.0.1:5432:5432 \
    -v pricing-check-data:/var/lib/postgresql \
    -v "$roles_file:/docker-entrypoint-initdb.d/01-roles.sql:ro" \
    docker.io/library/postgres:18-alpine >/dev/null
fi

attempt=0
until podman exec "$container_name" pg_isready -U pricing_bootstrap -d pricing >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    printf '%s\n' 'PostgreSQL container did not become ready.' >&2
    exit 1
  fi
  sleep 1
done
