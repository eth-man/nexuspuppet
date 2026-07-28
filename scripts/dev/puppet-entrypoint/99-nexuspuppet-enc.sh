#!/bin/bash
#
# Point puppetserver at NexusPuppet's ENC (ADR-0003).
#
# Runs from /docker-entrypoint.d on every start, because the image regenerates
# puppet.conf from a template each time — a `puppet config set` done by hand
# survives exactly until the next restart.
#
# The classifier is a shell script reading files from a read-only mount. There
# is no network call to NexusPuppet, and nothing here can make Puppet depend on
# it at runtime: if the mount is empty the script exits non-zero and puppetserver
# falls back to its own node definitions, loudly.
set -e

puppet config set --section master node_terminus exec
puppet config set --section master external_nodes /usr/local/bin/nexuspuppet-enc.sh

echo "[nexuspuppet] ENC configured: $(puppet config print external_nodes --section master)"
