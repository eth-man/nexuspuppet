#!/bin/sh
# Tests for deploy.sh's one exception to "an existing .env is never touched":
# generating CONFIG_ENCRYPTION_KEY when it is absent (ADR-0029 §6).
#
# The function is lifted out of deploy.sh between its marker comments and run
# on its own, so this needs no Docker and never runs a deploy. What is pinned:
#
#   - a missing key is appended, once, and the run says so;
#   - a re-run changes nothing (idempotent);
#   - an existing key is never modified — byte-for-byte, the file is the same;
#   - an existing but EMPTY line is left alone and reported, not duplicated;
#   - a last line without a newline is not corrupted by the append;
#   - the generated key decodes to the 32 bytes the API requires.
#
# POSIX sh, no framework, like the other script tests:
#
#   dash scripts/test/deploy-config-key.sh

set -eu

HERE=$(cd -P "$(dirname "$0")" && pwd)
SCRIPT="${NEXUSPUPPET_DEPLOY_SCRIPT:-${HERE}/../deploy.sh}"

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
    if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "expected [$3], got [$2]"; fi
}

contains() {
    if grep -qF -- "$3" "$2" 2>/dev/null; then ok "$1"; else no "$1" "[$3] not in $2"; fi
}

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

# The function, exactly as deploy.sh defines it. If the markers move or the
# function disappears, this fails here rather than testing nothing.
sed -n '/^# >>> ensure_config_encryption_key$/,/^# <<< ensure_config_encryption_key$/p' \
    "$SCRIPT" >"${root}/fn.sh"
if grep -q '^ensure_config_encryption_key()' "${root}/fn.sh"; then
    ok "the function is found in deploy.sh"
else
    no "the function is found in deploy.sh" "markers or definition missing in ${SCRIPT}"
    echo
    echo "${passed} passed, ${failed} failed"
    exit 1
fi
# shellcheck source=/dev/null
. "${root}/fn.sh"

keys() { grep -c '^CONFIG_ENCRYPTION_KEY=' "$1" || true; }

# --- an upgrade from an install that never had a key ------------------------
env="${root}/upgrade.env"
printf '%s\n' 'NODE_ENV=production' 'JWT_SECRET=keep-me' '# CONFIG_ENCRYPTION_KEY=' >"$env"
cp "$env" "${root}/upgrade.before"

ensure_config_encryption_key "$env" >"${root}/out1"
is "a missing key is appended exactly once" "$(keys "$env")" 1
contains "and the run says so" "${root}/out1" "generated CONFIG_ENCRYPTION_KEY and appended it"
contains "with a comment saying where it came from" "$env" "# Added by scripts/deploy.sh"

# Everything that was there is still there, unchanged and in order: the file
# before is a prefix of the file after.
before_bytes=$(wc -c <"${root}/upgrade.before")
head -c "$before_bytes" "$env" >"${root}/upgrade.prefix"
if cmp -s "${root}/upgrade.before" "${root}/upgrade.prefix"; then
    ok "nothing that was in the file is changed"
else
    no "nothing that was in the file is changed" "$(diff "${root}/upgrade.before" "$env" || true)"
fi

key=$(sed -n 's/^CONFIG_ENCRYPTION_KEY=//p' "$env")
if command -v base64 >/dev/null 2>&1; then
    is "the key decodes to 32 bytes" "$(printf '%s' "$key" | base64 -d | wc -c | tr -d ' ')" 32
fi

# --- a re-run is a no-op -----------------------------------------------------
cp "$env" "${root}/after-first"
ensure_config_encryption_key "$env" >"${root}/out2"
if cmp -s "$env" "${root}/after-first"; then
    ok "a re-run leaves the file byte-for-byte unchanged"
else
    no "a re-run leaves the file byte-for-byte unchanged" "$(diff "${root}/after-first" "$env" || true)"
fi
contains "and says the key is already set" "${root}/out2" "already set"

# --- an existing key is never touched ----------------------------------------
env="${root}/existing.env"
printf '%s\n' 'JWT_SECRET=x' 'CONFIG_ENCRYPTION_KEY=operator-chose-this-one=' 'LAST=1' >"$env"
cp "$env" "${root}/existing.before"
ensure_config_encryption_key "$env" >/dev/null
if cmp -s "$env" "${root}/existing.before"; then
    ok "an existing key is left byte-for-byte as it was"
else
    no "an existing key is left byte-for-byte as it was" "$(diff "${root}/existing.before" "$env" || true)"
fi

# --- present but empty: reported, not duplicated -----------------------------
env="${root}/empty.env"
printf '%s\n' 'JWT_SECRET=x' 'CONFIG_ENCRYPTION_KEY=' >"$env"
cp "$env" "${root}/empty.before"
ensure_config_encryption_key "$env" >"${root}/out3"
if cmp -s "$env" "${root}/empty.before"; then
    ok "an empty existing line is not edited and not duplicated"
else
    no "an empty existing line is not edited and not duplicated" "$(diff "${root}/empty.before" "$env" || true)"
fi
contains "and the operator is told to fill it in" "${root}/out3" "EMPTY"

# --- a first install: the .env.example copy has only the commented line ------
env="${root}/fresh.env"
cp "${HERE}/../../.env.example" "$env"
ensure_config_encryption_key "$env" >/dev/null
is "a fresh install gets exactly one key" "$(keys "$env")" 1

# --- a last line with no trailing newline is not glued to the comment ---------
env="${root}/nonl.env"
printf 'LAST_SETTING=value' >"$env"
ensure_config_encryption_key "$env" >/dev/null
is "the operator's last line survives intact" "$(sed -n '1p' "$env")" "LAST_SETTING=value"
is "and the key is still on a line of its own" "$(keys "$env")" 1

echo
echo "${passed} passed, ${failed} failed"
[ "$failed" -eq 0 ]
