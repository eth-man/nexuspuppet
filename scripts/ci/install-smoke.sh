#!/usr/bin/env bash
#
# Install NexusPuppet exactly the way DEPLOYMENT.md tells an operator to, and
# fail if any step of it does not work.
#
#   ./scripts/ci/install-smoke.sh
#
# WHY THIS EXISTS. Every other job in CI runs the source tree. None of them had
# ever built the Docker image or started the product from docker-compose.yml, so
# the entire installation path — the one thing every new user touches before
# anything else — was unverified. Four blocking defects reached main that way:
#
#   - the runtime image shipped without prisma.config.ts, so the documented
#     migration step could not succeed at all
#   - the api service enumerated nine environment keys and discarded twenty,
#     including the pair that seeds the first admin, so nobody could log in
#   - certificate ownership made the mounted key unreadable to the container uid
#   - a COPY read from a build stage that never contained the file, so the image
#     did not build
#
# Every one of them would have failed this script in under two minutes. Unit
# tests cannot find them, because none of them is in the source tree.
#
# The steps below are deliberately the literal commands from DEPLOYMENT.md §4-§5
# rather than a tidier equivalent. If the documentation and this script drift
# apart, this script is testing something nobody is being told to do.
set -euo pipefail

cd "$(dirname "$0")/../.."

# Its own Compose project, so `down -v --remove-orphans` below can never reach
# containers or volumes belonging to a developer's running stack. Without this,
# running the script on a workstation deletes the dev database.
export COMPOSE_PROJECT_NAME=nexuspuppet-install-smoke

# This script MUST write .env, because the defect class it exists to catch is
# "a documented key never reaches the container" — which only a real .env going
# through Compose can prove. On CI that file does not exist; on a workstation it
# does and it is the developer's, so it is put back on the way out.
if [ -f .env ] && [ ! -f .env.install-smoke-backup ]; then
  mv .env .env.install-smoke-backup
fi

step() { echo; echo "=== $* ==="; }
fail() {
  echo
  echo "INSTALL SMOKE FAILED: $*"
  echo
  echo "--- api logs ---"
  docker compose logs --tail 60 api 2>&1 || true
  exit 1
}

ADMIN_EMAIL="admin@example.com"
ADMIN_PASSWORD="install-smoke-only-password"

cleanup() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f .env
  [ -f .env.install-smoke-backup ] && mv .env.install-smoke-backup .env
  return 0
}
trap cleanup EXIT

# --- §4. Configure .env -------------------------------------------------------

step "Configuring .env (DEPLOYMENT.md §4)"

# From .env.example, as the documentation says, rather than a bespoke file. That
# way a key documented there but not delivered by Compose is caught here.
cp .env.example .env
set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .env; then
    # `|` as the delimiter: values contain / and : (URLs, connection strings).
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

set_env NODE_ENV production
set_env POSTGRES_PASSWORD install-smoke-only-password
set_env JWT_SECRET install-smoke-only-jwt-secret-not-used-anywhere-else
set_env BOOTSTRAP_ADMIN_EMAIL "$ADMIN_EMAIL"
set_env BOOTSTRAP_ADMIN_PASSWORD "$ADMIN_PASSWORD"
# Deliberately unreachable. The API must still boot and report healthy: the
# classification half of this product does not depend on PuppetDB, and a
# certificate problem is documented as degrading inventory rather than taking
# the console down. If that stops being true, this line catches it.
set_env PUPPETDB_URL https://puppetdb.invalid:8081

# A key with a non-default value that nothing else in CI exercises. If Compose
# goes back to enumerating environment, this is what notices.
set_env PUPPETDB_PROJECTED_FACTS os,networking,kernel,install_smoke_marker

# --- §5. Build, migrate, start ------------------------------------------------

step "Building the images (DEPLOYMENT.md §5)"
docker compose build || fail "docker compose build"

step "The commissioning probe is present in the image"
# --no-deps matters. Without it this pulls up the database through depends_on
# and blocks on a first-boot Postgres initialising, to answer a question about
# a file in the image. Inspecting the image should not start the estate.
docker compose run --rm --no-deps --entrypoint sh api -c 'test -f scripts/test-puppetdb.mjs' \
  || fail "scripts/test-puppetdb.mjs is missing from the runtime image"

step "Migrating (DEPLOYMENT.md §5)"
docker compose up -d db || fail "docker compose up -d db"
# First boot initialises the cluster, which is slower than the healthcheck's
# own interval allows for; wait on readiness rather than assuming it.
ready=""
for _ in $(seq 1 45); do
  if docker compose exec -T db pg_isready -U nexuspuppet >/dev/null 2>&1; then
    ready=yes
    break
  fi
  sleep 2
done
[ -n "$ready" ] || fail "the database never became ready" 
docker compose run --rm api npx prisma migrate deploy \
  || fail "prisma migrate deploy — the image is missing something the CLI needs"

step "Starting the stack (DEPLOYMENT.md §5)"
docker compose up -d || fail "docker compose up -d"

# --- The assertions that matter -----------------------------------------------

step "The API becomes healthy"
healthy=""
for _ in $(seq 1 45); do
  if curl -fsS http://127.0.0.1:3001/healthz >/dev/null 2>&1; then
    healthy=yes
    break
  fi
  sleep 2
done
[ -n "$healthy" ] || fail "/healthz never became reachable"
echo "  ok"

step "Ports are bound to loopback, not every interface"
# The default must stay safe: no TLS terminates in front of these services, so a
# 0.0.0.0 bind puts login credentials on the wire in cleartext.
if docker compose ps --format json api | grep -q '0\.0\.0\.0:3001'; then
  fail "the api port is published on 0.0.0.0 — it must default to 127.0.0.1"
fi
echo "  ok"

step "The environment reached the container"
# The specific regression: Compose enumerated nine keys and silently dropped the
# rest, so a documented setting had no effect in the deployment that ships.
for key in BOOTSTRAP_ADMIN_EMAIL PUPPETDB_PROJECTED_FACTS LOGIN_MAX_FAILED_ATTEMPTS; do
  docker compose exec -T api sh -c "test -n \"\$$key\"" \
    || fail "$key is set in .env but never reached the container"
  echo "  $key present"
done
docker compose exec -T api sh -c 'echo "$PUPPETDB_PROJECTED_FACTS"' \
  | grep -q install_smoke_marker \
  || fail "PUPPETDB_PROJECTED_FACTS reached the container with the wrong value"
echo "  values are the ones from .env"

step "The bootstrap admin can actually log in"
# The end an operator cares about. A deployment that starts, reports healthy and
# cannot be logged into is indistinguishable from a working one until someone
# tries — which is exactly how the missing BOOTSTRAP_ADMIN_* pair shipped.
code=$(curl -s -o /tmp/login.json -w '%{http_code}' \
  -X POST http://127.0.0.1:3001/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}")

if [ "$code" != "200" ] && [ "$code" != "201" ]; then
  echo "  HTTP $code"
  cat /tmp/login.json 2>/dev/null || true
  fail "the bootstrap admin could not log in — a fresh install is unusable"
fi
echo "  ok"

step "The web tier is serving"
curl -fsS -o /dev/null http://127.0.0.1:3000/ || fail "the web tier did not serve"
echo "  ok"

echo
echo "Install smoke passed: built, migrated, started, configured and logged in."
