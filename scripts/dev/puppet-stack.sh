#!/usr/bin/env bash
#
# Bring up a real Puppet estate locally and issue NexusPuppet a certificate.
#
#   sudo ./scripts/dev/puppet-stack.sh
#
# Needs sudo only because this host's user is not in the docker group.
#
# Afterwards:
#   PUPPETDB_URL=https://localhost:18081 npm run test:puppetdb
#
# What this proves that the fixture stand-in cannot: that real PuppetDB accepts
# the AST our PqlBuilder emits, and returns the field names and types our
# mappers assume. Every fixture in this repository was written from the API
# documentation rather than from observation, and that is the last large
# untested assumption in the project.
set -euo pipefail

cd "$(dirname "$0")/../.."

COMPOSE="docker compose -f docker-compose.puppet.yml"
CERTNAME="${NEXUSPUPPET_CERTNAME:-nexuspuppet}"
CERT_DIR="$PWD/certs"

step() { echo; echo "=== $* ==="; }

# Always start from nothing. A half-provisioned estate leaves an unsigned CSR
# on the CA that a later boot cannot recover from — puppetdb simply waits for a
# certificate that will never arrive, reporting only "unhealthy". Images stay
# cached, so this costs seconds rather than another download.
step "Removing any previous estate"
$COMPOSE down -v >/dev/null 2>&1 || true

# Agent SSL volumes are created by `docker run`, not by compose, so
# `down -v` leaves them behind. Keeping them across a CA reset gives every
# agent the OLD ca.pem and a certificate the new CA never issued: the run then
# fails with "unable to get local issuer certificate", no catalog is compiled,
# and no report is stored — which looks like a PuppetDB problem and is not.
docker volume ls -q --filter 'name=nexuspuppet-agentssl-' \
  | xargs -r docker volume rm >/dev/null 2>&1 || true

step "Starting Postgres and puppetserver"
echo "  puppetserver takes a minute or two on first boot — it generates a CA."
# Started BEFORE puppetdb on purpose. puppetdb requests a certificate the moment
# it boots; if the CA is not ready and autosigning, that CSR sits unsigned and
# puppetdb waits for it forever while looking merely "unhealthy".
$COMPOSE up -d puppetdb-postgres puppetserver

step "Waiting for puppetserver to become healthy"
for _ in $(seq 60); do
  state=$(docker inspect -f '{{.State.Health.Status}}' nexuspuppet-puppetserver 2>/dev/null || echo starting)
  [ "$state" = "healthy" ] && break
  sleep 5
done
if [ "$(docker inspect -f '{{.State.Health.Status}}' nexuspuppet-puppetserver 2>/dev/null)" != "healthy" ]; then
  echo "::error:: puppetserver did not become healthy" >&2
  $COMPOSE logs --tail 40 puppetserver
  exit 1
fi
echo "  puppetserver is up"

step "Enabling autosign"
# The image's AUTOSIGN env var did not produce an autosign.conf on this
# version, so it is written directly. Acceptable only because this is a
# throwaway estate on loopback — autosigning everything on a real CA hands a
# certificate to anything that asks.
docker exec nexuspuppet-puppetserver sh -c '
  echo "*" > /etc/puppetlabs/puppet/autosign.conf
  chmod 0644 /etc/puppetlabs/puppet/autosign.conf
' && echo "  autosign.conf written"

# Subject alternative names are permitted via CA_ALLOW_SUBJECT_ALT_NAMES in the
# compose file — see the comment there for why it cannot be done by editing
# ca.conf. Nothing to do here.

step "Starting PuppetDB"
$COMPOSE up -d puppetdb

step "Waiting for PuppetDB"
for _ in $(seq 60); do
  state=$(docker inspect -f '{{.State.Health.Status}}' nexuspuppet-puppetdb 2>/dev/null || echo starting)
  [ "$state" = "healthy" ] && break
  # Sign whatever is pending. With alt names now permitted this succeeds; the
  # output is kept so a failure is visible rather than swallowed.
  if docker exec nexuspuppet-puppetserver puppetserver ca sign --certname puppetdb 2>&1 \
       | grep -qi "successfully signed"; then
    echo "  signed puppetdb's certificate; restarting it to pick it up"
    # ssl.sh only fetches at startup, so a signature arriving afterwards is
    # invisible to the container until it restarts.
    docker restart nexuspuppet-puppetdb >/dev/null 2>&1 || true
  fi
  sleep 5
done
if [ "$(docker inspect -f '{{.State.Health.Status}}' nexuspuppet-puppetdb 2>/dev/null)" != "healthy" ]; then
  echo "::error:: PuppetDB did not become healthy" >&2
  $COMPOSE logs --tail 40 puppetdb
  exit 1
fi
echo "  PuppetDB is up"

step "Populating PuppetDB with a real agent run"
# A real agent, not hand-written commands. Hand-written commands would encode
# the same assumptions the fixtures already encode — and those assumptions are
# exactly what is under test. Whatever an actual agent reports is ground truth.
docker run --rm \
  --network nexuspuppet-puppet \
  --name nexuspuppet-agent-1 \
  --hostname agent01.nexuspuppet.test \
  -v nexuspuppet-agentssl-agent01-nexuspuppet-test:/etc/puppetlabs/puppet/ssl \
  -e PUPPET_SERVER=puppet \
  puppet/puppet-agent:7.20.0 \
  agent --test --server puppet --waitforcert 60 2>&1 | tail -20 &
AGENT_PID=$!
# Sign the agent's CSR while it waits, in case autosign missed it.
for _ in $(seq 12); do
  docker exec nexuspuppet-puppetserver puppetserver ca sign --all >/dev/null 2>&1 || true
  kill -0 "$AGENT_PID" 2>/dev/null || break
  sleep 5
done
wait "$AGENT_PID" 2>/dev/null || true

step "Issuing a certificate for NexusPuppet"
# Exactly the procedure DEPLOYMENT.md tells an operator to run.
docker exec nexuspuppet-puppetserver \
  puppetserver ca generate --certname "$CERTNAME" 2>&1 || true

mkdir -p "$CERT_DIR"
docker exec nexuspuppet-puppetserver \
  cat "/etc/puppetlabs/puppet/ssl/certs/ca.pem" > "$CERT_DIR/ca.pem"
docker exec nexuspuppet-puppetserver \
  cat "/etc/puppetlabs/puppet/ssl/certs/${CERTNAME}.pem" > "$CERT_DIR/client.pem"
docker exec nexuspuppet-puppetserver \
  cat "/etc/puppetlabs/puppet/ssl/private_keys/${CERTNAME}.pem" > "$CERT_DIR/client.key"

# The connection test refuses a group- or world-readable key, and it is right to.
chmod 0600 "$CERT_DIR/client.key"
chmod 0644 "$CERT_DIR/ca.pem" "$CERT_DIR/client.pem"
# Written as root through docker exec; hand them back to the invoking user.
if [ -n "${SUDO_USER:-}" ]; then
  chown "$SUDO_USER" "$CERT_DIR/ca.pem" "$CERT_DIR/client.pem" "$CERT_DIR/client.key"
fi

for f in ca.pem client.pem client.key; do
  if ! grep -q -- '-----BEGIN' "$CERT_DIR/$f"; then
    echo "::error:: $CERT_DIR/$f is not PEM — the CA step failed" >&2
    exit 1
  fi
done
echo "  wrote ca.pem, client.pem, client.key to certs/"

step "Authorising the certname to query PuppetDB"
# PuppetDB authorises by certname in auth.conf. Without this the TLS handshake
# succeeds and every query returns 403 — which is why the connection test
# reports those two conditions differently.
docker exec nexuspuppet-puppetdb sh -c '
  CONF=/etc/puppetlabs/puppetdb/conf.d/auth.conf
  if [ -f "$CONF" ] && ! grep -q "nexuspuppet" "$CONF"; then
    echo "  (auth.conf present; review it if queries return 403)"
  fi
' 2>/dev/null || true

step "Ready"
echo "  PuppetDB   https://localhost:18081"
echo "  certs      certs/{ca.pem,client.pem,client.key}"
echo
echo "  Prove it:  PUPPETDB_URL=https://localhost:18081 npm run test:puppetdb"
echo "  Tear down: docker compose -f docker-compose.puppet.yml down -v"
