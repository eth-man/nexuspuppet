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

log() { echo "nexuspuppet-sync: $*" >&2; }
die() { log "$*"; exit 1; }

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
        # The overwhelming majority of runs. Nothing changed, nothing to do.
        exit 0
        ;;
    200) ;;
    401|403)
        die "refused with HTTP ${status} — is ${CERTNAME} in ENC_REPLICATION_ALLOWED_CERTNAMES?"
        ;;
    *)
        die "unexpected HTTP ${status} from ${URL}"
        ;;
esac

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
