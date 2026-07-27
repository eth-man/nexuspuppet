#!/usr/bin/env bash
#
# Boot the full stack and run the E2E suite against it.
#
#   ./scripts/ci/e2e-stack.sh
#
# Unlike scripts/dev/stack.sh this runs BUILT artifacts (`next start`, not
# `next dev`) so CI exercises what an operator would actually deploy, and it
# takes all configuration from the environment rather than a .env file.
#
# Required in the environment:
#   DATABASE_URL, JWT_SECRET, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD
set -euo pipefail

cd "$(dirname "$0")/../.."

CERTS="$PWD/scripts/dev/certs"
API_PORT="${API_PORT:-3001}"
WEB_PORT="${WEB_PORT:-3000}"
PUPPETDB_PORT="${DEV_PUPPETDB_PORT:-8081}"

export PUPPETDB_URL="https://localhost:${PUPPETDB_PORT}"
export PUPPETDB_CERT_PATH="$CERTS/client.pem"
export PUPPETDB_KEY_PATH="$CERTS/client.key"
export PUPPETDB_CA_PATH="$CERTS/ca.pem"
export ENC_OUTPUT_DIR="${ENC_OUTPUT_DIR:-$PWD/enc-output}"
export API_INTERNAL_URL="http://127.0.0.1:${API_PORT}"
export API_PORT WEB_PORT

# Tight loops: CI should not spend a minute waiting for the first projection.
export PUPPETDB_PROJECTION_INTERVAL_MS="${PUPPETDB_PROJECTION_INTERVAL_MS:-30000}"
export ENC_MATERIALIZER_INTERVAL_MS="${ENC_MATERIALIZER_INTERVAL_MS:-1000}"

mkdir -p "$ENC_OUTPUT_DIR"

LOGS="$PWD/e2e/.logs"
mkdir -p "$LOGS"

cleanup() {
  local status=$?
  # Dump service logs on failure. A red E2E run whose cause is an API that
  # never booted is otherwise indistinguishable from a real test failure.
  if [ "$status" -ne 0 ]; then
    for log in "$LOGS"/*.log; do
      [ -e "$log" ] || continue
      echo "::group::$(basename "$log")"
      tail -n 200 "$log"
      echo "::endgroup::"
    done
  fi
  jobs -p | xargs -r kill 2>/dev/null || true
  return $status
}
trap cleanup EXIT INT TERM

# Wait for a URL to answer, failing loudly rather than letting Playwright
# report a confusing cascade of timeouts.
wait_for() {
  local name="$1" url="$2" attempts="${3:-60}"
  for _ in $(seq "$attempts"); do
    if curl -skf "$url" >/dev/null 2>&1; then
      echo "  $name is up"
      return 0
    fi
    sleep 2
  done
  echo "::error::$name did not become ready at $url" >&2
  return 1
}

# Wait for a TCP port to accept connections. Used where an HTTP probe cannot
# work — the stand-in demands a client certificate, so every unauthenticated
# request is refused at the handshake and looks identical to "not started".
wait_for_port() {
  local name="$1" port="$2"
  for _ in $(seq 60); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      exec 3<&- 3>&-
      echo "  $name is up"
      return 0
    fi
    sleep 1
  done
  echo "::error::$name never listened on :$port" >&2
  return 1
}

echo "=== PuppetDB stand-in on :${PUPPETDB_PORT} ==="
node scripts/dev/puppetdb.mjs >"$LOGS/puppetdb.log" 2>&1 &
wait_for_port "PuppetDB stand-in" "$PUPPETDB_PORT"
# It writes its throwaway CA and client cert on first boot; the API cannot
# connect until they exist on disk.
for _ in $(seq 30); do
  [ -f "$CERTS/client.pem" ] && [ -f "$CERTS/ca.pem" ] && break
  sleep 1
done

echo "=== API on :${API_PORT} ==="
node apps/api/dist/main.js >"$LOGS/api.log" 2>&1 &
wait_for "API" "http://127.0.0.1:${API_PORT}/healthz"

echo "=== console on :${WEB_PORT} ==="
npx --no-install next start apps/web -p "${WEB_PORT}" >"$LOGS/web.log" 2>&1 &
wait_for "console" "http://127.0.0.1:${WEB_PORT}/login"

# The read-only suite asserts that real nodes render. Until the first
# projection completes the estate is empty, and every one of those tests would
# fail for a reason that has nothing to do with the code under test.
#
# There is no unauthenticated projection probe, so this logs in as the
# bootstrap admin and reads the node list the tests themselves will read.
echo "=== waiting for the first projection ==="
JAR="$(mktemp)"
projected=0
for _ in $(seq 60); do
  curl -skf -c "$JAR" -X POST "http://127.0.0.1:${API_PORT}/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"${BOOTSTRAP_ADMIN_EMAIL}\",\"password\":\"${BOOTSTRAP_ADMIN_PASSWORD}\"}" \
    -o /dev/null 2>/dev/null || { sleep 2; continue; }

  count=$(curl -skf -b "$JAR" "http://127.0.0.1:${API_PORT}/nodes" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j.items??j).length??0))}catch{process.stdout.write("0")}})' \
    || echo 0)
  if [ "${count:-0}" -gt 0 ]; then
    echo "  projected $count nodes"
    projected=1
    break
  fi
  sleep 2
done
rm -f "$JAR"

if [ "$projected" -ne 1 ]; then
  echo "::error::the projection never produced a node; the read-only suite cannot pass" >&2
  exit 1
fi

echo "=== E2E ==="
npx --no-install playwright test "$@"
