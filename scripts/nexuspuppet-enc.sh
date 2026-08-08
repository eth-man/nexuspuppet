#!/bin/sh
# NexusPuppet ENC — the puppetserver side of ADR-0003.
#
# Install on the puppetserver host and configure:
#
#   # /etc/puppetlabs/puppet/puppet.conf
#   [server]          # [master] on Puppet 7 and earlier
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

# One line per compile, recording which tree revision this node was served
# (ADR-0022). Written by the puppetserver user; the directory is created and
# group-owned by `nexuspuppet-sync.sh`, which also carries the lines away.
RECEIPTS="${NEXUSPUPPET_RECEIPTS:-/var/lib/nexuspuppet-sync/receipts/current}"

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

# Resolve ENC_DIR to the concrete tree ONCE, and read everything from that.
#
# ENC_DIR is a symlink that `nexuspuppet-sync.sh` swaps with a single rename(2).
# Reading the revision through the symlink and then the node file through it
# again straddles that swap: the two opens can land in different trees, and the
# receipt would then name a revision this node was never served. Resolving once
# pins both reads to the same immutable directory.
#
# `cd -P` and `$PWD` are shell builtins, so this costs no fork. The installed
# tree is never the one pruned by the sync script, so a resolved path cannot be
# deleted out from under a compile that is already running.
#
# If it cannot be resolved — not a symlink, or absent — fall back to the
# configured path so the existing diagnostics below still fire.
tree="$ENC_DIR"
if cd -P "$ENC_DIR" 2>/dev/null; then
    tree="$PWD"
fi

node_file="${tree}/nodes/${certname}.yaml"
default_file="${tree}/default.yaml"

# Append the compile receipt. NEVER fails the compile (ADR-0022 §1).
#
# Every failure path is swallowed: no `.revision` (a tree installed before
# receipts existed), an unwritable or absent receipts directory, a full disk. A
# catalog must not fail because bookkeeping did, and the asymmetry is not close
# — losing a receipt costs visibility, losing a catalog costs convergence.
#
# `read` and `printf` are builtins, so this adds no process to a path whose
# entire cost today is one `cat`. That is also why the line carries no
# timestamp: `date` would be a fork per compile, the revision is what identifies
# the classification, and NexusPuppet stamps arrival time when it receives it.
#
# One short line written with O_APPEND is atomic, so concurrent compiles
# interleave whole lines rather than corrupting each other's.
record_receipt() {
    revision=''
    { read -r revision <"${tree}/.revision"; } 2>/dev/null || revision=''
    [ -n "$revision" ] || return 0

    { printf '%s %s\n' "$revision" "$certname" >>"$RECEIPTS"; } 2>/dev/null || true
    return 0
}

if [ -f "$node_file" ]; then
    # Recorded before serving, because `exec` does not come back. It therefore
    # means "decided to serve this revision" — between the check above and the
    # cat, only the tree being deleted outright could make that untrue.
    record_receipt
    exec cat "$node_file"
fi

# An unknown or not-yet-materialized node gets a defined, safe classification
# rather than a compilation failure. default.yaml is written at bootstrap and
# is guaranteed to exist.
if [ -f "$default_file" ]; then
    # A node served the default still compiled from THIS revision, and that is
    # the answer somebody wants when a rule was supposed to match it and did not.
    record_receipt
    exec cat "$default_file"
fi

# Both missing means the volume is unmounted or empty.
#
# Exiting non-zero FAILS CATALOG COMPILATION for this node. The `exec` node
# terminus has no fallback — a non-zero exit is an error, not a signal to use
# site.pp's node definitions. This comment used to claim otherwise, which made a
# hard failure sound survivable.
#
# Failing is still the right behaviour, for the reason the wrong version gave:
# an agent that cannot be classified must stop, not silently receive an empty
# catalog and start removing resources across the estate. But it is a real
# outage for the affected nodes, so treat it as one.
echo "nexuspuppet-enc: no classification data at ${ENC_DIR} (volume unmounted?)" >&2
exit 1
