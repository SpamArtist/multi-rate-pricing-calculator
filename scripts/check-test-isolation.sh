#!/usr/bin/env bash
set -euo pipefail

if git grep -n -E 'prototype/|print-reference|npm run prototype' -- tests; then
  printf 'Tests must not depend on prototype files or the prototype server.\n' >&2
  exit 1
fi
