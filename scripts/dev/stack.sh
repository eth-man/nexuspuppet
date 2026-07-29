#!/usr/bin/env bash
#
# Run the whole console locally against synthetic fixtures — no Puppet
# infrastructure required.
#
#   ./scripts/dev/stack.sh
#
# Starts three things:
#   :8081  a PuppetDB stand-in serving /fixtures over real mTLS
#   :3001  the API, projecting from it and materializing ENC files
#   :3000  the web console, in dev mode
#
# Requires Postgres from docker-compose.dev.yml and a .env (copy .env.example).
set -euo pipefail

cd "$(dirname "$0")/../.."

if [ ! -f .env ]; then
  echo "No .env found. Copy .env.example and set JWT_SECRET and DATABASE_URL." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

CERTS="$PWD/scripts/dev/certs"

export PUPPETDB_URL="https://localhost:${DEV_PUPPETDB_PORT:-8081}"
export PUPPETDB_CERT_PATH="$CERTS/client.pem"
export PUPPETDB_KEY_PATH="$CERTS/client.key"
export PUPPETDB_CA_PATH="$CERTS/ca.pem"
export ENC_OUTPUT_DIR="${ENC_OUTPUT_DIR:-$PWD/enc-output}"
export API_INTERNAL_URL="http://127.0.0.1:${API_PORT:-3001}"

# Faster loops than production defaults: this is for watching changes land.
export PUPPETDB_PROJECTION_INTERVAL_MS="${PUPPETDB_PROJECTION_INTERVAL_MS:-30000}"
export ENC_MATERIALIZER_INTERVAL_MS="${ENC_MATERIALIZER_INTERVAL_MS:-2000}"

# Hosts allowed to load Next's dev resources. Reaching the dev server from
# another machine otherwise serves the page but never hydrates it.
export WEB_DEV_ORIGINS="${WEB_DEV_ORIGINS:-}"

cleanup() { jobs -p | xargs -r kill 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Refuse to start on a port something else already holds.
#
# This is not tidiness. `next dev` responds to a busy port by quietly moving to
# the next one, so a leftover web server from an earlier run keeps :3000 and the
# stack comes up looking healthy — while Playwright, whose baseURL is
# 127.0.0.1:3000, drives the OLD build. The tests then fail on assertions about
# code that is not running, which is indistinguishable from a real regression and
# was chased as one.
#
# Found in the wild: a next-server holding :3000 for twenty hours across several
# stack restarts, with no API behind it.
# The process field contains spaces, so take everything after "users:" rather
# than a column.
port_holder() {
  ss -ltnp 2>/dev/null | awk -v p=":$1\$" '$4 ~ p { sub(/.*users:/, ""); print; exit }'
}

for port in "${DEV_PUPPETDB_PORT:-8081}" "${API_PORT:-3001}" "${WEB_PORT:-3000}"; do
  holder=$(port_holder "$port")
  if [ -n "$holder" ]; then
    echo "Port $port is already in use by: $holder" >&2
    echo "" >&2
    echo "Something from a previous run is still listening. Stop it first —" >&2
    echo "leaving it up means this stack starts on a different port and the" >&2
    echo "E2E suite silently tests whatever is on $port instead." >&2
    echo "" >&2
    echo "  pkill -f 'next dev apps/web'      # the usual culprit" >&2
    echo "  pkill -f 'apps/api/dist/main.js'" >&2
    exit 1
  fi
done

echo "=== PuppetDB stand-in on :${DEV_PUPPETDB_PORT:-8081} ==="
node scripts/dev/puppetdb.mjs &
sleep 1

echo "=== API on :${API_PORT:-3001} ==="
node apps/api/dist/main.js 2>&1 | sed 's/^/[api] /' &
sleep 3

echo "=== console on :${WEB_PORT:-3000} ==="
npx --no-install next dev apps/web -H 0.0.0.0 -p "${WEB_PORT:-3000}" 2>&1 | sed 's/^/[web] /'
