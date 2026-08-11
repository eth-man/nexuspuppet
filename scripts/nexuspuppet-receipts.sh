#!/bin/sh
# NexusPuppet compile receipts — the collector (ADR-0022 §13).
#
# Drains the receipt file `nexuspuppet-enc.sh` appends to, and hands it to the
# origin. Runs from a systemd timer, does its work, and exits.
#
# WHY THIS IS NOT PART OF THE SYNC SCRIPT. Receipts are not replication. A
# NexusPuppet co-located with puppetserver has no tree to pull and therefore no
# sync script — and until this existed, that meant it had no receipts either.
# Not merely uncollected: the receipts DIRECTORY is what the sync script
# created, so on a co-located host every append failed silently and the compile
# was served correctly (§13). This owns both halves: creating the directory and
# draining it.
#
# THIS IS NOT ON THE COMPILE PATH. `nexuspuppet-enc.sh` appends to a file and
# knows nothing about this script. Delete it, break the network, stop the timer
# — catalogs compile exactly as before. Receipts are droppable by design (§5);
# catalogs are not.
#
# Dependencies: sh and curl. Nothing else, for the same reason the ENC script
# has none.

set -eu

CONFIG="${NEXUSPUPPET_RECEIPTS_CONFIG:-/etc/default/nexuspuppet-receipts}"

# A replicated host already configured the URL and certificates for the sync
# script. Sourcing that first means such a host does not have to restate any of
# it, while its own config still wins.
SYNC_CONFIG="${NEXUSPUPPET_SYNC_CONFIG:-/etc/default/nexuspuppet-sync}"
# shellcheck source=/dev/null
[ -r "$SYNC_CONFIG" ] && . "$SYNC_CONFIG"
# shellcheck source=/dev/null
[ -r "$CONFIG" ] && . "$CONFIG"

STATE_DIR="${NEXUSPUPPET_SYNC_STATE_DIR:-/var/lib/nexuspuppet-sync}"

# The SAME path `nexuspuppet-enc.sh` appends to by default. The name says
# "sync" and this is no longer only about syncing — but the compile path
# defaults to it, and changing a default there would orphan the receipts of
# every deployment that upgraded, to fix a word.
RECEIPTS_DIR="${NEXUSPUPPET_RECEIPTS_DIR:-${NEXUSPUPPET_SYNC_RECEIPTS_DIR:-${STATE_DIR}/receipts}}"

# The group puppetserver runs as. `pe-puppet` on Puppet Enterprise.
RECEIPTS_GROUP="${NEXUSPUPPET_RECEIPTS_GROUP:-${NEXUSPUPPET_SYNC_RECEIPTS_GROUP:-puppet}}"

SSL_DIR="${NEXUSPUPPET_SYNC_SSL_DIR:-/etc/puppetlabs/puppet/ssl}"
CERTNAME="${NEXUSPUPPET_RECEIPTS_CERTNAME:-${NEXUSPUPPET_SYNC_CERTNAME:-$(hostname -f 2>/dev/null || hostname)}}"
CLIENT_CERT="${NEXUSPUPPET_RECEIPTS_CERT:-${NEXUSPUPPET_SYNC_CERT:-${SSL_DIR}/certs/${CERTNAME}.pem}}"
CLIENT_KEY="${NEXUSPUPPET_RECEIPTS_KEY:-${NEXUSPUPPET_SYNC_KEY:-${SSL_DIR}/private_keys/${CERTNAME}.pem}}"
CA_CERT="${NEXUSPUPPET_RECEIPTS_CA:-${NEXUSPUPPET_SYNC_CA:-${SSL_DIR}/certs/ca.pem}}"

TIMEOUT="${NEXUSPUPPET_RECEIPTS_TIMEOUT:-30}"

# Oldest-first cap (§5). Applied here rather than on the compile path, because
# capping there would mean rewriting a file concurrent compiles are appending
# to. 0 disables it.
MAX_RECEIPTS="${NEXUSPUPPET_RECEIPTS_MAX:-${NEXUSPUPPET_SYNC_MAX_RECEIPTS:-20000}}"

# Where to send them. A replicated host derives this from the tree URL exactly
# as the sync script does; a co-located host sets it to its own loopback
# listener (§14).
URL="${NEXUSPUPPET_RECEIPTS_URL:-}"
if [ -z "$URL" ] && [ -n "${NEXUSPUPPET_SYNC_URL:-}" ]; then
    URL="${NEXUSPUPPET_SYNC_URL%/*}/enc-receipts"
fi

log() { echo "nexuspuppet-receipts: $*" >&2; }

[ -n "$URL" ] || {
    log "no receipts URL configured. Set NEXUSPUPPET_RECEIPTS_URL in ${CONFIG} \
(co-located: your own listener, e.g. https://<certname>:8443/enc-receipts)."
    exit 1
}

# The claim this collector stakes on the receipts directory (§15).
#
# The sync script still knows how to hand receipts over, because removing that
# in one release would silently end collection for anyone who upgraded a script
# without installing this unit — and silence is this feature's characteristic
# failure. It defers to whoever wrote this marker recently.
#
# A TIMESTAMP, not a flag: if this collector is removed or its timer is
# disabled, the marker goes stale and the sync script resumes. Deferring
# forever to something that stopped running is the failure this exists to
# prevent, not a state to encode permanently.
MARKER="${RECEIPTS_DIR}/.collector"

# Somewhere the puppetserver user can append and this script can rotate.
#
# 0770 and NOT 2770: the unit sets RestrictSUIDSGID=yes, so a setgid chmod is
# refused with EPERM and the whole feature would disable itself over a mode bit.
# It is not needed — the puppetserver user's primary group IS this group.
ensure_dir() {
    mkdir -p "$RECEIPTS_DIR" 2>/dev/null || {
        log "cannot create ${RECEIPTS_DIR}; compile receipts are disabled"
        return 1
    }

    if ! chgrp "$RECEIPTS_GROUP" "$RECEIPTS_DIR" 2>/dev/null; then
        log "group '${RECEIPTS_GROUP}' does not exist or cannot be assigned to ${RECEIPTS_DIR}; \
compile receipts are disabled. Set NEXUSPUPPET_RECEIPTS_GROUP in ${CONFIG} to the group \
puppetserver runs as (pe-puppet on Puppet Enterprise)."
        return 1
    fi

    chmod 0770 "$RECEIPTS_DIR" 2>/dev/null || {
        log "cannot set permissions on ${RECEIPTS_DIR}; compile receipts are disabled"
        return 1
    }
}

# Rotate, cap, upload, discard.
#
# RENAME, then read (§6). Truncating a file that in-flight compiles are
# appending to loses every line written between the read and the truncate;
# renaming is atomic, so appends continue into a fresh `current` while the
# renamed copy is in transit.
hand_over() {
    current="${RECEIPTS_DIR}/current"
    pending="${RECEIPTS_DIR}/pending"

    if [ -s "$current" ]; then
        rotated="${RECEIPTS_DIR}/.rotated.$$"
        if mv "$current" "$rotated" 2>/dev/null; then
            if [ -f "$pending" ]; then
                # ONE generation is retained and merged, oldest first. An outage
                # that lasts a week must not become a disk-full incident on a
                # Puppet server — a worse failure than the visibility it was
                # protecting.
                cat "$rotated" >>"$pending" && rm -f "$rotated"
            else
                mv "$rotated" "$pending"
            fi
        fi
    fi

    [ -s "$pending" ] || return 0

    total=$(wc -l <"$pending" | tr -d ' ')
    if [ "$MAX_RECEIPTS" -gt 0 ] && [ "$total" -gt "$MAX_RECEIPTS" ]; then
        if tail -n "$MAX_RECEIPTS" "$pending" >"${pending}.capped" 2>/dev/null; then
            mv -f "${pending}.capped" "$pending"
            log "discarded $((total - MAX_RECEIPTS)) oldest compile receipt(s) over the \
${MAX_RECEIPTS} cap"
            total="$MAX_RECEIPTS"
        fi
    fi

    set +e
    status=$(curl --silent --show-error \
        --cert "$CLIENT_CERT" --key "$CLIENT_KEY" --cacert "$CA_CERT" \
        --max-time "$TIMEOUT" \
        --request POST \
        --header 'Content-Type: text/plain' \
        --data-binary "@${pending}" \
        --output /dev/null \
        --write-out '%{http_code}' \
        "$URL" 2>/dev/null)
    rc=$?
    set -e

    if [ "$rc" -ne 0 ]; then
        log "could not hand over ${total} compile receipt(s) (curl ${rc}); keeping them for \
the next run"
        return 0
    fi

    case "$status" in
        2*)
            rm -f "$pending"
            log "handed over ${total} compile receipt(s)"
            ;;
        404 | 405 | 501)
            # This origin predates compile receipts, or lacks the capability.
            # 405 and not just 404: a listener with no receipts route rejects
            # the method before it looks at the path. Keeping them would grow a
            # file against a feature that is not there, and they are droppable.
            rm -f "$pending"
            log "origin does not accept compile receipts (HTTP ${status}); discarded ${total}"
            ;;
        *)
            log "origin refused ${total} compile receipt(s) (HTTP ${status}); keeping them \
for the next run"
            ;;
    esac
}

ensure_dir || exit 1

# Claim BEFORE the upload, not after.
#
# The claim says "a collector is running here", which is true whether or not
# the origin is reachable this minute. Writing it only on success would hand
# the work back to the sync script during exactly the outage both of them would
# fail at, and then two writers would race for one file.
date +%s >"$MARKER" 2>/dev/null || log "warning: cannot write ${MARKER}; \
nexuspuppet-sync may also try to hand over receipts"

hand_over
