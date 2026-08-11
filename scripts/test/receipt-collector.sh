#!/bin/sh
# Tests for the compile-receipt collector (ADR-0022 §13, §15).
#
# The collector's whole job is to move a file without losing lines that are
# being appended to it, and to react correctly to a set of HTTP statuses it does
# not control. Both are only worth testing by provoking them: a stub `curl`
# earlier on PATH stands in for the origin, so every status the shipped puller
# distinguishes is exercised for real rather than read about.
#
# POSIX sh, no framework — same as the script under test.
#
#   sh scripts/test/receipt-collector.sh

set -eu

HERE=$(cd -P "$(dirname "$0")" && pwd)
COLLECTOR="${NEXUSPUPPET_RECEIPTS_SCRIPT:-${HERE}/../nexuspuppet-receipts.sh}"
SYNC="${NEXUSPUPPET_SYNC_SCRIPT:-${HERE}/../nexuspuppet-sync.sh}"

passed=0
failed=0

ok() {
    passed=$((passed + 1))
    echo "  ok   $1"
}

no() {
    failed=$((failed + 1))
    echo "  FAIL $1"
    [ $# -lt 2 ] || echo "       $2"
}

is() {
    if [ "$2" = "$3" ]; then
        ok "$1"
    else
        no "$1" "expected [$3], got [$2]"
    fi
}

# A stub curl that reports the status in $STUB_STATUS and records the body it
# was given, so a test can assert on what would have been uploaded.
make_stub_curl() {
    stub_dir="$1"
    mkdir -p "$stub_dir"
    cat >"${stub_dir}/curl" <<'STUB'
#!/bin/sh
# Records the uploaded file, then reports the configured status.
for arg in "$@"; do
    case "$arg" in
        @*) cp "${arg#@}" "${STUB_UPLOAD:-/dev/null}" 2>/dev/null || true ;;
    esac
done
[ "${STUB_FAIL:-0}" = "1" ] && exit 7
printf '%s' "${STUB_STATUS:-202}"
exit 0
STUB
    chmod +x "${stub_dir}/curl"
}

# A sandbox with a receipts directory and a configured collector.
sandbox() {
    root=$(mktemp -d)
    mkdir -p "${root}/receipts" "${root}/bin"
    make_stub_curl "${root}/bin"

    NEXUSPUPPET_RECEIPTS_CONFIG=/dev/null
    NEXUSPUPPET_SYNC_CONFIG=/dev/null
    NEXUSPUPPET_RECEIPTS_DIR="${root}/receipts"
    NEXUSPUPPET_RECEIPTS_URL="https://origin.example.com:8443/enc-receipts"
    # The group this test process is already in, so the chgrp succeeds without
    # root or a puppet install.
    NEXUSPUPPET_RECEIPTS_GROUP=$(id -gn)
    STUB_UPLOAD="${root}/uploaded"
    export NEXUSPUPPET_RECEIPTS_CONFIG NEXUSPUPPET_SYNC_CONFIG NEXUSPUPPET_RECEIPTS_DIR \
        NEXUSPUPPET_RECEIPTS_URL NEXUSPUPPET_RECEIPTS_GROUP STUB_UPLOAD
}

run_collector() {
    PATH="${root}/bin:${PATH}" sh "$COLLECTOR" 2>"${root}/err" || true
}

echo "collector: the receipt lifecycle"

# --- it creates the directory nobody else creates -------------------------
sandbox
rm -rf "${root}/receipts"
run_collector
if [ -d "${root}/receipts" ]; then
    ok "creates the receipts directory when it does not exist"
else
    no "creates the receipts directory when it does not exist" "still absent"
fi

# THE point of this script existing. Co-located, nothing else ever created this
# directory, so every append from the compile path failed silently and the
# console showed nothing with no error anywhere (§13).
# Group-writable is the property that matters: the compile path appends as the
# puppetserver user, which is in this group and is not the owner.
if [ -w "${root}/receipts" ] && [ -x "${root}/receipts" ]; then
    ok "makes it group-writable so the compile path can append"
else
    no "makes it group-writable so the compile path can append" "not writable"
fi

# --- it uploads and discards on success -----------------------------------
sandbox
printf 'aaa111 web01.example.com\nbbb222 db02.example.com\n' >"${root}/receipts/current"
STUB_STATUS=202 run_collector
is "uploads what was accumulated" "$(cat "${root}/uploaded")" \
    "$(printf 'aaa111 web01.example.com\nbbb222 db02.example.com\n')"
if [ -e "${root}/receipts/pending" ]; then
    no "discards after a 2xx" "pending survived"
else
    ok "discards after a 2xx"
fi

# --- rotate, not truncate -------------------------------------------------
#
# The compile path appends while the upload is in flight. Truncating would lose
# every line written between the read and the truncate (§6); renaming cannot.
sandbox
printf 'aaa111 web01.example.com\n' >"${root}/receipts/current"
STUB_STATUS=202 run_collector
printf 'ccc333 later.example.com\n' >>"${root}/receipts/current"
is "a compile during the upload keeps its receipt" \
    "$(cat "${root}/receipts/current")" "ccc333 later.example.com"

# --- one generation is retained on failure --------------------------------
sandbox
printf 'aaa111 web01.example.com\n' >"${root}/receipts/current"
STUB_STATUS=500 run_collector
is "keeps receipts when the origin refuses" \
    "$(cat "${root}/receipts/pending")" "aaa111 web01.example.com"

printf 'bbb222 db02.example.com\n' >"${root}/receipts/current"
STUB_STATUS=202 run_collector
is "merges the retained generation oldest-first into the next attempt" \
    "$(cat "${root}/uploaded")" \
    "$(printf 'aaa111 web01.example.com\nbbb222 db02.example.com\n')"

# --- a transport failure is retryable -------------------------------------
sandbox
printf 'aaa111 web01.example.com\n' >"${root}/receipts/current"
STUB_FAIL=1 run_collector
is "keeps receipts when curl itself fails" \
    "$(cat "${root}/receipts/pending")" "aaa111 web01.example.com"

# --- the statuses the shipped puller distinguishes ------------------------
#
# 404/405/501 mean "this origin has no receipts surface". 405 specifically: a
# listener that predates the route rejects the method before it looks at the
# path. Treating them as retryable would grow a file forever against a feature
# that is not coming until the far side is upgraded (§10).
for status in 404 405 501; do
    sandbox
    printf 'aaa111 web01.example.com\n' >"${root}/receipts/current"
    STUB_STATUS=$status run_collector
    if [ -e "${root}/receipts/pending" ]; then
        no "discards on HTTP ${status}" "pending survived"
    else
        ok "discards on HTTP ${status}"
    fi
done

# --- the cap is oldest-first ----------------------------------------------
#
# The newest lines carry the current state; discarding the tail loses history
# nobody queries. Dropping the newest would discard the answer the feature
# exists to give (§5).
sandbox
i=1
: >"${root}/receipts/current"
while [ "$i" -le 10 ]; do
    printf 'rev%03d node%03d.example.com\n' "$i" "$i" >>"${root}/receipts/current"
    i=$((i + 1))
done
NEXUSPUPPET_RECEIPTS_MAX=3 STUB_STATUS=202 run_collector
is "caps to the newest lines" "$(wc -l <"${root}/uploaded" | tr -d ' ')" "3"
is "keeps the NEWEST, not the oldest" "$(head -1 "${root}/uploaded")" \
    "rev008 node008.example.com"

# --- it refuses to run unconfigured ---------------------------------------
sandbox
NEXUSPUPPET_RECEIPTS_URL='' \
    PATH="${root}/bin:${PATH}" sh "$COLLECTOR" 2>"${root}/err" && rc=0 || rc=$?
is "exits non-zero with no URL configured" "$rc" "1"
case "$(cat "${root}/err")" in
    *"no receipts URL configured"*) ok "says what to set when unconfigured" ;;
    *) no "says what to set when unconfigured" "got: $(cat "${root}/err")" ;;
esac

echo
echo "sync: deferring to the collector (§15)"

# --- the claim, and its staleness -----------------------------------------
#
# Two drainers on one file would race for the rotate, so the tie is broken by
# evidence that the collector is actually running — not by whether somebody
# remembered to install it.
sandbox
printf 'aaa111 web01.example.com\n' >"${root}/receipts/current"
STUB_STATUS=202 run_collector
if [ -s "${root}/receipts/.collector" ]; then
    ok "the collector claims the directory"
else
    no "the collector claims the directory" "no marker written"
fi

run_sync() {
    # The sync script verifies its certificates before doing anything, so the
    # sandbox needs files to point at. Contents are irrelevant — the stub curl
    # never reads them.
    mkdir -p "${root}/state" "${root}/ssl"
    : >"${root}/ssl/cert.pem"
    : >"${root}/ssl/key.pem"
    : >"${root}/ssl/ca.pem"
    STUB_STATUS=304 \
        NEXUSPUPPET_SYNC_CERT="${root}/ssl/cert.pem" \
        NEXUSPUPPET_SYNC_KEY="${root}/ssl/key.pem" \
        NEXUSPUPPET_SYNC_CA="${root}/ssl/ca.pem" \
        NEXUSPUPPET_SYNC_LINK="${root}/enc-link" \
        NEXUSPUPPET_SYNC_CONFIG=/dev/null \
        NEXUSPUPPET_SYNC_RECEIPTS_GROUP="$(id -gn)" \
        NEXUSPUPPET_SYNC_URL="https://origin.example.com:8443/enc-tree.tar" \
        NEXUSPUPPET_SYNC_RECEIPTS_DIR="${root}/receipts" \
        NEXUSPUPPET_SYNC_ANNOUNCE_FILE="${root}/announced" \
        NEXUSPUPPET_SYNC_STATE_DIR="${root}/state" \
        NEXUSPUPPET_SYNC_COLLECTOR_MAX_AGE="${1:-3600}" \
        PATH="${root}/bin:${PATH}" sh "$SYNC" >"${root}/sync.out" 2>"${root}/sync.err" || true
}

# A fresh claim: sync must leave the file alone.
printf 'ddd444 fresh.example.com\n' >"${root}/receipts/current"
date +%s >"${root}/receipts/.collector"
run_sync 3600
is "sync leaves receipts alone while the collector is running" \
    "$(cat "${root}/receipts/current")" "ddd444 fresh.example.com"

# A stale claim: the collector stopped, so sync must resume rather than defer
# forever to something that is no longer there.
echo "1" >"${root}/receipts/.collector"
run_sync 3600
if [ -e "${root}/receipts/current" ]; then
    no "sync resumes when the claim goes stale" "current was not rotated"
else
    ok "sync resumes when the claim goes stale"
fi

# A corrupt claim is not evidence of anything.
sandbox
printf 'eee555 web01.example.com\n' >"${root}/receipts/current"
printf 'not-a-timestamp\n' >"${root}/receipts/.collector"
run_sync 3600
if [ -e "${root}/receipts/current" ]; then
    no "sync ignores an unreadable claim" "current was not rotated"
else
    ok "sync ignores an unreadable claim"
fi

echo
echo "${passed} passed, ${failed} failed"
[ "$failed" -eq 0 ]
