#!/usr/bin/env bash
# Collect what the NexusPuppet API cannot see, into one archive for support.
#
#   sudo ./scripts/support-bundle.sh                          # last 24h, /opt/nexuspuppet
#   sudo ./scripts/support-bundle.sh --since 72h \
#        --include ~/nexuspuppet-support-abc123-20260930T120000Z.tar.gz
#
# THE OTHER HALF OF ADR-0028. The console's Settings > General > Support bundle
# downloads the API's own logs, status and configuration. It cannot include
# container logs, Docker's view of the stack, systemd timers or journald — and
# must not be able to: reading those from inside the API would mean handing it
# the Docker socket, which is root on the host (ADR-0013). So they are
# collected here, by a person who already has that access, and --include folds
# the console's archive in so support receives ONE file.
#
# Works on the console VM and on a Puppet server that runs only the sync and
# receipts timers: a section with nothing to collect is noted, not fatal.
#
# SECRETS. Nothing here runs `docker compose config` or `docker inspect` in full
# — both print the environment with every secret expanded. `.env` is passed
# through an allow-list: known configuration keys keep their values, anything
# that looks like a credential becomes <set>/<unset>, and anything else is
# withheld. Every collected file is then searched for the literal values of
# those secrets, and for private keys, URL credentials, JWTs and email
# addresses, which are masked. The counts are in MANIFEST.txt.
#
# Needs root, or membership of the docker group (and systemd-journal or adm for
# the journal). It says what it could not read rather than failing.
#
# Requires bash, tar, gzip and perl — all present on a stock Ubuntu or Debian
# host. No Python, no Node.

set -u
umask 077

VERSION=1
SINCE=24h
DIR=/opt/nexuspuppet
OUTPUT=.
INCLUDE=
PROJECT=

usage() {
    cat <<'EOF'
Usage: support-bundle.sh [options]

Collect NexusPuppet's container, Docker, systemd and host state into one
.tar.gz for support. Secrets are masked before anything is archived.

Options:
  --since <N>{m|h|d}   How far back to collect logs (default 24h).
  --dir <path>         The Compose project directory (default /opt/nexuspuppet).
                       Absent is fine on a Puppet server with only the timers.
  --project <name>     Compose project name, if not the directory's default.
  --output <dir>       Where to write the archive (default: current directory).
  --include <file>     A support bundle downloaded from the console
                       (Settings > General > Support bundle). Embedded as-is, so
                       support receives one file.
  -h, --help           Show this help.

Run as root, or as a member of the docker group. Without that, Docker sections
are skipped and the archive says so.

Nothing is sent anywhere. Inspect the archive before you share it:
  tar -tzf nexuspuppet-host-support-*.tar.gz
EOF
}

die() {
    echo "support-bundle: $*" >&2
    exit 2
}

need_value() {
    if [ $# -lt 2 ] || [ -z "$2" ]; then
        die "$1 needs a value (see --help)"
    fi
}

while [ $# -gt 0 ]; do
    case "$1" in
        -h | --help)
            usage
            exit 0
            ;;
        --since)
            need_value "$@"
            SINCE="$2"
            shift 2
            ;;
        --since=*) SINCE="${1#*=}"; shift ;;
        --dir)
            need_value "$@"
            DIR="$2"
            shift 2
            ;;
        --dir=*) DIR="${1#*=}"; shift ;;
        --project)
            need_value "$@"
            PROJECT="$2"
            shift 2
            ;;
        --project=*) PROJECT="${1#*=}"; shift ;;
        --output)
            need_value "$@"
            OUTPUT="$2"
            shift 2
            ;;
        --output=*) OUTPUT="${1#*=}"; shift ;;
        --include)
            need_value "$@"
            INCLUDE="$2"
            shift 2
            ;;
        --include=*) INCLUDE="${1#*=}"; shift ;;
        *) die "unknown option: $1 (see --help)" ;;
    esac
done

# ---------------------------------------------------------------------------
# The window. One relative span, translated for each consumer: Docker takes a
# Go duration (no days), journalctl a systemd time span with a leading minus.
# ---------------------------------------------------------------------------
case "$SINCE" in
    *[!0-9mhd]* | '' | [mhd]*) die "--since must look like 30m, 24h or 3d (got '$SINCE')" ;;
esac
since_number="${SINCE%[mhd]}"
since_unit="${SINCE#"$since_number"}"
case "$since_number" in
    '' | *[!0-9]*) die "--since must look like 30m, 24h or 3d (got '$SINCE')" ;;
esac
case "$since_unit" in
    m) docker_since="${since_number}m" ;;
    h) docker_since="${since_number}h" ;;
    d) docker_since="$((since_number * 24))h" ;;
    *) die "--since must end in m, h or d (got '$SINCE')" ;;
esac
journal_since="-${since_number}${since_unit/m/min}"

[ -z "$INCLUDE" ] || [ -f "$INCLUDE" ] || die "--include: no such file: $INCLUDE"
[ -d "$OUTPUT" ] || die "--output: no such directory: $OUTPUT"
command -v perl >/dev/null 2>&1 || die "perl is required for redaction and was not found"
command -v tar >/dev/null 2>&1 || die "tar is required and was not found"

HOST=$(hostname 2>/dev/null || echo unknown)
HOST_SAFE=$(printf '%s' "$HOST" | tr -c 'A-Za-z0-9.-' '_')
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NAME="nexuspuppet-host-support-${HOST_SAFE}-${STAMP}"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/nexuspuppet-support.XXXXXX") || die "cannot create a work directory"
trap 'rm -rf "$WORK"' EXIT
ROOT="$WORK/$NAME"
SECRETS="$WORK/secrets.tsv" # never archived: it holds the values being masked
mkdir -p "$ROOT"
: >"$SECRETS"
LOG="$ROOT/collection.log"
: >"$LOG"

note() {
    printf '%s\n' "$*" >>"$LOG"
}

# run <file> <command...> — capture stdout and stderr, record the exit status.
# Never fatal: one section failing must not cost the others.
run() {
    out="$ROOT/$1"
    shift
    mkdir -p "$(dirname "$out")"
    # `timeout` execs a binary, so a shell function (compose) runs without it.
    if [ "$(type -t "$1")" != function ] && command -v timeout >/dev/null 2>&1; then
        timeout 120 "$@" >"$out" 2>&1
    else
        "$@" >"$out" 2>&1
    fi
    status=$?
    note "exit=${status} ${1##*/} ${*:2} -> ${out#"$ROOT"/}"
    return 0
}

# ---------------------------------------------------------------------------
# Privilege. Said up front, on the terminal AND in the archive.
# ---------------------------------------------------------------------------
IS_ROOT=0
[ "$(id -u)" = 0 ] && IS_ROOT=1
DOCKER_OK=0
if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
        DOCKER_OK=1
    else
        echo "support-bundle: cannot talk to Docker as $(id -un). Run with sudo, or as a member of the" >&2
        echo "  docker group. Docker and container sections will be skipped." >&2
        note "docker: present but not accessible as $(id -un) — run as root or join the docker group"
    fi
else
    note "docker: not installed on this host"
fi
if [ "$IS_ROOT" = 0 ] && ! id -nG | tr ' ' '\n' | grep -qxE 'systemd-journal|adm'; then
    echo "support-bundle: not root and not in systemd-journal/adm — the journal will show only this user's entries." >&2
    note "journal: not root and not in systemd-journal/adm; system units' entries may be missing"
fi

# ---------------------------------------------------------------------------
# .env, through an allow-list (never a deny-list: an unknown key is withheld).
# ---------------------------------------------------------------------------
NON_SECRET_KEYS=" NODE_ENV API_PORT LOG_LEVEL LOG_DIR LOG_FILE_MAX_BYTES LOG_FILE_KEEP SETTINGS_SOURCE
ACCESS_TOKEN_TTL AUTH_LOGIN_FLOOR_MS REFRESH_TOKEN_TTL LOGIN_MAX_FAILED_ATTEMPTS LOGIN_LOCKOUT_MINUTES
AUDIT_RETENTION_DAYS AUDIT_RETENTION_MAX_ROWS AUDIT_RETENTION_INTERVAL_MS AUDIT_RETENTION_BATCH_SIZE
AUDIT_RETENTION_MAX_BATCHES PUPPETDB_URL PUPPETDB_CERT_PATH PUPPETDB_KEY_PATH PUPPETDB_CA_PATH
PUPPETDB_TIMEOUT_MS PUPPETSERVER_URL PUPPETSERVER_CERT_PATH PUPPETSERVER_KEY_PATH PUPPETSERVER_CA_PATH
PUPPETSERVER_TIMEOUT_MS PUPPETSERVER_CLASS_CACHE_TTL_MS PUPPETSERVER_DEFAULT_ENVIRONMENT
PUPPETDB_PROJECTED_FACTS PUPPETDB_PROJECTION_INTERVAL_MS PUPPETDB_POLL_INTERVAL_MS PUPPETDB_POLL_OVERLAP_MS
NOTIFICATION_EVALUATION_INTERVAL_MS ENC_OUTPUT_DIR ENC_REPLICATION_ENABLED ENC_REPLICATION_PORT
ENC_REPLICATION_BIND ENC_REPLICATION_ALLOWED_CERTNAMES ENC_REPLICATION_CERT_PATH ENC_REPLICATION_KEY_PATH
ENC_REPLICATION_CA_PATH CONSOLE_TLS_CERT_PATH CONSOLE_HOSTNAME ENC_DEFAULT_ENVIRONMENT
ENC_MATERIALIZER_INTERVAL_MS ENC_RECONCILE_INTERVAL_MS ENC_MAX_JOB_ATTEMPTS ENC_MATERIALIZER_BATCH_SIZE
ENC_MATERIALIZER_RECONCILE_CHUNK ENC_MATERIALIZER_BATCH_DELAY_MS ENC_MATERIALIZER_MAX_DRAIN_MS
NEXUSPUPPET_VERSION LDAP_URL LDAP_BIND_DN LDAP_CA_PATH LDAP_DIALECT LDAP_GROUP_SEARCH_BASE
LDAP_NESTED_GROUPS LDAP_ROLE_MAPPINGS LDAP_SEARCH_BASE LDAP_SEARCH_FILTER LDAP_TIMEOUT_MS
LDAP_TLS_REJECT_UNAUTHORIZED OIDC_ISSUER OIDC_CLIENT_ID OIDC_REDIRECT_URI OIDC_SCOPES OIDC_DEFAULT_ROLE
OIDC_ROLE_MAPPINGS OIDC_GROUPS_CLAIM OIDC_EMAIL_CLAIM OIDC_DISPLAY_NAME_CLAIM OIDC_CLOCK_SKEW_SECONDS
OIDC_TIMEOUT_MS AUDIT_EXPORT_CA_PATH AUDIT_EXPORT_TIMEOUT_MS AUDIT_EXPORT_ENTITY_TYPES POSTGRES_USER
POSTGRES_DB API_BIND WEB_BIND WEB_PORT HTTP_PORT HTTPS_PORT API_INTERNAL_URL CONSOLE_TLS_DIR
PUPPETDB_CERT_DIR PUPPETSERVER_HOST_ALIAS BUILD_REF NEXUSPUPPET_ENTERPRISE_REF COMPOSE_PROJECT_NAME
COMPOSE_FILE COMPOSE_PROFILES EDITION TZ NEXUSPUPPET_SYNC_URL NEXUSPUPPET_SYNC_SSL_DIR
NEXUSPUPPET_SYNC_STATE_DIR NEXUSPUPPET_SYNC_RECEIPTS_DIR NEXUSPUPPET_RECEIPTS_URL NEXUSPUPPET_RECEIPTS_DIR
NEXUSPUPPET_RECEIPTS_GROUP NEXUSPUPPET_ENC_DIR "

# Identities and credential-shaped names. Also: any key not on the list above.
looks_secret() {
    case "$1" in
        *_PATH | *_DIR | *_FILE | *_TTL | *_MS | *_SECONDS | *_MINUTES) return 1 ;;
        *PASSWORD* | *PASSWD* | *SECRET* | *TOKEN* | *CREDENTIAL* | *PRIVATE* | *API_KEY* | *APIKEY*) return 0 ;;
        *_KEY | KEY | *_PASS | *DATABASE_URL | BOOTSTRAP_ADMIN_EMAIL | NEXUSPUPPET_ENTERPRISE_REPO | AUDIT_EXPORT_URL) return 0 ;;
    esac
    return 1
}

# filter_env <source> <dest> — write the allow-listed view, and remember every
# secret-shaped value so it can be masked wherever else it appears.
filter_env() {
    src="$1"
    dest="$ROOT/$2"
    mkdir -p "$(dirname "$dest")"
    {
        echo "# ${src}, filtered through an allow-list. Secrets: <set>/<unset>. Unknown keys: withheld."
        while IFS= read -r line || [ -n "$line" ]; do
            line="${line#"${line%%[![:space:]]*}"}"
            case "$line" in '' | '#'*) continue ;; esac
            line="${line#export }"
            key="${line%%=*}"
            [ "$key" = "$line" ] && continue
            value="${line#*=}"
            # One layer of matching quotes, as Compose and systemd read it.
            case "$value" in
                \"*\") value="${value#\"}"; value="${value%\"}" ;;
                \'*\') value="${value#\'}"; value="${value%\'}" ;;
            esac
            if looks_secret "$key"; then
                if [ -n "$value" ]; then
                    echo "${key}=<set>"
                    printf '%s\t%s\n' "$key" "$value" >>"$SECRETS"
                    # The password inside a URL, e.g. DATABASE_URL.
                    pw=$(printf '%s' "$value" | sed -n 's#^[A-Za-z][A-Za-z0-9+.-]*://[^:/@]*:\([^@]*\)@.*#\1#p')
                    [ -z "$pw" ] || printf '%s\t%s\n' "${key}.password" "$pw" >>"$SECRETS"
                else
                    echo "${key}=<unset>"
                fi
            elif case "$NON_SECRET_KEYS" in *[[:space:]]"$key"[[:space:]]*) true ;; *) false ;; esac; then
                echo "${key}=${value}"
                # A URL shown in full can still carry user:password@. The
                # structural rule masks it here; remembering the password as
                # a literal masks it anywhere else it turns up, as the API does.
                pw=$(printf '%s' "$value" | sed -n 's#^[A-Za-z][A-Za-z0-9+.-]*://[^:/@]*:\([^@]*\)@.*#\1#p')
                [ -z "$pw" ] || printf '%s\t%s\n' "${key}.password" "$pw" >>"$SECRETS"
            else
                echo "${key}=<withheld: not on the allow-list>"
            fi
        done <"$src"
    } >"$dest"
    note "filtered ${src} -> ${dest#"$ROOT"/}"
}

if [ -f "$DIR/.env" ]; then
    if [ -r "$DIR/.env" ]; then
        filter_env "$DIR/.env" config/env.txt
    else
        note "config: $DIR/.env exists but is not readable as $(id -un)"
    fi
else
    note "config: no .env in $DIR"
fi
for conf in /etc/default/nexuspuppet-sync /etc/default/nexuspuppet-receipts; do
    if [ -r "$conf" ]; then
        filter_env "$conf" "config/$(basename "$conf").txt"
    fi
done

# ---------------------------------------------------------------------------
# The host.
# ---------------------------------------------------------------------------
run host/uname.txt uname -a
run host/os-release.txt cat /etc/os-release
run host/uptime.txt uptime
run host/df.txt df -h
command -v free >/dev/null 2>&1 && run host/free.txt free -m
command -v timedatectl >/dev/null 2>&1 && run host/timedatectl.txt timedatectl
{
    echo "utc:   $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "local: $(date '+%Y-%m-%dT%H:%M:%S%z')"
} >"$ROOT/host/date.txt"

# ---------------------------------------------------------------------------
# Git: which code is this, exactly.
# ---------------------------------------------------------------------------
# -e, not -d: in a git worktree `.git` is a file pointing at the real one.
if [ -e "$DIR/.git" ] && command -v git >/dev/null 2>&1; then
    # safe.directory: run as root against a checkout owned by somebody else,
    # git refuses outright; this is a read.
    run git/describe.txt git -c safe.directory="$DIR" -C "$DIR" describe --tags --always --dirty
    run git/head.txt git -c safe.directory="$DIR" -C "$DIR" log -1 --format='%H %cI %s'
    run git/status.txt git -c safe.directory="$DIR" -C "$DIR" status --short
else
    note "git: $DIR is not a git checkout (or git is absent)"
fi

# ---------------------------------------------------------------------------
# Docker and Compose. Never `compose config`, never a full `docker inspect`.
# ---------------------------------------------------------------------------
compose() {
    if [ -n "$PROJECT" ]; then
        (cd "$DIR" && docker compose -p "$PROJECT" "$@")
    else
        (cd "$DIR" && docker compose "$@")
    fi
}

if [ "$DOCKER_OK" = 1 ]; then
    run docker/version.txt docker version
    # Summary fields only: the full output lists proxies, which can carry
    # credentials, and registry configuration nobody needs here.
    run docker/info.txt docker info --format \
        'ServerVersion={{.ServerVersion}} StorageDriver={{.Driver}} LoggingDriver={{.LoggingDriver}} CgroupDriver={{.CgroupDriver}} CgroupVersion={{.CgroupVersion}} Kernel={{.KernelVersion}} OS={{.OperatingSystem}} Arch={{.Architecture}} CPUs={{.NCPU}} Memory={{.MemTotal}} Containers={{.Containers}} Running={{.ContainersRunning}} Stopped={{.ContainersStopped}} Images={{.Images}} DockerRootDir={{.DockerRootDir}}'
    run docker/system-df.txt docker system df

    if [ -f "$DIR/docker-compose.yml" ] || [ -f "$DIR/compose.yml" ] || [ -f "$DIR/compose.yaml" ]; then
        run compose/ps.txt compose ps -a
        run compose/images.txt compose images

        services=$(compose ps -a --format '{{.Service}}' 2>/dev/null | sort -u)
        if [ -z "$services" ]; then
            note "compose: no containers found for the project in $DIR"
        fi
        mkdir -p "$ROOT/compose/logs"
        : >"$ROOT/compose/containers.txt"
        for service in $services; do
            drivers=""
            for id in $(compose ps -a -q "$service" 2>/dev/null); do
                # State, restarts, image and log driver. NOT .Config.Env.
                docker inspect --format \
                    '{{.Name}} service='"$service"' status={{.State.Status}} restarts={{.RestartCount}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} image={{.Image}} logdriver={{.HostConfig.LogConfig.Type}}' \
                    "$id" >>"$ROOT/compose/containers.txt" 2>&1
                drivers="$drivers $(docker inspect --format '{{.HostConfig.LogConfig.Type}}' "$id" 2>/dev/null)"
            done
            case "$drivers" in
                *syslog* | *gelf* | *fluentd* | *awslogs* | *splunk* | *none*)
                    # These drivers do not keep a local copy docker can read
                    # back. An empty file would read as "the service was quiet".
                    echo "Log driver for ${service} is${drivers}: Docker keeps no readable copy." \
                        "Collect these lines from your log collector (see docker-compose.syslog.example.yml)." \
                        >"$ROOT/compose/logs/${service}.NOT-COLLECTED.txt"
                    note "logs: ${service} uses${drivers}; not readable through docker"
                    ;;
                *)
                    run "compose/logs/${service}.log" compose logs --no-color --timestamps --since "$docker_since" "$service"
                    ;;
            esac
        done
    else
        note "compose: no compose file in $DIR — collecting host and systemd state only"
    fi
fi

# ---------------------------------------------------------------------------
# systemd: the sync and receipts timers (Puppet server), and Docker itself.
# ---------------------------------------------------------------------------
if command -v systemctl >/dev/null 2>&1; then
    units=$(systemctl list-unit-files 'nexuspuppet-*' --no-legend 2>/dev/null | awk '{print $1}')
    run systemd/timers.txt systemctl list-timers --all 'nexuspuppet-*'
    if [ -n "$units" ]; then
        # shellcheck disable=SC2086 # one argument per unit, deliberately
        run systemd/status.txt systemctl status --no-pager --full $units
    else
        note "systemd: no nexuspuppet-* units on this host"
    fi
    if command -v journalctl >/dev/null 2>&1; then
        if [ -n "$units" ]; then
            run systemd/journal-nexuspuppet.log journalctl --no-pager -o short-iso-precise --since "$journal_since" -u 'nexuspuppet-*'
        fi
        run systemd/journal-docker.log journalctl --no-pager -o short-iso-precise --since "$journal_since" -u docker.service
    fi
    for state in /var/lib/nexuspuppet-sync /etc/puppetlabs/nexuspuppet; do
        [ -d "$state" ] && run "systemd/ls$(printf '%s' "$state" | tr '/' '_').txt" ls -la "$state"
    done
else
    note "systemd: systemctl not available"
fi

# ---------------------------------------------------------------------------
# Redaction. Every collected text file, line by line, in place — so a large log
# is streamed rather than held in memory. The same rules as the API's pass
# (apps/api/src/support/pure/redaction.ts), in the same order: literal secret
# values first, longest first, then private keys, URL credentials, JWTs and
# email addresses. A private key's body lines are dropped, not just its header.
# ---------------------------------------------------------------------------
# shellcheck disable=SC2016 # a perl program, single-quoted on purpose
REDACT_PL='
    BEGIN {
        open(my $fh, "<", $ENV{SECRETS_FILE}) or die "secrets: $!";
        while (my $l = <$fh>) {
            chomp $l;
            my ($n, $v) = split(/\t/, $l, 2);
            next unless defined $v && length($v) >= 6;
            push @s, [$n, $v];
        }
        @s = sort { length($b->[1]) <=> length($a->[1]) or $a->[0] cmp $b->[0] } @s;
        %c = map { $_ => 0 } qw(secret-value pem-private-key url-credentials jwt email);
    }
    for my $p (@s) { my ($n, $v) = @$p; $c{"secret-value"} += s/\Q$v\E/[REDACTED:$n]/g; }
    if ($inpem) {
        $inpem = 0 if /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
        next;
    }
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/) {
        $c{"pem-private-key"}++;
        $inpem = 1 unless /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
        s/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*/[REDACTED:PEM-PRIVATE-KEY]/;
    }
    $c{"url-credentials"} += s{\b([a-z][a-z0-9+.-]*://)(?!\[REDACTED:URL-CREDENTIALS\]@)[^\s/@"\x27<>]+@}{$1\[REDACTED:URL-CREDENTIALS\]@}gi;
    $c{"jwt"} += s/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/[REDACTED:JWT]/g;
    $c{"email"} += s/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/[REDACTED:EMAIL]/g;
    print;
    END {
        open(my $o, ">>", $ENV{COUNTS_FILE}) or die "counts: $!";
        print $o join(" ", $ENV{REL}, map { "$_=$c{$_}" } sort keys %c), "\n";
    }
'

redact_file() {
    SECRETS_FILE="$SECRETS" COUNTS_FILE="$REDACTIONS" REL="${1#"$ROOT"/}" \
        perl -i -ne "$REDACT_PL" "$1"
}

REDACTIONS="$WORK/redactions.txt"
: >"$REDACTIONS"
while IFS= read -r -d '' file; do
    if ! redact_file "$file"; then
        # perl -i leaves the ORIGINAL in place when it fails, and the original
        # is unredacted. Removing it is the only safe outcome.
        rm -f "$file"
        note "redaction FAILED for ${file#"$ROOT"/} — the file was removed, not archived"
    fi
done < <(find "$ROOT" -type f ! -name collection.log -print0)

# ---------------------------------------------------------------------------
# The console's own bundle, embedded untouched: it was redacted by the API and
# re-writing a compressed archive here would only risk corrupting it.
# ---------------------------------------------------------------------------
if [ -n "$INCLUDE" ]; then
    mkdir -p "$ROOT/api-bundle"
    if tar -tzf "$INCLUDE" >"$ROOT/api-bundle/listing.txt" 2>&1; then
        cp "$INCLUDE" "$ROOT/api-bundle/$(basename "$INCLUDE")"
        note "include: embedded $(basename "$INCLUDE")"
    else
        note "include: $INCLUDE is not a readable .tar.gz — NOT embedded"
        echo "support-bundle: --include $INCLUDE is not a readable .tar.gz; continuing without it." >&2
    fi
fi

# ---------------------------------------------------------------------------
# The manifest, then the archive.
# ---------------------------------------------------------------------------
totals=$(awk '{ for (i = 2; i <= NF; i++) { split($i, kv, "="); t[kv[1]] += kv[2] } }
    END { for (k in t) printf "%s=%d ", k, t[k] }' "$REDACTIONS")
{
    echo "NexusPuppet host support bundle (format ${VERSION})"
    echo
    echo "Host:       ${HOST}"
    echo "Generated:  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "Since:      ${SINCE} (docker --since ${docker_since}, journalctl --since ${journal_since})"
    echo "Project:    ${DIR}${PROJECT:+ (project ${PROJECT})}"
    echo "Run as:     $(id -un) (root=${IS_ROOT}, docker access=${DOCKER_OK})"
    echo "API bundle: ${INCLUDE:-not included — download it from Settings > General > Support bundle}"
    echo
    echo "Redactions: ${totals:-none}"
    echo "Per file:"
    awk '{ nonzero = 0; for (i = 2; i <= NF; i++) { split($i, kv, "="); if (kv[2] > 0) nonzero = 1 } if (nonzero) print "  " $0 }' "$REDACTIONS"
    echo "Secret names searched for: $(cut -f1 "$SECRETS" | sort -u | tr '\n' ' ')"
    echo
    echo "Deliberately NOT collected: 'docker compose config' and full 'docker inspect'"
    echo "(both expand every secret), .env values not on the allow-list, private keys,"
    echo "certificates, ENC node documents, and the database itself."
    echo
    echo "What was run, and what could not be:"
    sed 's/^/  /' "$LOG"
} >"$ROOT/MANIFEST.txt"

ARCHIVE="$OUTPUT/$NAME.tar.gz"
if tar -C "$WORK" -czf "$ARCHIVE" "$NAME"; then
    echo "$ARCHIVE"
    echo "Inspect it before sharing: tar -tzf '$ARCHIVE'" >&2
else
    die "could not write $ARCHIVE"
fi
