#!/bin/sh
# Tests for the host half of the support bundle (ADR-0028).
#
# What matters is what does NOT come out: every secret planted below is looked
# for in every file of the extracted archive. A stub `docker` earlier on PATH
# plays the Compose project, so the container-log path is exercised for real —
# including a service on the syslog driver, whose logs Docker cannot read back.
#
# POSIX sh, no framework, like the other script tests. The script under test is
# bash and is run with bash.
#
#   sh scripts/test/support-bundle.sh

set -eu

HERE=$(cd -P "$(dirname "$0")" && pwd)
SCRIPT="${NEXUSPUPPET_SUPPORT_SCRIPT:-${HERE}/../support-bundle.sh}"

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

JWT_SECRET_VALUE='planted-jwt-secret-value-0123456789'
PG_PASSWORD='quoted-pg-pass-99'
URL_ONLY_PASSWORD='url-only-pass-55'
UNKNOWN_VALUE='unknown-setting-value'
BIND_PASSWORD='not-in-env-bind-pw'
ALLOWED_URL_PW='pw-inside-an-allowed-url'
ADMIN_EMAIL='admin@corp.example'
LOG_EMAIL='someone@corp.example'
PEM_BODY='MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'
A_JWT='eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVl'

sandbox() {
    root=$(mktemp -d)
    mkdir -p "${root}/project" "${root}/bin" "${root}/out" "${root}/tmp"

    cat >"${root}/project/.env" <<EOF
# a comment
JWT_SECRET=${JWT_SECRET_VALUE}
POSTGRES_PASSWORD="${PG_PASSWORD}"
export DATABASE_URL=postgresql://np:${URL_ONLY_PASSWORD}@db:5432/np
LOG_LEVEL=info
PUPPETDB_URL=https://svc:${ALLOWED_URL_PW}@puppetdb.example.test:8081
SOMETHING_UNKNOWN=${UNKNOWN_VALUE}
BOOTSTRAP_ADMIN_EMAIL=${ADMIN_EMAIL}
CONFIG_ENCRYPTION_KEY=
EOF
    echo 'services: {}' >"${root}/project/docker-compose.yml"

    # The stub records every invocation so a test can assert on arguments.
    cat >"${root}/bin/docker" <<'STUB'
#!/bin/sh
echo "$*" >>"${STUB_CALLS}"
[ "${STUB_DOCKER_DOWN:-0}" = 1 ] && [ "$1" = info ] && exit 1
case "$*" in
    "compose ps -a --format {{.Service}}") printf 'api\nweb\n' ;;
    "compose ps -a -q api") echo cid-api ;;
    "compose ps -a -q web") echo cid-web ;;
    "compose ps -a") echo "NAME STATUS"; echo "project-api-1 running" ;;
    "inspect --format {{.HostConfig.LogConfig.Type}} cid-web") echo "${STUB_WEB_DRIVER:-json-file}" ;;
    "inspect --format {{.HostConfig.LogConfig.Type}} cid-api") echo json-file ;;
    inspect*) echo "/project-x-1 status=running restarts=0" ;;
    compose\ logs*)
        echo "api-1 | 2026-09-30T12:00:00Z signing with ${PLANTED_JWT_SECRET}"
        echo "api-1 | connecting to postgresql://np:${PLANTED_URL_PASSWORD}@db:5432/np"
        echo "api-1 | database password is ${PLANTED_PG_PASSWORD}"
        echo "api-1 | bind to ldaps://svc:${PLANTED_BIND_PASSWORD}@dc01.corp:636 failed"
        echo "api-1 | retrying with ${PLANTED_ALLOWED_URL_PW}"
        echo "api-1 | Upgraded password hash parameters for ${PLANTED_LOG_EMAIL}."
        echo "api-1 | token ${PLANTED_JWT}"
        # Assembled, never written out: CI refuses a committed key header.
        b='-----BEGIN'
        e='-----END'
        echo "api-1 | $b PRIVATE KEY-----"
        echo "api-1 | ${PLANTED_PEM_BODY}"
        echo "api-1 | $e PRIVATE KEY-----"
        echo "api-1 | after the key"
        ;;
    *) echo "stub docker: $*" ;;
esac
exit 0
STUB
    # Hermetic systemd: the runner's real journal is not what is under test.
    printf '#!/bin/sh\nexit 0\n' >"${root}/bin/systemctl"
    printf '#!/bin/sh\nexit 0\n' >"${root}/bin/journalctl"
    chmod +x "${root}/bin/docker" "${root}/bin/systemctl" "${root}/bin/journalctl"

    # A stand-in for the archive the console produces.
    mkdir -p "${root}/api"
    echo '{}' >"${root}/api/manifest.json"
    tar -C "${root}/api" -czf "${root}/nexuspuppet-support-abc-20260930T120000Z.tar.gz" manifest.json

    STUB_CALLS="${root}/calls"
    : >"$STUB_CALLS"
    PLANTED_JWT_SECRET="$JWT_SECRET_VALUE"
    PLANTED_URL_PASSWORD="$URL_ONLY_PASSWORD"
    PLANTED_PG_PASSWORD="$PG_PASSWORD"
    PLANTED_LOG_EMAIL="$LOG_EMAIL"
    PLANTED_JWT="$A_JWT"
    PLANTED_PEM_BODY="$PEM_BODY"
    PLANTED_BIND_PASSWORD="$BIND_PASSWORD"
    PLANTED_ALLOWED_URL_PW="$ALLOWED_URL_PW"
    export STUB_CALLS PLANTED_JWT_SECRET PLANTED_URL_PASSWORD PLANTED_PG_PASSWORD \
        PLANTED_LOG_EMAIL PLANTED_JWT PLANTED_PEM_BODY PLANTED_BIND_PASSWORD PLANTED_ALLOWED_URL_PW
}

run_script() {
    PATH="${root}/bin:${PATH}" TMPDIR="${root}/tmp" bash "$SCRIPT" "$@" >"${root}/stdout" 2>"${root}/stderr"
}

extract() {
    archive=$(cat "${root}/stdout")
    mkdir -p "${root}/x"
    tar -C "${root}/x" -xzf "$archive"
    bundle=$(find "${root}/x" -mindepth 1 -maxdepth 1 -type d)
}

echo "support-bundle.sh"

# --- --help actually works (a past --help never did) -------------------------
root=$(mktemp -d)
if bash "$SCRIPT" --help >"${root}/help" 2>&1; then ok "--help exits 0"; else no "--help exits 0"; fi
contains "--help prints usage" "${root}/help" "Usage: support-bundle.sh"
contains "--help documents --include" "${root}/help" "--include <file>"
if bash "$SCRIPT" -h >/dev/null 2>&1; then ok "-h exits 0"; else no "-h exits 0"; fi

for bad in 2x 24hh h -1h; do
    status=0
    bash "$SCRIPT" --since "$bad" >/dev/null 2>&1 || status=$?
    is "--since $bad is refused" "$status" 2
done
status=0
bash "$SCRIPT" --no-such-option >/dev/null 2>&1 || status=$?
is "an unknown option is refused" "$status" 2

# --- a full run against a stubbed Compose project ----------------------------
sandbox
STUB_WEB_DRIVER=syslog
export STUB_WEB_DRIVER
status=0
run_script --dir "${root}/project" --output "${root}/out" --since 2h \
    --include "${root}/nexuspuppet-support-abc-20260930T120000Z.tar.gz" || status=$?
is "a full run exits 0" "$status" 0
extract

case "$(basename "$archive")" in
    nexuspuppet-host-support-*-????????T??????Z.tar.gz) ok "the archive is named for host and time" ;;
    *) no "the archive is named for host and time" "$archive" ;;
esac

env_file="${bundle}/config/env.txt"
contains ".env: a secret is reported as set" "$env_file" "JWT_SECRET=<set>"
contains ".env: a quoted secret is reported as set" "$env_file" "POSTGRES_PASSWORD=<set>"
contains ".env: an exported secret is reported as set" "$env_file" "DATABASE_URL=<set>"
contains ".env: an empty secret is reported as unset" "$env_file" "CONFIG_ENCRYPTION_KEY=<unset>"
contains ".env: an identity is reported as set" "$env_file" "BOOTSTRAP_ADMIN_EMAIL=<set>"
contains ".env: allow-listed configuration keeps its value" "$env_file" "LOG_LEVEL=info"
contains ".env: an unknown key is withheld" "$env_file" "SOMETHING_UNKNOWN=<withheld"
contains ".env: an allow-listed URL keeps its host, not its password" "$env_file" \
    "PUPPETDB_URL=https://[REDACTED:"

api_log="${bundle}/compose/logs/api.log"
contains "container logs are collected" "$api_log" "after the key"
contains "a .env secret in a log is masked by name" "$api_log" "[REDACTED:JWT_SECRET]"
contains "a quoted .env secret in a log is masked" "$api_log" "[REDACTED:POSTGRES_PASSWORD]"
contains "a .env URL in a log is masked whole" "$api_log" "connecting to [REDACTED:DATABASE_URL]"
contains "URL credentials not from .env are masked structurally" "$api_log" \
    "ldaps://[REDACTED:URL-CREDENTIALS]@dc01.corp:636"
contains "a private key is masked" "$api_log" "[REDACTED:PEM-PRIVATE-KEY]"
contains "a JWT is masked" "$api_log" "[REDACTED:JWT]"
contains "an email address is masked" "$api_log" "[REDACTED:EMAIL]"
contains "the password inside an allow-listed URL is masked elsewhere too" "$api_log" \
    "retrying with [REDACTED:PUPPETDB_URL.password]"

if [ -f "${bundle}/compose/logs/web.NOT-COLLECTED.txt" ] && [ ! -f "${bundle}/compose/logs/web.log" ]; then
    ok "a syslog-driver service is explained, not left as an empty file"
else
    no "a syslog-driver service is explained, not left as an empty file"
fi
contains "docker logs receive the window" "${root}/calls" "compose logs --no-color --timestamps --since 2h api"

if grep -q "compose config" "${root}/calls"; then
    no "never runs 'docker compose config', which expands secrets"
else
    ok "never runs 'docker compose config', which expands secrets"
fi
if grep -qE '^inspect [^-]' "${root}/calls"; then
    no "never runs a full 'docker inspect', which prints the environment"
else
    ok "never runs a full 'docker inspect', which prints the environment"
fi

# THE ONE THAT MATTERS: nothing planted survives, anywhere in the archive.
for planted in "$JWT_SECRET_VALUE" "$PG_PASSWORD" "$URL_ONLY_PASSWORD" "$UNKNOWN_VALUE" \
    "$BIND_PASSWORD" "$ALLOWED_URL_PW" "$ADMIN_EMAIL" "$LOG_EMAIL" "$PEM_BODY" "$A_JWT"; do
    if grep -rqF -- "$planted" "$bundle"; then
        no "no file contains [$planted]" "$(grep -rlF -- "$planted" "$bundle" | head -1)"
    else
        ok "no file contains [$planted]"
    fi
done

contains "the manifest counts redactions" "${bundle}/MANIFEST.txt" "secret-value="
contains "the manifest says what was run" "${bundle}/MANIFEST.txt" "exit=0"
if [ -f "${bundle}/api-bundle/nexuspuppet-support-abc-20260930T120000Z.tar.gz" ]; then
    ok "--include embeds the console's archive untouched"
else
    no "--include embeds the console's archive untouched"
fi
if [ -z "$(find "${root}/tmp" -mindepth 1 -print -quit)" ]; then
    ok "the work directory, which held the secret values, is removed"
else
    no "the work directory, which held the secret values, is removed"
fi

# --- no Docker access: say so, collect the rest, still succeed ---------------
sandbox
STUB_DOCKER_DOWN=1
export STUB_DOCKER_DOWN
status=0
run_script --dir "${root}/project" --output "${root}/out" || status=$?
is "a run without Docker access still exits 0" "$status" 0
contains "a run without Docker access says so on stderr" "${root}/stderr" "cannot talk to Docker"
extract
contains "and says so in the archive" "${bundle}/MANIFEST.txt" "run as root or join the docker group"
if [ -f "${bundle}/host/uname.txt" ]; then ok "host facts are still collected"; else no "host facts are still collected"; fi
unset STUB_DOCKER_DOWN

# --- a Puppet server: no Compose project at all -------------------------------
sandbox
status=0
run_script --dir "${root}/nothing-here" --output "${root}/out" || status=$?
is "a host with no Compose project exits 0" "$status" 0
extract
contains "and notes the absence" "${bundle}/MANIFEST.txt" "no compose file in ${root}/nothing-here"

echo
echo "${passed} passed, ${failed} failed"
[ "$failed" -eq 0 ]
