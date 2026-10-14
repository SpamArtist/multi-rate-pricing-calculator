#!/bin/sh
set -eu

if [ ! -f .env ]; then
  cp .env.example .env
fi

npm ci --cache "${TMPDIR:-/tmp}/multi-rate-pricing-npm-cache"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-.local/playwright}"
./node_modules/.bin/playwright install chromium --only-shell
npm run check:local
