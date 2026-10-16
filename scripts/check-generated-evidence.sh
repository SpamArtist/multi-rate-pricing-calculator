#!/usr/bin/env bash
set -euo pipefail

found=0
while IFS= read -r -d '' path; do
  case "$path" in
    .artifacts/*|*/.artifacts/*|docs/evidence/*|*/docs/evidence/*|test-results/*|*/test-results/*|playwright-report/*|*/playwright-report/*)
      printf 'Generated evidence is tracked: %s\n' "$path" >&2
      found=1
      ;;
    docs/issue-*-verification.md|*/docs/issue-*-verification.md)
      printf 'Issue verification report is tracked: %s\n' "$path" >&2
      found=1
      ;;
  esac
done < <(git ls-files -z)

if (( found )); then
  printf 'Keep run evidence outside Git; record issue results in the issue or CI run.\n' >&2
  exit 1
fi
