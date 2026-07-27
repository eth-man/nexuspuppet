#!/bin/sh
# NexusPuppet ENC — the puppetserver side of ADR-0003.
#
# Install on the puppetserver host and configure:
#
#   # /etc/puppetlabs/puppet/puppet.conf
#   [master]
#   node_terminus  = exec
#   external_nodes = /usr/local/bin/nexuspuppet-enc.sh
#
# Deliberately dependency-free: POSIX sh, no network, no interpreter beyond
# /bin/sh, and no NexusPuppet process involved. NexusPuppet can be stopped,
# broken, or removed entirely and catalog compilation continues against the
# last materialized state on disk. That property is the entire reason this
# architecture exists — do not "improve" this script by making it call an API.
#
# Mount ${ENC_DIR} READ-ONLY here. Only the api container may write it.

set -eu

ENC_DIR="${NEXUSPUPPET_ENC_DIR:-/etc/puppetlabs/nexuspuppet}"

certname="${1:-}"
if [ -z "$certname" ]; then
    echo "usage: $0 <certname>" >&2
    exit 1
fi

# Reject path traversal: certname arrives from the agent's certificate, but this
# script builds a filesystem path from it, so it is treated as untrusted input.
case "$certname" in
    */* | *..* | '')
        echo "nexuspuppet-enc: refusing suspicious certname" >&2
        exit 1
        ;;
esac

node_file="${ENC_DIR}/nodes/${certname}.yaml"
default_file="${ENC_DIR}/default.yaml"

if [ -f "$node_file" ]; then
    exec cat "$node_file"
fi

# An unknown or not-yet-materialized node gets a defined, safe classification
# rather than a compilation failure. default.yaml is written at bootstrap and
# is guaranteed to exist.
if [ -f "$default_file" ]; then
    exec cat "$default_file"
fi

# Both missing means the volume is unmounted or empty. Exiting non-zero makes
# puppetserver fall back to its own node definitions and log loudly, which is
# the correct failure: better a visible error than silently classifying every
# node in the estate as empty.
echo "nexuspuppet-enc: no classification data at ${ENC_DIR} (volume unmounted?)" >&2
exit 1
