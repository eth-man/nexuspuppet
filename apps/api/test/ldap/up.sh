#!/usr/bin/env bash
#
# Bring up the throwaway OpenLDAP and load the test tree.
#
#   npm run ldap:up --workspace @nexuspuppet/api     (or: apps/api/test/ldap/up.sh)
#
# Needs whatever lets you run `docker` — sudo on a host whose user is not in
# the docker group.
#
# Order matters and is the whole reason this is a script rather than a bare
# `docker compose up`: the memberOf overlay must be active BEFORE the tree is
# written, or `memberOf` comes back empty on every user, every role lookup
# returns nothing, and every login is refused — a failure indistinguishable
# from a wrong role mapping.
set -euo pipefail

# Everything below is relative to this directory: the compose file, the
# generated certificates and the tree all live next to this script.
cd "$(dirname "$0")"

COMPOSE="docker compose -f docker-compose.ldap.yml"
CONTAINER="${LDAP_TEST_CONTAINER:-nexuspuppet-test-ldap}"
BASE_DN="dc=nexuspuppet,dc=test"
ADMIN_DN="cn=admin,${BASE_DN}"
ADMIN_PW="test-admin-password"

# Always start from nothing. The memberOf overlay only populates entries
# written while it is active, so a container that already has the tree loaded
# cannot be fixed by enabling the overlay afterwards — it has to be rebuilt.
echo "=== removing any previous container and volume ==="
$COMPOSE down -v >/dev/null 2>&1 || true

# --- TLS material -----------------------------------------------------------
#
# We generate our own CA rather than using the image's. osixia 1.5.0 ships a CA
# minted in 2021 that expired in January 2026 and signs its freshly-generated
# server certificate with it, so the chain cannot validate today no matter what
# the client does.
#
# Owning the CA also makes the ldaps:// tests mean something: they verify a
# real trust chain instead of working around a broken one.
if [ ! -s certs/ca.crt ] || ! openssl x509 -in certs/ca.crt -checkend 86400 >/dev/null 2>&1; then
  echo "=== generating TLS material (CA + server certificate for localhost) ==="
  rm -rf certs && mkdir -p certs

  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout certs/ca.key -out certs/ca.crt \
    -subj "/CN=NexusPuppet Test CA" >/dev/null 2>&1

  openssl req -newkey rsa:2048 -nodes \
    -keyout certs/ldap.key -out certs/ldap.csr \
    -subj "/CN=localhost" >/dev/null 2>&1

  # localhost in the SAN, because that is the name the tests connect to. A
  # certificate valid for some other name would fail the HOSTNAME check, and a
  # test asserting "verification works" would then be asserting the wrong thing.
  openssl x509 -req -in certs/ldap.csr -days 365 \
    -CA certs/ca.crt -CAkey certs/ca.key -CAcreateserial \
    -out certs/ldap.crt \
    -extfile <(printf "subjectAltName=DNS:localhost,IP:127.0.0.1") >/dev/null 2>&1

  # slapd runs as a non-root user inside the container and has to read these.
  chmod 0644 certs/*.crt certs/*.key
  echo "  CA valid until $(openssl x509 -in certs/ca.crt -noout -enddate | cut -d= -f2)"
fi

echo "=== starting OpenLDAP ==="
$COMPOSE up -d

# The image starts a BOOTSTRAP slapd, generates 2048-bit DH parameters for TLS
# (about a minute), then stops it and starts the real one. Until then LDAPS
# resets Node's handshake while openssl's succeeds, so a check with openssl
# passes and the suite then fails every TLS test for a minute — it did. Wait
# for the real server ("First start is done", then "slapd starting") before
# configuring anything, so every step below lands on, and checks, the server
# the suite will use.
wait_for_final_start() {
  local container="$1"
  for _ in $(seq 120); do
    if docker logs "$container" 2>&1 | sed -n '/First start is done/,$p' | grep -q 'slapd starting'; then
      echo "  $container: final slapd is up"
      return 0
    fi
    sleep 2
  done
  echo "::error:: $container never finished its first start" >&2
  docker logs --tail 20 "$container" >&2
  exit 1
}
echo "=== waiting for the images' first start (TLS parameters take about a minute) ==="
wait_for_final_start "$CONTAINER"
wait_for_final_start "${CONTAINER}-plain"

echo "=== waiting for it to answer queries ==="
for _ in $(seq 40); do
  if docker exec "$CONTAINER" ldapsearch -x -H ldap://localhost:389 \
      -D "$ADMIN_DN" -w "$ADMIN_PW" -b "$BASE_DN" -s base >/dev/null 2>&1; then
    echo "  directory is up"
    break
  fi
  sleep 2
done

docker exec "$CONTAINER" ldapsearch -x -H ldap://localhost:389 \
  -D "$ADMIN_DN" -w "$ADMIN_PW" -b "$BASE_DN" -s base >/dev/null 2>&1 || {
  echo "::error:: the directory never became ready" >&2
  $COMPOSE logs --tail 40
  exit 1
}

echo "=== enabling the memberOf overlay (before loading the tree) ==="
# The database DN is discovered, not assumed: it is {1}mdb on this image today,
# but hardcoding it means a silent no-op if the image ever renumbers.
DB_DN=$(docker exec "$CONTAINER" ldapsearch -Y EXTERNAL -H ldapi:/// -LLL \
  -b cn=config "(olcSuffix=${BASE_DN})" dn 2>/dev/null | sed -n 's/^dn: //p' | head -1)

if [ -z "$DB_DN" ]; then
  echo "::error:: could not find the cn=config database entry for ${BASE_DN}" >&2
  exit 1
fi
echo "  database: $DB_DN"

# -c (continue) matters: osixia already loads the memberof MODULE, so that
# first statement fails with "already exists". Without -c, ldapmodify aborts
# there and the OVERLAY below is silently never added — which is precisely how
# the tree ends up with no memberOf at all.
docker exec -i "$CONTAINER" ldapmodify -c -Y EXTERNAL -H ldapi:/// <<EOF 2>&1 | sed 's/^/  /' || true
dn: cn=module{0},cn=config
changetype: modify
add: olcModuleLoad
olcModuleLoad: memberof

dn: olcOverlay=memberof,${DB_DN}
changetype: add
objectClass: olcOverlayConfig
objectClass: olcMemberOf
olcOverlay: memberof
olcMemberOfDangling: ignore
olcMemberOfRefInt: TRUE
olcMemberOfGroupOC: groupOfNames
olcMemberOfMemberAD: member
olcMemberOfMemberOfAD: memberOf
EOF

echo "=== granting the service account read access ==="
# osixia's default ACL gives an arbitrary authenticated DN nothing, so the
# service account can BIND but every search returns noSuchObject(32) — which is
# OpenLDAP declining to disclose the existence of a subtree it may not read.
#
# A real deployment has to do exactly this: the directory administrator grants
# the NexusPuppet service account read access. Without it the symptom is
# "PROVIDER_ERROR on every login" with a successful bind in the logs, which is
# a genuinely confusing thing to debug.
#
# Inserted at {0} so it is evaluated first; `by * break` falls through to the
# image's existing rules rather than replacing them.
docker exec -i "$CONTAINER" ldapmodify -c -Y EXTERNAL -H ldapi:/// <<EOF 2>&1 | sed 's/^/  /' || true
dn: ${DB_DN}
changetype: modify
add: olcAccess
olcAccess: {0}to * by dn.exact="cn=svc-nexuspuppet,${BASE_DN}" read by * break
EOF

echo "=== letting an anonymous reader search people (for the Anonymous bind type) ==="
# The Anonymous bind type (ADR-0030) searches with no service account, so the
# directory has to let nobody-in-particular find a person: their DN, mail,
# display name and groups. Never userPassword — that rule comes later and still
# says `by anonymous auth`. Inserted at {1}, after the service account's rule.
docker exec -i "$CONTAINER" ldapmodify -c -Y EXTERNAL -H ldapi:/// <<EOF 2>&1 | sed 's/^/  /' || true
dn: ${DB_DN}
changetype: modify
add: olcAccess
olcAccess: {1}to dn.subtree="ou=people,${BASE_DN}" attrs=entry,objectClass,uid,cn,sn,mail,displayName,memberOf by anonymous read by * break
EOF

echo "=== allowing unauthenticated bind (to prove the guard is load-bearing) ==="
# OpenLDAP REFUSES a bind with a DN and an empty password unless
# `allow bind_anon_dn` is set, so on a default install the provider's guard
# is belt-and-braces. (Not bind_anon_cred — that is the opposite case, an
# EMPTY DN with a password.) Other directories do accept it, and an operator can
# enable it here by accident.
#
# Turning it on deliberately is what makes the integration test meaningful: it
# lets the suite show the server saying YES to an empty password while the
# provider still says no.
docker exec -i "$CONTAINER" ldapmodify -c -Y EXTERNAL -H ldapi:/// <<EOF 2>&1 | sed 's/^/  /' || true
dn: cn=config
changetype: modify
add: olcAllows
olcAllows: bind_anon_dn
EOF

echo "=== loading the test tree ==="
docker exec -i "$CONTAINER" ldapadd -x -H ldap://localhost:389 \
  -D "$ADMIN_DN" -w "$ADMIN_PW" \
  < 01-tree.ldif 2>&1 | sed 's/^/  /' || echo "  (entries already present — continuing)"

echo "=== verifying memberOf actually populated ==="
# If this is empty the whole suite would fail for a reason that has nothing to
# do with the provider, so it is checked here rather than discovered in a test.
groups=$(docker exec "$CONTAINER" ldapsearch -x -H ldap://localhost:389 \
  -D "$ADMIN_DN" -w "$ADMIN_PW" -b "uid=dave,ou=people,${BASE_DN}" \
  -s base memberOf 2>/dev/null | grep -c '^memberOf:' || true)

if [ "${groups:-0}" -lt 2 ]; then
  echo "::error:: dave should be in 2 groups but memberOf returned ${groups}." >&2
  echo "          The overlay is not active, or the tree was loaded before it." >&2
  echo "          Reset with: npm run ldap:down --workspace @nexuspuppet/api" >&2
  exit 1
fi

echo "  dave has ${groups} groups — overlay is working"

echo "=== verifying the service account can actually read ==="
readable=$(docker exec "$CONTAINER" ldapsearch -x -H ldap://localhost:389 \
  -D "cn=svc-nexuspuppet,${BASE_DN}" -w svc-password \
  -b "ou=people,${BASE_DN}" "(objectClass=inetOrgPerson)" dn 2>/dev/null \
  | grep -c '^dn:' || true)

if [ "${readable:-0}" -lt 5 ]; then
  echo "::error:: the service account sees ${readable} of 5 people. The ACL did not apply," >&2
  echo "          so every login would fail with PROVIDER_ERROR." >&2
  exit 1
fi
echo "  service account sees ${readable} people"
echo "=== verifying the ldaps:// chain actually validates ==="
# The VERDICT, not the exit status. s_client exits non-zero here regardless of
# the chain: it writes a newline after the handshake, slapd rejects that as
# malformed LDAP and closes the connection. Keying on $? reports a TLS failure
# for what is really a protocol-level hang-up.
#
# CAPTURED FIRST, not piped into `grep -q`. grep exits the moment it matches and
# closes the pipe; openssl then dies of SIGPIPE, and under `set -o pipefail` the
# pipeline reports that failure — so the check fails exactly when the chain is
# VALID, and only when openssl is still writing when grep leaves. A race that
# reports success as failure, which is the worst way round.
verdict=$(echo | openssl s_client -connect localhost:6360 -CAfile certs/ca.crt 2>&1 || true)

if ! printf '%s' "$verdict" | grep -q "Verify return code: 0 (ok)"; then
  echo "::error:: the TLS chain does not validate against our CA." >&2
  echo "          The ldaps:// tests would fail for a reason unrelated to the code." >&2
  printf '%s' "$verdict" | grep -iE "verify (error|return code)" | head -3 >&2
  exit 1
fi
echo "  chain validates against certs/ca.crt"

echo "=== verifying STARTTLS on the plain port validates too ==="
# The same certificate, reached the other way: connect on 3890 in clear, ask
# to upgrade, then verify. The STARTTLS tests mean nothing if this fails.
verdict=$(echo | openssl s_client -connect localhost:3890 -starttls ldap -CAfile certs/ca.crt 2>&1 || true)
if ! printf '%s' "$verdict" | grep -q "Verify return code: 0 (ok)"; then
  echo "::error:: STARTTLS on :3890 does not validate against our CA." >&2
  printf '%s' "$verdict" | grep -iE "verify (error|return code)|error" | head -3 >&2
  exit 1
fi
echo "  STARTTLS on :3890 validates against certs/ca.crt"

echo "=== verifying an anonymous reader can find people ==="
anonymous=$(docker exec "$CONTAINER" ldapsearch -x -H ldap://localhost:389 \
  -b "ou=people,${BASE_DN}" "(objectClass=inetOrgPerson)" dn 2>/dev/null \
  | grep -c '^dn:' || true)
if [ "${anonymous:-0}" -lt 5 ]; then
  echo "::error:: an anonymous search sees ${anonymous} of 5 people; the Anonymous bind tests would fail." >&2
  exit 1
fi
echo "  anonymous search sees ${anonymous} people"

echo "=== waiting for the TLS-less directory (refuses STARTTLS) ==="
for _ in $(seq 40); do
  if docker exec "${CONTAINER}-plain" ldapsearch -x -H ldap://localhost:389 -b '' -s base \
      >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
if docker exec "${CONTAINER}-plain" ldapsearch -ZZ -x -H ldap://localhost:389 -b '' -s base \
    >/dev/null 2>&1; then
  echo "::error:: the TLS-less directory on :3892 accepted STARTTLS; the fail-closed test would prove nothing." >&2
  exit 1
fi
echo "  :3892 answers, and refuses STARTTLS"

echo "=== making the TLS-less directory refuse unauthenticated access ==="
# olcRequires: authc — the OpenLDAP way to say "no anonymous searches". It
# answers an unbound search with unwillingToPerform, "authentication required",
# which the suite expects to see turned into a plain sentence (ADR-0030). It
# still refuses STARTTLS the same way, so the fail-closed tests are unchanged.
docker exec -i "${CONTAINER}-plain" ldapmodify -c -Y EXTERNAL -H ldapi:/// <<EOF 2>&1 | sed 's/^/  /' || true
dn: cn=config
changetype: modify
add: olcRequires
olcRequires: authc
EOF
# Captured first: ldapsearch exits non-zero on the refusal, which under
# pipefail would fail a pipeline into grep exactly when the check passes.
refusal=$(docker exec "${CONTAINER}-plain" ldapsearch -x -H ldap://localhost:389 \
  -b 'dc=nexuspuppet,dc=test' '(uid=x)' dn 2>&1 || true)
if printf '%s' "$refusal" | grep -q 'authentication required'; then
  echo "  :3892 refuses anonymous searches"
else
  echo "::error:: :3892 still serves anonymous searches; the anonymous-refusal test would prove nothing." >&2
  exit 1
fi

echo
echo "Ready. ldap://127.0.0.1:3890 (+STARTTLS)  ldaps://127.0.0.1:6360  ldap://127.0.0.1:3892 (no TLS)"
echo "Run the suite with:  npm run test:ldap --workspace @nexuspuppet/api"
