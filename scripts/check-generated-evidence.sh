#!/usr/bin/env bash
set -euo pipefail

found=0
while IFS= read -r -d '' path; do
  case "$path" in
    .artifacts/*|*/.artifacts/*|docs/evidence/*|*/docs/evidence/*|test-results/*|*/test-results/*|playwright-report/*|*/playwright-report/*)
      printf 'Generated evidence is tracked: %s\n' "$path" >&2
      found=1
      ;;
  esac
done < <(git ls-files -z)

if (( found )); then
  printf 'Move run output to an ignored directory and attach it to the test or CI report.\n' >&2
  exit 1
fi
