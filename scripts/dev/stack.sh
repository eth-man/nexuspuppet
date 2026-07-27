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

echo "=== PuppetDB stand-in on :${DEV_PUPPETDB_PORT:-8081} ==="
node scripts/dev/puppetdb.mjs &
sleep 1

echo "=== API on :${API_PORT:-3001} ==="
node apps/api/dist/main.js 2>&1 | sed 's/^/[api] /' &
sleep 3

echo "=== console on :${WEB_PORT:-3000} ==="
npx --no-install next dev apps/web -H 0.0.0.0 -p "${WEB_PORT:-3000}" 2>&1 | sed 's/^/[web] /'
