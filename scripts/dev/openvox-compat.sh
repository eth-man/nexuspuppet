#!/usr/bin/env bash
#
# Does NexusPuppet work against OpenVox?
#
#   ./scripts/dev/openvox-compat.sh
#
# No sudo: this only reads certificates and makes GET requests.
#
# Runs the EXISTING six-stage connection test — the one written for PuppetDB,
# unmodified, including the real PuppetDbClient in stage 6 — against openvoxdb.
# Reusing it rather than writing an OpenVox-specific check is the entire point:
# a bespoke test would be written to the fork's behaviour and would pass by
# construction. This passes only if the fork behaves like what we already
# support.
#
# Then it asks the questions the connection test does not, because they are
# specific to the fork rather than to a connection: what does openvoxdb call
# itself, does it speak our AST dialect, and are the fields our mappers read
# still present and still named the same.
set -euo pipefail

cd "$(dirname "$0")/../.."

CERT_DIR="certs-openvox"
export PUPPETDB_URL="${PUPPETDB_URL:-https://localhost:18082}"
export PUPPETDB_CERT_PATH="$CERT_DIR/client.pem"
export PUPPETDB_KEY_PATH="$CERT_DIR/client.key"
export PUPPETDB_CA_PATH="$CERT_DIR/ca.pem"

if [ ! -f "$CERT_DIR/client.pem" ]; then
  echo "::error:: no certificates in $CERT_DIR. Run: sudo ./scripts/dev/openvox-stack.sh" >&2
  exit 1
fi

echo "======================================================================="
echo "Stage A — the standard connection test, unmodified, against openvoxdb"
echo "======================================================================="
echo "  ${PUPPETDB_URL}"
node scripts/test-puppetdb.mjs

echo
echo "======================================================================="
echo "Stage B — fork-specific questions"
echo "======================================================================="
node scripts/dev/openvox-probe.mjs
