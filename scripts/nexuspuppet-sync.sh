#!/bin/sh
# NexusPuppet ENC sync — the puppetserver side of ADR-0019.
#
# Fetches the materialized ENC tree over mTLS and swaps it into place. Runs
# from a systemd timer, does its work, and exits. Nothing long-lived.
#
#   /etc/puppetlabs/nexuspuppet -> /var/lib/nexuspuppet-sync/trees/<etag>
#
# THIS IS NOT ON THE COMPILE PATH. `nexuspuppet-enc.sh` reads a local file and
# knows nothing about this script. Stop NexusPuppet, break the network, delete
# this file — the last synced tree stays exactly where it is and catalogs keep
# compiling. The test any change here must pass: *can catalog compilation fail
# because NexusPuppet is unavailable?* The answer must stay no.
#
# So the failure mode is STALE, never BROKEN. Every error path leaves the
# current tree untouched and exits non-zero so systemd records it.
#
# Dependencies: sh, curl, tar, and GNU coreutils `mv -T`. All present on a
# puppetserver host, which is often tightly controlled — adding a runtime here
# would undo the point of the ENC being dependency-free.

set -eu

CONFIG="${NEXUSPUPPET_SYNC_CONFIG:-/etc/default/nexuspuppet-sync}"
# shellcheck source=/dev/null
[ -r "$CONFIG" ] && . "$CONFIG"

URL="${NEXUSPUPPET_SYNC_URL:-}"
STATE_DIR="${NEXUSPUPPET_SYNC_STATE_DIR:-/var/lib/nexuspuppet-sync}"
LINK="${NEXUSPUPPET_SYNC_LINK:-/etc/puppetlabs/nexuspuppet}"
SSL_DIR="${NEXUSPUPPET_SYNC_SSL_DIR:-/etc/puppetlabs/puppet/ssl}"
CERTNAME="${NEXUSPUPPET_SYNC_CERTNAME:-$(hostname -f 2>/dev/null || hostname)}"
CLIENT_CERT="${NEXUSPUPPET_SYNC_CERT:-${SSL_DIR}/certs/${CERTNAME}.pem}"
CLIENT_KEY="${NEXUSPUPPET_SYNC_KEY:-${SSL_DIR}/private_keys/${CERTNAME}.pem}"
CA_CERT="${NEXUSPUPPET_SYNC_CA:-${SSL_DIR}/certs/ca.pem}"
TIMEOUT="${NEXUSPUPPET_SYNC_TIMEOUT:-30}"
KEEP="${NEXUSPUPPET_SYNC_KEEP:-3}"
# Refuse a tree that has lost more than this share of its node files.
#
# Same reasoning as NodeProjectionService refusing to prune on a small
# response: a truncated fetch and a genuinely emptied estate look identical
# from here, and guessing wrong drops every node to default.yaml — an
# estate-wide declassification that no single log line would explain. 0
# disables the guard for an estate that really is shrinking.
MAX_SHRINK_PERCENT="${NEXUSPUPPET_SYNC_MAX_SHRINK_PERCENT:-50}"

# Compile receipts (ADR-0022). `nexuspuppet-enc.sh` appends to
# ${RECEIPTS_DIR}/current as the puppetserver user; this script carries the
# lines away on its next poll.
RECEIPTS_DIR="${NEXUSPUPPET_SYNC_RECEIPTS_DIR:-${STATE_DIR}/receipts}"
# The group the puppetserver runs as. `pe-puppet` on Puppet Enterprise.
RECEIPTS_GROUP="${NEXUSPUPPET_SYNC_RECEIPTS_GROUP:-puppet}"
# Same origin as the tree, so no second host, port or credential is introduced.
RECEIPTS_URL="${NEXUSPUPPET_SYNC_RECEIPTS_URL:-}"
# Oldest-first cap, applied HERE rather than on the compile path — capping
# there would mean rewriting a file concurrent compiles are appending to
# (ADR-0022 §5). What matters is the latest revision per certname, so the
# newest lines carry the current state and discarding the tail loses history
# nobody queries. 0 disables the cap.
MAX_RECEIPTS="${NEXUSPUPPET_SYNC_MAX_RECEIPTS:-20000}"

log() { echo "nexuspuppet-sync: $*" >&2; }
die() { log "$*"; exit 1; }

[ -n "$RECEIPTS_URL" ] || RECEIPTS_URL="${URL%/*}/enc-receipts"

# Somewhere the puppetserver user can append and this script can rotate.
#
# 0770 and NOT 2770. setgid looks like the right answer — it would pin the group
# on files the puppetserver user creates — but the unit sets
# `RestrictSUIDSGID=yes`, so the chmod is refused with EPERM and the whole
# feature disables itself with a message about permissions. Verified on a real
# puppetserver, where it did exactly that.
#
# It is not needed. The puppetserver user's primary group IS this group, so its
# files land in it anyway, and the unit already joins the group via
# `SupplementaryGroups=` for the private key — which is also what lets it read a
# receipts file written under a restrictive umask, since it drops
# CAP_DAC_OVERRIDE and cannot simply override the mode as root normally would.
#
# Best-effort, and loud when it fails: receipts are droppable (ADR-0022 §5), so
# this must never fail a sync. But a missing group is silent everywhere else —
# the compile path is forbidden from complaining — so this is the one place an
# operator can be told, and `systemctl status` is where they will look.
ensure_receipts_dir() {
    mkdir -p "$RECEIPTS_DIR" 2>/dev/null || {
        log "warning: cannot create ${RECEIPTS_DIR}; compile receipts are disabled"
        return 1
    }

    if ! chgrp "$RECEIPTS_GROUP" "$RECEIPTS_DIR" 2>/dev/null; then
        log "warning: group '${RECEIPTS_GROUP}' does not exist or cannot be assigned to \
${RECEIPTS_DIR}; compile receipts are disabled. Set NEXUSPUPPET_SYNC_RECEIPTS_GROUP in \
${CONFIG} to the group puppetserver runs as (pe-puppet on Puppet Enterprise)."
        return 1
    fi

    chmod 0770 "$RECEIPTS_DIR" 2>/dev/null || {
        log "warning: cannot set permissions on ${RECEIPTS_DIR}; compile receipts are disabled"
        return 1
    }
}

# Hand the accumulated receipts over, then discard them.
#
# Never fails the sync: the tree is already installed by the time this runs, and
# ADR-0022's ordering is catalogs, then trees, then bookkeeping. Each layer
# degrades to the one below rather than taking it down.
hand_over_receipts() {
    current="${RECEIPTS_DIR}/current"
    pending="${RECEIPTS_DIR}/pending"

    # RENAME, then read. Truncating a file that in-flight compiles are appending
    # to loses every line written between the read and the truncate; renaming is
    # atomic, so appends continue into a fresh `current` while the renamed copy
    # is uploaded.
    if [ -s "$current" ]; then
        rotated="${RECEIPTS_DIR}/.rotated.$$"
        if mv "$current" "$rotated" 2>/dev/null; then
            if [ -f "$pending" ]; then
                # A previous upload failed. ONE generation is retained and
                # merged, oldest first — an outage that lasts a week must not
                # become a disk-full incident on a Puppet server, which is a
                # worse failure than the visibility it was protecting.
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
    receipt_status=$(curl --silent --show-error \
        --cert "$CLIENT_CERT" --key "$CLIENT_KEY" --cacert "$CA_CERT" \
        --max-time "$TIMEOUT" \
        --request POST \
        --header 'Content-Type: text/plain' \
        --data-binary "@${pending}" \
        --output /dev/null \
        --write-out '%{http_code}' \
        "$RECEIPTS_URL" 2>"${work}/receipts.err")
    receipt_rc=$?
    set -e

    if [ "$receipt_rc" -ne 0 ]; then
        log "could not hand over ${total} compile receipt(s) (curl ${receipt_rc}); keeping them \
for the next run"
        return 0
    fi

    case "$receipt_status" in
        2*)
            rm -f "$pending"
            log "handed over ${total} compile receipt(s)"
            ;;
        404 | 405 | 501)
            # This NexusPuppet predates compile receipts, or the deployment
            # lacks the capability. Keeping them would grow a file for a feature
            # that is not there; they are droppable by design.
            #
            # 405 and not just 404: a listener that predates this route rejects
            # the method before it ever looks at the path, so an origin with no
            # receipts surface answers 405. Treating that as retryable would
            # accumulate a file against a feature that is not coming until the
            # far side is upgraded.
            rm -f "$pending"
            log "origin does not accept compile receipts (HTTP ${receipt_status}); \
discarded ${total}"
            ;;
        *)
            log "origin refused ${total} compile receipt(s) (HTTP ${receipt_status}); keeping \
them for the next run"
            ;;
    esac

    return 0
}

[ -n "$URL" ] || die "NEXUSPUPPET_SYNC_URL is not set. See ${CONFIG}."
command -v curl >/dev/null 2>&1 || die "curl is required."
command -v tar  >/dev/null 2>&1 || die "tar is required."
# `mv -T` is what makes the swap a single rename(2). Without it, moving a
# symlink onto an existing symlink-to-a-directory moves it INSIDE that
# directory instead — silently producing a nested mess rather than a swap.
mv --help 2>/dev/null | grep -q -- '-T' || die "GNU coreutils 'mv -T' is required."

for f in "$CLIENT_CERT" "$CLIENT_KEY" "$CA_CERT"; do
    [ -r "$f" ] || die "cannot read $f — check NEXUSPUPPET_SYNC_* in ${CONFIG}"
done

# A real directory where the symlink goes — every deployment that predates
# replication, because that is where the tree was mounted or copied.
#
# Checked HERE rather than discovered at the swap. `mv -T` refuses to replace a
# directory with a symlink and says so in its own terms:
#
#   mv: cannot overwrite directory '/etc/puppetlabs/nexuspuppet' with non-directory
#
# which reads like a bug in this script rather than a one-time migration the
# operator has to approve. Failing before the fetch also means an operator who
# has not done it yet does not repeatedly download a tree that cannot be
# installed.
#
# NOT migrated automatically. Moving it aside is destructive to a tree somebody
# may have assembled by hand, and the window where the path does not exist
# fails EVERY compile (the ENC script exits non-zero with no tree) — that is
# the operator's call to make, at a moment of their choosing.
if [ -d "$LINK" ] && [ ! -L "$LINK" ]; then
    die "${LINK} is a directory, not a symlink — this deployment predates replication.
Move it aside once, then this will install the synced tree in its place:

    sudo mv ${LINK} ${LINK}.pre-sync

Its contents stay there; nothing is deleted. Doing it by hand is deliberate:
between the move and the next successful sync there is no tree, and every
catalog compile fails until one lands."
fi

mkdir -p "${STATE_DIR}/trees"
etag_file="${STATE_DIR}/etag"
previous_etag=''
[ -r "$etag_file" ] && previous_etag=$(cat "$etag_file")

work=$(mktemp -d "${STATE_DIR}/.sync.XXXXXX")
# Runs on every exit path, including the error ones. A failed sync must not
# accumulate half-extracted trees under the state directory.
trap 'rm -rf "$work"' EXIT INT TERM

set +e
status=$(curl --silent --show-error \
    --cert "$CLIENT_CERT" --key "$CLIENT_KEY" --cacert "$CA_CERT" \
    --max-time "$TIMEOUT" \
    ${previous_etag:+--header "If-None-Match: \"${previous_etag}\""} \
    --output "${work}/tree.tar" \
    --dump-header "${work}/headers" \
    --write-out '%{http_code}' \
    "$URL" 2>"${work}/curl.err")
curl_rc=$?
set -e

if [ "$curl_rc" -ne 0 ]; then
    # Unreachable, TLS refused, timed out. The current tree is untouched and
    # every node keeps its classification; this is stale, not broken.
    die "fetch failed (curl $curl_rc): $(tr -d '\r' <"${work}/curl.err" | head -1)"
fi

case "$status" in
    304)
        # The overwhelming majority of runs: nothing changed, so no tree is
        # installed. Receipts still travel — they accumulate with every compile,
        # not with every change, and a stable estate is exactly when the console
        # most needs to keep hearing that nodes are compiling from the current
        # revision.
        fresh=no
        ;;
    200) fresh=yes ;;
    401|403)
        die "refused with HTTP ${status} — is ${CERTNAME} in ENC_REPLICATION_ALLOWED_CERTNAMES?"
        ;;
    *)
        die "unexpected HTTP ${status} from ${URL}"
        ;;
esac

if [ "$fresh" = no ]; then
    if ensure_receipts_dir; then
        hand_over_receipts || true
    fi
    exit 0
fi

etag=$(tr -d '\r' <"${work}/headers" \
    | sed -n 's/^[Ee][Tt][Aa][Gg]: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' | tail -1)
[ -n "$etag" ] || die "the server sent no ETag; refusing to install an unidentifiable tree"

mkdir -p "${work}/tree"
tar -xf "${work}/tree.tar" -C "${work}/tree" || die "the archive did not extract"

# default.yaml is what `nexuspuppet-enc.sh` falls back to for any node without
# its own file. A tree missing it turns every unknown node into a FAILED
# COMPILE rather than a default classification, so it is never installed.
[ -f "${work}/tree/default.yaml" ] || die "the fetched tree has no default.yaml; refusing it"

new_count=$(find "${work}/tree/nodes" -maxdepth 1 -name '*.yaml' 2>/dev/null | wc -l)
old_count=0
[ -d "${LINK}/nodes" ] && old_count=$(find "${LINK}/nodes" -maxdepth 1 -name '*.yaml' 2>/dev/null | wc -l)

if [ "$MAX_SHRINK_PERCENT" -gt 0 ] && [ "$old_count" -gt 0 ]; then
    floor=$(( old_count * (100 - MAX_SHRINK_PERCENT) / 100 ))
    if [ "$new_count" -lt "$floor" ]; then
        die "refusing a tree that shrank from ${old_count} to ${new_count} nodes (floor ${floor}). \
Set NEXUSPUPPET_SYNC_MAX_SHRINK_PERCENT=0 in ${CONFIG} if the estate really shrank."
    fi
fi

# Name the tree from inside itself, so `nexuspuppet-enc.sh` can say what it is
# serving without knowing anything about this script or the network.
#
# Written BEFORE the directory is moved into place, so an installed tree always
# carries its revision — there is no window in which one is live but anonymous.
# It is the server's ETag verbatim, which makes "did this node compile with the
# current classification?" an equality check rather than arithmetic on clocks
# (ADR-0022 §2).
printf '%s\n' "$etag" >"${work}/tree/.revision"

target="${STATE_DIR}/trees/${etag}"
rm -rf "$target"
mv "${work}/tree" "$target"

# THE SWAP, and the only moment puppetserver's view changes.
#
# A symlink created beside the destination and renamed onto it: one rename(2),
# so a compile either sees the whole old tree or the whole new one. Never a
# mixture, which is what ADR-0019 §4 requires and what `rsync --delay-updates`
# narrows but does not close.
staging_link="${STATE_DIR}/.live.$$"
ln -sfn "$target" "$staging_link"
mv -T "$staging_link" "$LINK"

printf '%s\n' "$etag" >"${etag_file}.new"
mv -f "${etag_file}.new" "$etag_file"

# Keep a few previous trees. They cost kilobytes and make a rollback a single
# `ln -sfn` at the moment somebody most wants one.
if [ "$KEEP" -gt 0 ]; then
    # shellcheck disable=SC2012
    ls -1dt "${STATE_DIR}/trees/"*/ 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
        [ "$old" = "${target}/" ] || rm -rf "$old"
    done
fi

log "installed ${new_count} node file(s), etag ${etag}"

if ensure_receipts_dir; then
    hand_over_receipts || true
fi
