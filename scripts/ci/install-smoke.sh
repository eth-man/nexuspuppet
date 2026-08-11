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
ADMIN_PASSWORD=""   # deploy.sh generates it; read from .env below
SMOKE_WEB_PORT="${SMOKE_WEB_PORT:-33000}"
SMOKE_API_PORT="${SMOKE_API_PORT:-33001}"
# EXPORTED, and before deploy.sh runs. Compose resolves shell environment ahead
# of .env, so this is what its `up -d` binds — setting it in .env afterwards
# would arrive one step too late, having already collided with whatever a
# developer has on 3000. Same reason this job uses its own Compose project.
export WEB_PORT="$SMOKE_WEB_PORT"
export API_PORT="$SMOKE_API_PORT"

cleanup() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f .env
  rm -f certs/client.pem certs/client.key certs/ca.pem
  rmdir certs 2>/dev/null || true
  [ -f .env.install-smoke-backup ] && mv .env.install-smoke-backup .env
  return 0
}
trap cleanup EXIT

# --- §4. Configure .env -------------------------------------------------------

step "Deploying the way an operator does"

# THE SCRIPT ITSELF IS UNDER TEST. This job used to re-implement the install
# sequence; two copies of one procedure drift, and the copy nobody runs is the
# one that rots. scripts/deploy.sh is what DEPLOYMENT.md tells an operator to
# run, so it is what CI runs.
#
# Throwaway certificate files: deploy.sh refuses to start without them, because
# a missing client certificate is the most common first-install failure and its
# symptom is an empty estate rather than an error. Nothing here connects to a
# real PuppetDB — the URL below is deliberately unresolvable — so the contents
# do not matter, only that the check is exercised rather than bypassed.
mkdir -p certs
for f in client.pem client.key ca.pem; do
  [ -f "certs/$f" ] || echo "install-smoke placeholder" > "certs/$f"
done

# THE GUARD IS UNDER TEST FIRST. This environment is deliberately wrong —
# placeholder certificates, an unresolvable PuppetDB — so --check MUST refuse
# it. A preflight that passes here would be a preflight that passes anything.
step "Preflight refuses a deliberately broken environment"
if ./scripts/deploy.sh --puppetdb https://puppetdb.invalid:8081 --check >/dev/null 2>&1; then
  fail "--check PASSED an environment with placeholder certs and no PuppetDB"
fi
echo "  ok — it refused, as it must"

# Then the mechanics, which is what the rest of this job is about: does the
# image build, does the migration run, does the admin exist, does it serve.
./scripts/deploy.sh --puppetdb https://puppetdb.invalid:8081 --skip-preflight \
  || fail "scripts/deploy.sh — the documented one-command install"


# The projected-fact marker proves .env values reach the container. deploy.sh
# does not set it (no operator would), so it is appended here and the stack
# restarted to pick it up.
step "Adding the marker this job asserts on"
printf 'PUPPETDB_PROJECTED_FACTS=%s\n' "os,networking,kernel,install_smoke_marker" >> .env
docker compose up -d api || fail "restart after editing .env"

step "The commissioning probe is present in the image"
docker compose run --rm --no-deps --entrypoint sh api -c 'test -f scripts/test-puppetdb.mjs' \
  || fail "scripts/test-puppetdb.mjs is missing from the runtime image"

step "The API becomes healthy"
healthy=""
for _ in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:${SMOKE_API_PORT}/healthz" >/dev/null 2>&1; then
    healthy=yes
    break
  fi
  sleep 2
done
[ -n "$healthy" ] || fail "/healthz never became reachable"
echo "  ok"

step "Every container reports healthy"
# Not the same question as "does the port answer".
#
# A healthcheck that can never pass leaves a container permanently unhealthy
# while the service works perfectly through its published port — so curling the
# host proves nothing about it. That shipped: the web tier's healthcheck checked
# localhost, and Next.js standalone binds to the container hostname instead, so
# it failed forever and this script did not notice.
#
# It matters because `depends_on: condition: service_healthy` turns a broken
# healthcheck into a service that never starts at all.
for svc in db api web; do
  cid=$(docker compose ps -q "$svc")
  [ -n "$cid" ] || fail "$svc has no container"

  state=""
  for _ in $(seq 1 45); do
    state=$(docker inspect --format \
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo unknown)
    case "$state" in
      healthy | none) break ;;
      starting) sleep 2 ;;
      *) sleep 2 ;;
    esac
  done

  case "$state" in
    healthy) echo "  $svc: healthy" ;;
    # A service with no healthcheck defined is not a failure — it is a gap, and
    # naming it here is how the gap stays visible.
    none) echo "  $svc: no healthcheck defined" ;;
    *) fail "$svc is '$state' — its healthcheck never passed" ;;
  esac
done

step "Ports are bound to loopback, not every interface"
# The default must stay safe: no TLS terminates in front of these services, so a
# 0.0.0.0 bind puts login credentials on the wire in cleartext.
if docker compose ps --format json api | grep -q "0\\.0\\.0\\.0:${SMOKE_API_PORT}"; then
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
ADMIN_EMAIL=$(grep -E '^BOOTSTRAP_ADMIN_EMAIL=' .env | cut -d= -f2-)
ADMIN_PASSWORD=$(grep -E '^BOOTSTRAP_ADMIN_PASSWORD=' .env | cut -d= -f2-)
# The end an operator cares about. A deployment that starts, reports healthy and
# cannot be logged into is indistinguishable from a working one until someone
# tries — which is exactly how the missing BOOTSTRAP_ADMIN_* pair shipped.
code=$(curl -s -o /tmp/login.json -w '%{http_code}' \
  -X POST "http://127.0.0.1:${SMOKE_API_PORT}/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}")

if [ "$code" != "200" ] && [ "$code" != "201" ]; then
  echo "  HTTP $code"
  cat /tmp/login.json 2>/dev/null || true
  fail "the bootstrap admin could not log in — a fresh install is unusable"
fi
echo "  ok"

step "The web tier is serving"
curl -fsS -o /dev/null "http://127.0.0.1:${SMOKE_WEB_PORT}/" || fail "the web tier did not serve"
echo "  ok"

echo
echo "Install smoke passed: built, migrated, started, configured and logged in."
