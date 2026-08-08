#!/bin/sh
# Tests for the compile-path half of ADR-0022, in the shell it actually runs in.
#
# `nexuspuppet-enc.sh` decides what a thousand machines run and must never fail
# because bookkeeping did — a property that is only worth anything if it is
# tested by BREAKING the bookkeeping, not by reading the code. So every failure
# path here is provoked for real: an unwritable directory, an absent revision, a
# tree swapped out mid-compile.
#
# POSIX sh, no framework. The script under test has no runtime beyond /bin/sh
# and neither does this.
#
#   sh scripts/test/enc-receipts.sh

set -eu

HERE=$(cd -P "$(dirname "$0")" && pwd)
# Overridable so these can be pointed at a deliberately broken copy — a test
# that has never been seen to fail has not been shown to test anything.
ENC="${NEXUSPUPPET_ENC_SCRIPT:-${HERE}/../nexuspuppet-enc.sh}"
[ -x "$ENC" ] || ENC="sh ${ENC}"

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

# A sandbox holding two complete trees and a symlink that selects one, which is
# the exact shape the sync script installs.
sandbox() {
    root=$(mktemp -d)
    for rev in "$@"; do
        mkdir -p "${root}/trees/${rev}/nodes"
        printf '%s\n' "$rev" >"${root}/trees/${rev}/.revision"
        printf -- '---\nclasses: [%s]\n' "$rev" >"${root}/trees/${rev}/nodes/web01.test.yaml"
        printf -- '---\nclasses: [default_%s]\n' "$rev" >"${root}/trees/${rev}/default.yaml"
    done
    ln -sfn "${root}/trees/$1" "${root}/live"
    mkdir -p "${root}/receipts"
    echo "$root"
}

run_enc() {
    root=$1
    node=$2
    NEXUSPUPPET_ENC_DIR="${root}/live" \
        NEXUSPUPPET_RECEIPTS="${root}/receipts/current" \
        $ENC "$node"
}

echo "compile receipts (ADR-0022)"

# ---------------------------------------------------------------------------
root=$(sandbox r1)
served=$(run_enc "$root" web01.test)
is "serves the node's document" "$served" "$(cat "${root}/trees/r1/nodes/web01.test.yaml")"
is "records one receipt naming the revision" "$(cat "${root}/receipts/current")" "r1 web01.test"
rm -rf "$root"

# ---------------------------------------------------------------------------
# A node with no file of its own still compiled from this revision, and that is
# the answer somebody wants when a rule was supposed to match it and did not.
root=$(sandbox r1)
served=$(run_enc "$root" unknown.test)
is "falls back to the default document" "$served" "$(cat "${root}/trees/r1/default.yaml")"
is "records a receipt for the default too" "$(cat "${root}/receipts/current")" "r1 unknown.test"
rm -rf "$root"

# ---------------------------------------------------------------------------
# THE ONE THAT MATTERS. Provoked, not reasoned about.
root=$(sandbox r1)
chmod 0555 "${root}/receipts"
if served=$(run_enc "$root" web01.test 2>"${root}/stderr"); then
    is "compiles with an unwritable receipts directory" \
        "$served" "$(cat "${root}/trees/r1/nodes/web01.test.yaml")"
else
    no "compiles with an unwritable receipts directory" "the ENC script exited non-zero"
fi
is "and says nothing about it on stderr" "$(cat "${root}/stderr")" ""
chmod 0755 "${root}/receipts"
rm -rf "$root"

# ---------------------------------------------------------------------------
# A tree installed before receipts existed has no .revision.
root=$(sandbox r1)
rm -f "${root}/trees/r1/.revision"
if served=$(run_enc "$root" web01.test 2>"${root}/stderr"); then
    is "compiles with no .revision in the tree" \
        "$served" "$(cat "${root}/trees/r1/nodes/web01.test.yaml")"
else
    no "compiles with no .revision in the tree" "the ENC script exited non-zero"
fi
is "and writes no receipt it cannot name" "$([ -s "${root}/receipts/current" ] && echo some || echo none)" "none"
rm -rf "$root"

# ---------------------------------------------------------------------------
# Concurrent compiles interleave whole lines rather than corrupting each other.
root=$(sandbox r1)
i=0
while [ "$i" -lt 20 ]; do
    run_enc "$root" web01.test >/dev/null &
    i=$((i + 1))
done
wait
is "20 concurrent compiles write 20 whole lines" "$(wc -l <"${root}/receipts/current" | tr -d ' ')" "20"
is "and every line is well formed" \
    "$(grep -cv '^r1 web01\.test$' "${root}/receipts/current" || true)" "0"
rm -rf "$root"

# ---------------------------------------------------------------------------
# A swap landing mid-compile must not produce a receipt naming a revision this
# node was never served.
#
# Made deterministic with a FIFO: the script blocks reading the revision, which
# is precisely the window a swap would straddle. The symlink is moved to the
# other tree while it is blocked. A script that resolved the tree once serves
# and reports r1; one that reads through the symlink twice reports r1 and serves
# r2 — the inconsistency this pins down.
root=$(sandbox r1 r2)
rm -f "${root}/trees/r1/.revision"
mkfifo "${root}/trees/r1/.revision"

run_enc "$root" web01.test >"${root}/served" 2>/dev/null &
enc_pid=$!

# Wait for the script to actually block on the FIFO rather than racing it.
waited=0
while [ ! -s "${root}/served" ] && [ "$waited" -lt 50 ]; do
    sleep 0.1
    waited=$((waited + 1))
done

ln -sfn "${root}/trees/r2" "${root}/live.new"
mv -T "${root}/live.new" "${root}/live"
printf 'r1\n' >"${root}/trees/r1/.revision"
wait "$enc_pid" || true

served=$(cat "${root}/served")
receipt=$(cat "${root}/receipts/current" 2>/dev/null || echo '')
is "a swap mid-compile serves the tree it reported" \
    "$served" "$(cat "${root}/trees/r1/nodes/web01.test.yaml")"
is "and the receipt names that same revision" "$receipt" "r1 web01.test"
rm -rf "$root"

# ---------------------------------------------------------------------------
echo
echo "${passed} passed, ${failed} failed"
[ "$failed" -eq 0 ]
