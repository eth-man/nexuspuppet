#!/usr/bin/env bash
# Deploy NexusPuppet. One command, first install or upgrade.
#
#   ./scripts/deploy.sh --puppetdb https://puppetdb.example.com:8081   # first run
#   ./scripts/deploy.sh                                                # every run after
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

while [ $# -gt 0 ]; do
    case "$1" in
        --puppetdb) PUPPETDB_URL="${2:-}"; shift 2 ;;
        --admin-email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
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

    echo "    secrets generated; .env is 0600"
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
if [ ! -f "${CERT_DIR}/client.pem" ] || [ ! -f "${CERT_DIR}/client.key" ] || [ ! -f "${CERT_DIR}/ca.pem" ]; then
    die "No PuppetDB client certificate in ${CERT_DIR}.

       Expected client.pem, client.key and ca.pem. On your Puppet server:

         puppetserver ca generate --certname nexuspuppet.internal

       then copy them here, owned by uid 100 so the container can read them,
       and add that certname to PuppetDB's allowlist. DEPLOYMENT.md §3 has the
       exact commands — including why the allowlist is the step people miss."
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

# Read both from .env, but let the environment win — Compose resolves shell
# variables ahead of .env, so anything else would print a URL that is not the
# one it just bound.
env_or() { printf '%s' "${2:-$(grep -E "^${1}=" .env | cut -d= -f2- || true)}"; }
WEB_BIND="$(env_or WEB_BIND "${WEB_BIND:-}")"
WEB_PORT="$(env_or WEB_PORT "${WEB_PORT:-}")"
printf '\n\033[32mNexusPuppet is running.\033[0m\n'
printf '  Console:  http://%s:%s\n' "${WEB_BIND:-127.0.0.1}" "${WEB_PORT:-3000}"

if [ -n "${ADMIN_PASSWORD:-}" ]; then
    # Shown ONCE, and only on the run that generated it. It is in .env if this
    # scrolls past, and DEPLOYMENT.md §5 says to change it at first login.
    printf '  Sign in:  %s\n  Password: %s\n' "$ADMIN_EMAIL" "$ADMIN_PASSWORD"
    printf '\n  Change that password at first login. Put TLS in front before\n'
    printf '  anyone else uses it — DEPLOYMENT.md §7.\n'
fi
