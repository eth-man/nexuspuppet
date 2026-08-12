#!/usr/bin/env bash
# Deploy NexusPuppet. One command, first install or upgrade.
#
#   ./scripts/deploy.sh --puppetdb https://puppetdb.example.com:8081   # first run
#   ./scripts/deploy.sh                                                # every run after
#
#   --certs <dir>   where client.pem/client.key/ca.pem live (default ./certs,
#                   or /etc/nexuspuppet/certs if that is where they already are)
#   --check         run the preflight checks and stop. Answers "will this work?"
#                   before anything is built, and names the fix when it will not.
#                   NOTE: on a first run it writes .env first, because the checks
#                   read the URL and certificate paths from it. So the generated
#                   admin password is printed by that run, not by the deploy that
#                   follows — every later run reports where to find it instead.
#   --tls <hostname>  publish the console on 443 with TLS, using a certificate
#                   Caddy issues itself. The console stays on loopback behind
#                   it. Browsers warn (that CA is not in their trust store);
#                   the traffic is genuinely encrypted, which cleartext on
#                   0.0.0.0 is not.
#   --skip-preflight  deploy without checking. For automated environments that
#                   deliberately have no real PuppetDB — CI uses it, after
#                   asserting that --check REFUSES that same environment.
#
# WHY THIS EXISTS. DEPLOYMENT.md is a reference — it explains why each decision
# is what it is, which is what you want at 2am and not what you want on a fresh
# server. The sequence underneath all that prose is short, and this is it.
#
# It is also the UPGRADE command. Re-running keeps your .env, rebuilds, migrates
# and restarts — the same three steps, in the order that matters.
#
# CI runs this script to prove the install path, so what you run here is what is
# tested on every commit. If it drifts from the documentation, the documentation
# is describing something nobody exercises.

set -euo pipefail
cd "$(dirname "$0")/.."

PUPPETDB_URL=""
ADMIN_EMAIL="admin@example.com"
CERT_DIR_ARG=""
CHECK_ONLY=""
SKIP_PREFLIGHT=""
TLS_HOSTNAME=""

# Where DEPLOYMENT.md §3 tells operators to install the certificates. The
# .env.example default is ./certs, and those two disagreeing is a real trap:
# somebody follows the guide, puts the files in /etc, and the script says there
# is no certificate in ./certs.
GUIDE_CERT_DIR="/etc/nexuspuppet/certs"

# Kept before the parse loop consumes them, so a "re-run with sudo" suggestion
# can repeat what the operator actually typed. Suggesting a bare `sudo deploy.sh`
# to somebody who ran `--check` would tell them to deploy.
INVOCATION="$0${*:+ $*}"

while [ $# -gt 0 ]; do
    case "$1" in
        --puppetdb) PUPPETDB_URL="${2:-}"; shift 2 ;;
        --admin-email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
        --certs) CERT_DIR_ARG="${2:-}"; shift 2 ;;
        --check) CHECK_ONLY=yes; shift ;;
        --tls) TLS_HOSTNAME="${2:-}"; shift 2 ;;
        --skip-preflight) SKIP_PREFLIGHT=yes; shift ;;
        -h | --help)
            sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "Docker is not installed. See DEPLOYMENT.md §0."
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing. See DEPLOYMENT.md §0."

# ---------------------------------------------------------------------------
# Configure, but only once.
#
# An existing .env is never touched. It holds generated secrets and an operator's
# site configuration, and regenerating JWT_SECRET on an upgrade would sign every
# user out; regenerating POSTGRES_PASSWORD would lock the application out of its
# own database.
# ---------------------------------------------------------------------------
if [ -f .env ]; then
    step "Using the existing .env (upgrade)"
    [ -n "$PUPPETDB_URL" ] && echo "    --puppetdb ignored: .env already exists; edit it directly to change the URL."
else
    # An existing database with no .env is the one combination that produces a
    # baffling failure: Postgres only honours POSTGRES_PASSWORD when it
    # initialises an empty data directory, so a freshly generated password
    # cannot open a database that already exists. The symptom is
    # "Authentication failed against database server" during the migration,
    # which reads as a bug rather than as "your secrets and your data have been
    # separated".
    project="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
    if docker volume ls --format '{{.Name}}' | grep -qx "${project}_db-data"; then
        die "There is already a database (docker volume ${project}_db-data) but no .env.

       Generating new secrets now would lock the application out of its own
       data, because Postgres set that password when the volume was created.

       Either restore the .env that goes with it, or, if the data is
       disposable:  docker compose down -v"
    fi

    [ -n "$PUPPETDB_URL" ] || die "First run needs --puppetdb https://<your-puppetdb>:8081
       That host must be reachable on 8081 and must trust the certificate below.
       No PuppetDB yet? DEPLOYMENT.md Appendix A installs OpenVoxDB in ten minutes."

    step "Writing .env"
    cp .env.example .env
    chmod 600 .env

    set_env() {
        if grep -qE "^${1}=" .env; then
            # `|` as the delimiter: URLs contain slashes.
            sed -i "s|^${1}=.*|${1}=${2}|" .env
        else
            printf '%s=%s\n' "$1" "$2" >>.env
        fi
    }

    # openssl, not $RANDOM. These are the credentials protecting the console.
    ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '\n/+=')"
    set_env NODE_ENV production
    set_env POSTGRES_PASSWORD "$(openssl rand -base64 24 | tr -d '\n/+=')"
    set_env JWT_SECRET "$(openssl rand -hex 32)"
    set_env BOOTSTRAP_ADMIN_EMAIL "$ADMIN_EMAIL"
    set_env BOOTSTRAP_ADMIN_PASSWORD "$ADMIN_PASSWORD"
    set_env PUPPETDB_URL "$PUPPETDB_URL"

    # --certs wins; otherwise, if the guide's location holds a full set and the
    # default does not, use the guide's. An operator who followed the
    # documentation should not have to discover that the script disagreed with
    # it.
    if [ -n "$CERT_DIR_ARG" ]; then
        set_env PUPPETDB_CERT_DIR "$CERT_DIR_ARG"
    elif [ ! -f ./certs/client.pem ] && [ -f "${GUIDE_CERT_DIR}/client.pem" ]; then
        set_env PUPPETDB_CERT_DIR "$GUIDE_CERT_DIR"
        echo "    certificates found in ${GUIDE_CERT_DIR}; using those"
    fi

    echo "    secrets generated; .env is 0600"
    # SAID HERE AS WELL AS AT THE END. If any later step fails — a preflight
    # check, a build, a migration — the summary never runs, and the operator is
    # left with a generated password they have never seen and no idea one
    # exists. That happened on a real install.
    echo "    first-login password is BOOTSTRAP_ADMIN_PASSWORD in .env"
fi

# ---------------------------------------------------------------------------
# The certificate check, before anything expensive.
#
# A missing client certificate is the most common first-install failure, and its
# symptom without this check is a console that starts perfectly and shows an
# empty estate — which reads as "the product does not work" rather than "it
# cannot authenticate to PuppetDB".
# ---------------------------------------------------------------------------
CERT_DIR="$(grep -E '^PUPPETDB_CERT_DIR=' .env | cut -d= -f2- || true)"
CERT_DIR="${CERT_DIR:-./certs}"

# UNREADABLE IS NOT MISSING, and saying so cost a real afternoon.
#
# DEPLOYMENT.md §3 tells operators to install the certificates 0500, owned by
# uid 100 — so the container can read them and nothing else can. That is
# correct, and it means a `[ -f ... ]` from an ordinary account cannot even
# traverse the directory: the test is false, and the script reported the
# certificate as MISSING.
#
# The operator is then sent to reissue a certificate that was perfectly good,
# on advice that cannot work, by a check that was looking at a directory it
# could not see. The fix it actually needs is `sudo`.
#
# `-d` succeeds on a directory this user cannot enter; `-x` is what says whether
# we may look inside. Both, in that order, so "no such directory" and "cannot
# look in it" stay distinct.
if [ -d "$CERT_DIR" ] && [ ! -x "$CERT_DIR" ]; then
    die "Cannot read ${CERT_DIR} as $(id -un) — the certificates may well be fine.

       That directory is deliberately 0500 and owned by the container's uid, so
       only root and the container may look inside it. This check cannot tell
       whether the files are there, and refuses to guess.

       Re-run with sudo:
         sudo ${INVOCATION}"
fi

if [ ! -f "${CERT_DIR}/client.pem" ] || [ ! -f "${CERT_DIR}/client.key" ] || [ ! -f "${CERT_DIR}/ca.pem" ]; then
    hint=""
    if [ -f "${GUIDE_CERT_DIR}/client.pem" ]; then
        # The exact case that produced this message for a real operator: files
        # present where the guide said to put them, and .env pointing elsewhere.
        hint="
       They ARE in ${GUIDE_CERT_DIR}. Point .env at them and re-run:
         sed -i 's|^PUPPETDB_CERT_DIR=.*|PUPPETDB_CERT_DIR=${GUIDE_CERT_DIR}|' .env
         ./scripts/deploy.sh
"
    fi
    die "No PuppetDB client certificate in ${CERT_DIR}.
${hint}
       Expected client.pem, client.key and ca.pem. On your Puppet server:

         puppetserver ca generate --certname <this-host-fqdn>

       Copy them across owned by uid 100 so the container can read them, and add
       that certname to PuppetDB's allowlist. Pass --certs <dir> to use a
       location other than ./certs. DEPLOYMENT.md §3 has the exact commands —
       including the allowlist, which is the step people miss."
fi


# ---------------------------------------------------------------------------
# Preflight.
#
# Every check here corresponds to a failure somebody has actually had, and each
# one names its fix. The two that matter most are invisible otherwise:
#
#   - a certificate the container cannot read starts the console perfectly and
#     shows an empty estate, which reads as "the product does not work"
#   - a certname missing from PuppetDB's allowlist returns 403, which reads as
#     a broken certificate
#
# Shell tools only, and every one optional. DEPLOYMENT.md §0 asks operators for
# Docker and nothing else, so a missing openssl must SKIP a check rather than
# fail a deployment.
# ---------------------------------------------------------------------------
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; PREFLIGHT_WARN=$((PREFLIGHT_WARN + 1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; PREFLIGHT_FAIL=$((PREFLIGHT_FAIL + 1)); }
note() { printf '      %s\n' "$*"; }

preflight() {
    PREFLIGHT_FAIL=0
    PREFLIGHT_WARN=0
    step "Preflight"

    # --- the certificate files -------------------------------------------
    if [ -f "${CERT_DIR}/client.pem" ] && [ -f "${CERT_DIR}/client.key" ] && [ -f "${CERT_DIR}/ca.pem" ]; then
        ok "certificate, key and CA present in ${CERT_DIR}"
    else
        bad "missing certificate files in ${CERT_DIR}"
        note "need client.pem, client.key and ca.pem — see DEPLOYMENT.md §3"
        return 1
    fi

    # --- readable by the container's uid ----------------------------------
    #
    # THE EMPTY-ESTATE BUG. The image runs as uid 100; root:root files are
    # unreadable to it and nothing says so except an inventory that never fills.
    if head -1 "${CERT_DIR}/client.key" 2>/dev/null | grep -qE "CERTIFICATE|PUBLIC KEY"; then
        bad "client.key is not a private key"
        note "it looks like the certificate or the public key. The private key is"
        note "  /etc/puppetlabs/puppet/ssl/private_keys/<certname>.pem"
    fi

    owner=$(stat -c '%u' "${CERT_DIR}/client.key" 2>/dev/null || echo unknown)
    if [ "$owner" = "100" ]; then
        ok "key is owned by uid 100, which the container runs as"
    else
        bad "key is owned by uid ${owner}, not 100"
        note "the container cannot read it, and the symptom is an EMPTY estate,"
        note "not an error. Fix:"
        note "  sudo chown 100 ${CERT_DIR}/client.key ${CERT_DIR}/client.pem ${CERT_DIR}/ca.pem"
    fi

    # --- what the certificate says ----------------------------------------
    if command -v openssl >/dev/null; then
        # SAME TRAP, ONE LEVEL DOWN. The directory check above catches a
        # directory this user cannot enter; a file inside a readable directory
        # can still be unreadable on its own (0400, owned by the container's
        # uid — which is exactly what §3 asks for the KEY, and what a cautious
        # operator sometimes does to the certificate too).
        #
        # openssl then fails, and every branch below would call a perfectly good
        # certificate malformed. Checked first so the message says the one thing
        # that is actually true.
        if [ ! -r "${CERT_DIR}/client.pem" ]; then
            bad "client.pem cannot be read by $(id -un)"
            note "the file is there; this account may not read it. That is not"
            note "necessarily wrong — the container reads it as uid 100, not you."
            note "To check it here, re-run with sudo."
        elif ! openssl x509 -in "${CERT_DIR}/client.pem" -noout >/dev/null 2>&1; then
            # Distinct from "expired": a truncated copy, a key pasted where the
            # certificate should be, or an HTML error page saved by mistake all
            # land here, and calling that an expiry sends somebody to re-issue a
            # certificate that was never the problem.
            # NAME THE LIKELY MISTAKE. Puppet keeps three files with the SAME
            # filename in three directories — certs/, public_keys/ and
            # private_keys/ — and only certs/ holds a certificate. Copying
            # <fqdn>.pem from the wrong one is the easiest error to make in the
            # whole install, and "not a readable X.509 certificate" does not
            # point at it.
            bad "client.pem is not an X.509 certificate"
            if head -1 "${CERT_DIR}/client.pem" 2>/dev/null | grep -q "PUBLIC KEY"; then
                note "it is a PUBLIC KEY. You copied it from public_keys/ —"
                note "the certificate is the same filename under certs/:"
                note "  /etc/puppetlabs/puppet/ssl/certs/<certname>.pem"
            elif head -1 "${CERT_DIR}/client.pem" 2>/dev/null | grep -q "PRIVATE KEY"; then
                note "it is a PRIVATE KEY. client.pem must be the certificate,"
                note "from /etc/puppetlabs/puppet/ssl/certs/<certname>.pem"
            else
                note "it may be truncated, or not a PEM file at all"
                note "check with: openssl x509 -in ${CERT_DIR}/client.pem -noout -subject"
            fi
            subject=""
        else
        subject=$(openssl x509 -in "${CERT_DIR}/client.pem" -noout -subject 2>/dev/null | sed 's/.*CN *= *//')
        if [ -n "$subject" ]; then
            ok "certname is ${subject}"
            note "this exact string must be in PuppetDB's allowlist, if you use one"
        fi
        if openssl x509 -in "${CERT_DIR}/client.pem" -noout -checkend 0 >/dev/null 2>&1; then
            expiry=$(openssl x509 -in "${CERT_DIR}/client.pem" -noout -enddate 2>/dev/null | cut -d= -f2)
            ok "certificate is valid (expires ${expiry})"
        else
            bad "certificate has EXPIRED"
            note "re-issue it: puppetserver ca generate --certname ${subject:-<fqdn>}"
        fi
        fi
    else
        warn "openssl not installed — skipped certificate inspection"
    fi

    # --- can we actually talk to PuppetDB? --------------------------------
    url=$(grep -E '^PUPPETDB_URL=' .env | cut -d= -f2- || true)

    # CHECK THE SCHEME BEFORE CONNECTING. A URL with no scheme makes curl
    # default to http://, which on PuppetDB's TLS port returns binary and the
    # error `curl: (1) Received HTTP/0.9 when not allowed`. That message is
    # accurate and tells an operator nothing — it reads as a protocol bug, and
    # the cause is six missing characters. Reported from a real install where
    # openssl and telnet both passed, which is exactly the confusion it creates.
    case "$url" in
        "") : ;;
        https://*) : ;;
        http://*)
            bad "PUPPETDB_URL uses http:// — PuppetDB speaks TLS on 8081"
            note "change it to https:// in .env. Plain HTTP is only ever served"
            note "on 8080, which is localhost-only and cannot be used from here."
            url=""
            ;;
        *)
            bad "PUPPETDB_URL has no scheme: ${url}"
            note "it must begin with https:// — without one, curl assumes http://"
            note "and the failure reads as 'Received HTTP/0.9', which is a TLS"
            note "port answering a plaintext request."
            note "  PUPPETDB_URL=https://${url}"
            url=""
            ;;
    esac

    if [ -z "$url" ]; then
        [ -n "$(grep -E '^PUPPETDB_URL=' .env | cut -d= -f2- || true)" ] || \
            warn "PUPPETDB_URL is not set in .env"
    elif ! command -v curl >/dev/null; then
        warn "curl not installed — skipped the PuppetDB probe"
    else
        # No `|| echo 000` — curl already writes 000 through -w when it cannot
        # connect, and the fallback appended a second one, producing "000000"
        # and a case label that never matched.
        # KEEP curl's stderr. Discarding it collapsed "the CA is wrong", "the
        # name is not on the certificate" and "nothing is listening" into one
        # useless verdict — and the first two are what an operator hits once the
        # port is open, which is when they most need telling apart.
        curl_err="$(mktemp)"
        code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
            --cert "${CERT_DIR}/client.pem" --key "${CERT_DIR}/client.key" \
            --cacert "${CERT_DIR}/ca.pem" "${url}/pdb/query/v4/nodes?limit=1" 2>"$curl_err") || true
        [ -n "$code" ] || code=000
        case "$code" in
            200)
                ok "PuppetDB answered 200 — the certificate is accepted"
                ;;
            403)
                # The single most misread failure in this product.
                bad "PuppetDB answered 403 — the certificate is valid but NOT PERMITTED"
                note "this is the allowlist, not a broken certificate. On the Puppet server:"
                note "  echo '${subject:-<certname>}' >> /etc/puppetlabs/puppetdb/certificate-whitelist"
                note "  systemctl restart puppetdb"
                ;;
            000)
                # Name the failure from what curl said, rather than listing
                # every possibility and leaving the operator to guess.
                detail="$(head -1 "$curl_err" 2>/dev/null)"
                case "$detail" in
                    *"unable to get local issuer"* | *"self-signed certificate"* | *"self signed certificate"*)
                        bad "TLS refused: ca.pem did not sign PuppetDB's certificate"
                        note "the port is open and TLS started — this is the WRONG CA file."
                        note "copy it from the Puppet server:"
                        note "  /etc/puppetlabs/puppet/ssl/certs/ca.pem"
                        note "not PuppetDB's own /etc/puppetlabs/puppetdb/ssl/ca.pem, which"
                        note "may differ if that host was ever re-issued"
                        ;;
                    *"subject name"* | *"subjectAltName"* | *"doesn't match"*)
                        bad "TLS refused: ${url} is not a name on PuppetDB's certificate"
                        note "the port is open and TLS started — the NAME is wrong."
                        note "use the certname the server presents, not an IP or an alias:"
                        note "  openssl s_client -connect <host>:8081 </dev/null 2>/dev/null \\"
                        note "    | openssl x509 -noout -subject -ext subjectAltName"
                        ;;
                    *"Connection refused"* | *"Failed to connect"* | *"timed out"* | *"Could not resolve"*)
                        bad "could not connect to ${url}"
                        note "${detail}"
                        note "check DNS from THIS host, and any firewall between it and 8081"
                        ;;
                    *)
                        bad "could not reach PuppetDB at ${url}"
                        [ -n "$detail" ] && note "${detail}"
                        note "the URL must name what the server certificate carries — an IP"
                        note "fails verification unless the certificate has an IP SAN"
                        ;;
                esac
                ;;
            *)
                warn "PuppetDB answered HTTP ${code}"
                ;;
        esac
    fi

    rm -f "${curl_err:-}" 2>/dev/null || true

    # --- ports ------------------------------------------------------------
    if command -v ss >/dev/null; then
        port=$(grep -E '^WEB_PORT=' .env | cut -d= -f2- || true)
        port="${port:-3000}"
        # OUR OWN CONTAINER IS NOT A CONFLICT. On an upgrade the web container
        # is already running and holding this port, and `up -d` replaces it
        # cleanly. Warning about it would fire on every re-run — and a check
        # that cries wolf on the normal path is one people stop reading, which
        # costs more than the case it was meant to catch.
        mine=""
        if command -v docker >/dev/null; then
            mine=$(docker compose ps -q web 2>/dev/null || true)
        fi

        if [ -n "$mine" ]; then
            ok "port ${port} is held by this deployment's own web container"
        elif ss -ltn 2>/dev/null | grep -q ":${port} "; then
            warn "something else is already listening on port ${port}"
            note "docker will refuse to bind it. Either stop that service, or"
            note "change WEB_PORT in .env — with --tls the console is served on"
            note "443 and this port is only an internal bind, so the number is"
            note "arbitrary. See what holds it: ss -ltnp | grep :${port}"
        else
            ok "port ${port} is free"
        fi
    fi

    [ "$PREFLIGHT_FAIL" -eq 0 ]
}

if [ -n "$SKIP_PREFLIGHT" ] && [ -z "$CHECK_ONLY" ]; then
    step "Preflight skipped (--skip-preflight)"
elif ! preflight; then
    printf '\n\033[31mPreflight failed.\033[0m Nothing has been built or started.\n'
    printf 'Fix the items marked ✗ above and run this again.\n\n'
    exit 1
fi

if [ -n "$CHECK_ONLY" ]; then
    printf '\n\033[32mPreflight passed.\033[0m Run without --check to deploy.\n\n'
    exit 0
fi

if [ -n "$TLS_HOSTNAME" ]; then
    step "Enabling TLS for ${TLS_HOSTNAME}"
    set_env_always() {
        if grep -qE "^${1}=" .env; then
            sed -i "s|^${1}=.*|${1}=${2}|" .env
        else
            printf '%s=%s\n' "$1" "$2" >>.env
        fi
    }
    set_env_always CONSOLE_HOSTNAME "$TLS_HOSTNAME"
    set_env_always CADDY_CONFIG "./deploy/caddy/Caddyfile.internal"
    # The console itself stays on loopback. The proxy reaches it over the
    # compose network, so publishing it as well would defeat the point.
    set_env_always WEB_BIND 127.0.0.1
    echo "    console will be served on https://${TLS_HOSTNAME}"
    echo "    ${TLS_HOSTNAME} must resolve to this host from wherever you browse"
fi

step "Building images"
docker compose build || die "docker compose build"

step "Starting the database"
docker compose up -d db || die "docker compose up -d db"
ready=""
for _ in $(seq 1 45); do
    if docker compose exec -T db pg_isready -U nexuspuppet >/dev/null 2>&1; then ready=yes; break; fi
    sleep 2
done
[ -n "$ready" ] || die "the database never became ready"

# BEFORE the api starts, always. The api bootstraps its admin account on boot
# and exits if the tables are absent — a restart loop whose error reads like a
# broken image and is really an empty database.
step "Applying migrations"
docker compose run --rm api npx prisma migrate deploy || die "prisma migrate deploy"

step "Starting NexusPuppet"
docker compose up -d || die "docker compose up -d"

if [ -n "$TLS_HOSTNAME" ] || grep -qE '^CADDY_CONFIG=.*Caddyfile\.internal' .env 2>/dev/null; then
    step "Starting the TLS proxy"
    # Only `proxy`. cert-helper belongs to the supplied-certificate flow and has
    # nothing to adopt here.
    docker compose --profile tls up -d proxy || die "docker compose --profile tls up -d proxy"
fi

# Read both from .env, but let the environment win — Compose resolves shell
# variables ahead of .env, so anything else would print a URL that is not the
# one it just bound.
env_or() { printf '%s' "${2:-$(grep -E "^${1}=" .env | cut -d= -f2- || true)}"; }
WEB_BIND="$(env_or WEB_BIND "${WEB_BIND:-}")"
WEB_PORT="$(env_or WEB_PORT "${WEB_PORT:-}")"
printf '\n\033[32mNexusPuppet is running.\033[0m\n'
CONSOLE_HOST="$(grep -E '^CONSOLE_HOSTNAME=' .env | cut -d= -f2- || true)"
if grep -qE '^CADDY_CONFIG=.*Caddyfile\.internal' .env 2>/dev/null && [ -n "$CONSOLE_HOST" ]; then
    printf '  Console:  https://%s\n' "$CONSOLE_HOST"
    printf '            your browser will warn — Caddy issued that certificate\n'
    printf '            itself, so no public CA vouches for it. The connection\n'
    printf '            IS encrypted. DEPLOYMENT.md §7 replaces it with a real one.\n'
else
    printf '  Console:  http://%s:%s\n' "${WEB_BIND:-127.0.0.1}" "${WEB_PORT:-3000}"
fi

if [ -n "${ADMIN_PASSWORD:-}" ]; then
    # Printed only on the run that generated it.
    printf '  Sign in:  %s\n  Password: %s\n' "$ADMIN_EMAIL" "$ADMIN_PASSWORD"
    printf '\n  Change that password at first login. Put TLS in front before\n'
    printf '  anyone else uses it — DEPLOYMENT.md §7.\n'
else
    # .env already existed, so this run did not generate anything.
    #
    # DELIBERATELY NOT PRINTING THE STORED PASSWORD. Re-running is the upgrade
    # path, and echoing a live credential into terminal scrollback, a CI log or
    # a screen-share on every upgrade is a worse habit than the inconvenience it
    # saves. Say where it is instead.
    stored_email=$(grep -E '^BOOTSTRAP_ADMIN_EMAIL=' .env | cut -d= -f2- || true)
    printf '  Sign in:  %s\n' "${stored_email:-admin@example.com}"
    printf '            first-login password: grep BOOTSTRAP_ADMIN_PASSWORD .env\n'
    printf '            (if you have already changed it, that value is stale)\n'
fi

# ---------------------------------------------------------------------------
# Classifying nodes is a second command on a second host. Offer to drive it.
#
# NOT because the console may reach into puppetserver — it may not, and does not
# (ADR-0003). This offer runs `setup-enc.sh --remote`, which uses YOUR ssh
# credentials from this terminal, once, and leaves no key and no channel behind.
# Declining costs nothing: the same command is printed either way.
# ---------------------------------------------------------------------------
enc_enabled=$(grep -E '^ENC_REPLICATION_ENABLED=' .env | cut -d= -f2- || true)
enc_peers=$(grep -E '^ENC_REPLICATION_ALLOWED_CERTNAMES=' .env | cut -d= -f2- || true)

if [ "$enc_enabled" = "true" ] && [ -n "$enc_peers" ]; then
    enc_port=$(grep -E '^ENC_REPLICATION_PORT=' .env | cut -d= -f2- || true)

    # The listener presents the PuppetDB client certificate, so the origin URL
    # has to use THAT certificate's CN. An IP or a convenient alias fails mTLS
    # hostname verification on the puller with an error that reads like a
    # certificate problem.
    origin_cn=$(openssl x509 -in "${CERT_DIR}/client.pem" -noout -subject 2>/dev/null |
        sed -n 's|.*CN *= *\([^,/]*\).*|\1|p' | tr -d ' ' || true)

    printf '\n\033[1mTo classify nodes, one more command — on the Puppet server.\033[0m\n'
    if [ -z "$origin_cn" ]; then
        # Readable only by root here; say so rather than printing a URL that is
        # probably wrong.
        printf '  Could not read the certificate CN from %s/client.pem,\n' "$CERT_DIR"
        printf '  so the origin URL below needs filling in by hand:\n\n'
        printf '    ./scripts/setup-enc.sh --remote you@%s \\\n' "${enc_peers%%,*}"
        printf '        --origin https://<this-host-certname>:%s --wire\n\n' "${enc_port:-8443}"
    else
        enc_origin="https://${origin_cn}:${enc_port:-8443}"
        printf '    ./scripts/setup-enc.sh --remote you@%s \\\n' "${enc_peers%%,*}"
        printf '        --origin %s --wire\n' "$enc_origin"
        printf '\n  It ships itself over SSH — nothing to clone on that host — checks,\n'
        printf '  installs, and proves the ENC serves a node before --wire puts it on\n'
        printf '  the catalog compile path. DEPLOYMENT.md §6.\n'

        # Only ask a human who is actually there. In CI, or piped, this block is
        # silent and the command above is the whole message.
        if [ -t 0 ] && [ -z "${NEXUSPUPPET_NONINTERACTIVE:-}" ]; then
            printf '\n  Run it now over SSH? user@host, or Enter to skip: '
            read -r enc_target || enc_target=""
            if [ -n "$enc_target" ]; then
                printf '  Put it on the catalog compile path too (--wire)? [y/N]: '
                read -r enc_wire || enc_wire=""
                printf '\n'
                # Spelt out twice rather than assembled into "$@": that would
                # clobber this script's own positional parameters, and an empty
                # "$@" under `set -u` is an error on bash before 4.4.
                #
                # Not exec'd, and failure is not fatal: the console is up either
                # way, and a failed ENC step must not report a failed deploy.
                enc_rc=0
                case "$enc_wire" in
                    [yY]*)
                        ./scripts/setup-enc.sh --remote "$enc_target" \
                            --origin "$enc_origin" --wire || enc_rc=$?
                        ;;
                    *)
                        ./scripts/setup-enc.sh --remote "$enc_target" \
                            --origin "$enc_origin" || enc_rc=$?
                        ;;
                esac
                if [ "$enc_rc" -eq 0 ]; then
                    :
                else
                    printf '\n  The ENC setup did not complete, but NexusPuppet itself is running.\n'
                    printf '  Re-run the command above once the reason is fixed.\n'
                fi
            fi
        fi
    fi
fi
