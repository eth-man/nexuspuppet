#!/usr/bin/env bash
#
# Bring up an OpenVox estate locally and issue NexusPuppet a certificate for it.
#
#   sudo ./scripts/dev/openvox-stack.sh
#
# Needs sudo only because this host's user is not in the docker group.
#
# Afterwards, the question this exists to answer:
#
#   PUPPETDB_URL=https://localhost:18082 \
#   PUPPETDB_CERT_PATH=certs-openvox/client.pem \
#   PUPPETDB_KEY_PATH=certs-openvox/client.key \
#   PUPPETDB_CA_PATH=certs-openvox/ca.pem \
#   npm run test:puppetdb
#
# That runs the SAME six-stage check as the Puppet estate, including the real
# PuppetDbClient in stage 6. OpenVox is advertised as a drop-in fork; this is
# what turns that into a result. Structured identically to puppet-stack.sh so
# the two runs are comparable — a difference in the output is a difference in
# the product, not in how it was tested.
set -euo pipefail

cd "$(dirname "$0")/../.."

COMPOSE="docker compose -f docker-compose.openvox.yml"
CERTNAME="${NEXUSPUPPET_CERTNAME:-nexuspuppet}"
CERT_DIR="$PWD/certs-openvox"

step() { echo; echo "=== $* ==="; }

# Always start from nothing. A half-provisioned estate leaves an unsigned CSR on
# the CA that a later boot cannot recover from — openvoxdb waits for a
# certificate that never arrives, reporting only "unhealthy". Images stay cached.
step "Removing any previous OpenVox estate"
$COMPOSE down -v >/dev/null 2>&1 || true

# Agent SSL volumes are created by `docker run`, not compose, so `down -v`
# leaves them. Keeping them across a CA reset gives the agent the OLD ca.pem and
# a certificate the new CA never issued: the run fails with "unable to get local
# issuer certificate", no catalog compiles, no report is stored — which looks
# like an openvoxdb problem and is not.
docker volume ls -q --filter 'name=nexuspuppet-openvoxagentssl-' \
  | xargs -r docker volume rm >/dev/null 2>&1 || true

step "Starting PostgreSQL and openvoxserver"
echo "  first boot pulls images and generates a CA — a few minutes."
# Started BEFORE openvoxdb on purpose: openvoxdb requests a certificate the
# moment it boots, and if the CA is not yet autosigning that CSR sits unsigned
# while the container merely looks unhealthy.
$COMPOSE up -d openvoxdb-postgres openvoxserver

step "Waiting for openvoxserver"
for _ in $(seq 60); do
  state=$(docker inspect -f '{{.State.Health.Status}}' nexuspuppet-openvoxserver 2>/dev/null || echo starting)
  [ "$state" = "healthy" ] && break
  sleep 5
done
if [ "$(docker inspect -f '{{.State.Health.Status}}' nexuspuppet-openvoxserver 2>/dev/null)" != "healthy" ]; then
  echo "::error:: openvoxserver did not become healthy" >&2
  $COMPOSE logs --tail 60 openvoxserver
  exit 1
fi
echo "  openvoxserver is up"

step "Enabling autosign"
# Written directly rather than trusting AUTOSIGN=true, which did not produce an
# autosign.conf on the Puppet image. Acceptable ONLY because this is a throwaway
# estate on loopback: autosigning everything on a real CA hands a certificate to
# anything that asks.
docker exec nexuspuppet-openvoxserver sh -c '
  echo "*" > /etc/puppetlabs/puppet/autosign.conf
  chmod 0644 /etc/puppetlabs/puppet/autosign.conf
' && echo "  autosign.conf written"

step "Starting openvoxdb"
$COMPOSE up -d openvoxdb

step "Waiting for openvoxdb"
for _ in $(seq 60); do
  state=$(docker inspect -f '{{.State.Health.Status}}' nexuspuppet-openvoxdb 2>/dev/null || echo starting)
  [ "$state" = "healthy" ] && break
  # Sign whatever is pending. Kept visible rather than swallowed so a signing
  # failure is distinguishable from a slow boot.
  if docker exec nexuspuppet-openvoxserver puppetserver ca sign --certname openvoxdb 2>&1 \
       | grep -qi "successfully signed"; then
    echo "  signed openvoxdb's certificate; restarting it to pick it up"
    # The SSL bootstrap only fetches at startup, so a signature arriving
    # afterwards is invisible until the container restarts.
    docker restart nexuspuppet-openvoxdb >/dev/null 2>&1 || true
  fi
  sleep 5
done
if [ "$(docker inspect -f '{{.State.Health.Status}}' nexuspuppet-openvoxdb 2>/dev/null)" != "healthy" ]; then
  echo "::error:: openvoxdb did not become healthy" >&2
  $COMPOSE logs --tail 60 openvoxdb
  exit 1
fi
echo "  openvoxdb is up"

step "Populating openvoxdb with a real agent run"
# A real openvoxagent, not a hand-written factset. Hand-written facts would
# encode our assumptions, and those assumptions are what is under test.
docker run --rm \
  --network nexuspuppet-openvox \
  --name nexuspuppet-openvoxagent-1 \
  --hostname agent01.openvox.test \
  -v nexuspuppet-openvoxagentssl-agent01:/etc/puppetlabs/puppet/ssl \
  ghcr.io/openvoxproject/openvoxagent:latest \
  agent --test --server puppet --waitforcert 60 2>&1 | tail -25 &
AGENT_PID=$!
for _ in $(seq 12); do
  docker exec nexuspuppet-openvoxserver puppetserver ca sign --all >/dev/null 2>&1 || true
  kill -0 "$AGENT_PID" 2>/dev/null || break
  sleep 5
done
wait "$AGENT_PID" 2>/dev/null || true

step "Issuing a certificate for NexusPuppet"
# Exactly the procedure DEPLOYMENT.md gives an operator — run here against
# OpenVox to find out whether those instructions still hold on the fork.
docker exec nexuspuppet-openvoxserver \
  puppetserver ca generate --certname "$CERTNAME" 2>&1 | tail -5 || true

mkdir -p "$CERT_DIR"
docker exec nexuspuppet-openvoxserver \
  cat "/etc/puppetlabs/puppet/ssl/certs/ca.pem" > "$CERT_DIR/ca.pem"
docker exec nexuspuppet-openvoxserver \
  cat "/etc/puppetlabs/puppet/ssl/certs/${CERTNAME}.pem" > "$CERT_DIR/client.pem"
docker exec nexuspuppet-openvoxserver \
  cat "/etc/puppetlabs/puppet/ssl/private_keys/${CERTNAME}.pem" > "$CERT_DIR/client.key"

# The connection test refuses a group- or world-readable key, and is right to.
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
echo "  wrote ca.pem, client.pem, client.key to certs-openvox/"

step "Ready"
echo "  openvoxdb      https://localhost:18082"
echo "  openvoxserver  https://localhost:8141"
echo "  certs          certs-openvox/{ca.pem,client.pem,client.key}"
echo
echo "  Answer the question:"
echo "    ./scripts/dev/openvox-compat.sh"
echo
echo "  Tear down: docker compose -f docker-compose.openvox.yml down -v"
