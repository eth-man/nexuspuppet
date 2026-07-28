#!/usr/bin/env bash
#
# Run a Puppet agent against the local estate.
#
#   sudo ./scripts/dev/puppet-agent-run.sh [certname]
#
# The agent's SSL directory lives in a NAMED VOLUME, one per certname. Without
# it every run generates a fresh key, and because the CA already holds a signed
# certificate for that certname it hands the old one back — producing
# "certificate does not match its private key" and no report. A real node keeps
# its ssl directory across runs; so does this.
set -euo pipefail

cd "$(dirname "$0")/../.."

CERTNAME="${1:-agent01.nexuspuppet.test}"
VOLUME="nexuspuppet-agentssl-$(echo "$CERTNAME" | tr '.' '-')"

echo "=== agent run: $CERTNAME ==="
docker run --rm \
  --network nexuspuppet-puppet \
  --hostname "$CERTNAME" \
  -v "${VOLUME}:/etc/puppetlabs/puppet/ssl" \
  puppet/puppet-agent:7.20.0 \
  agent --test --server puppet --waitforcert 60 2>&1 | tail -25 || true

echo
echo "Reports reach PuppetDB only if the run completed a catalog. A run that"
echo "fails before applying leaves facts but no report."
