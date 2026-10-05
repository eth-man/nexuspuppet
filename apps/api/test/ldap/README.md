# LDAP and OIDC against real servers

The unit tests for `src/directory/` run against fakes. These fixtures run the
same code against real servers, because a fake confirms the protocol this code
*believes* in, not the one a directory speaks.

Neither runs in CI, and neither is part of `npm test`: both need Docker.

## LDAP — OpenLDAP in a container

From `apps/api` (or add `--workspace @nexuspuppet/api` from the root):

```bash
npm run ldap:up      # container, TLS material, memberOf overlay, test tree
npm run test:ldap    # the suite in this directory, in band
npm run ldap:down    # remove the container and its volume
```

`ldap:up` runs `up.sh`, which needs whatever lets you run `docker` (sudo on a
host whose user is not in the docker group). It serves, loopback only:

- `ldap://127.0.0.1:3890` — plain LDAP that also offers **STARTTLS**;
- `ldaps://127.0.0.1:6360` — LDAPS;
- `ldap://127.0.0.1:3892` — a second directory with **no TLS**, which refuses
  STARTTLS. `connection-fields.spec.ts` points STARTTLS at it through a proxy
  that records every byte the client sends, to prove nothing follows the
  refused upgrade (ADR-0030). It also refuses ALL unauthenticated access
  (`olcRequires: authc`), for the "does not allow anonymous searches" message.

`resolver-login.spec.ts` signs in **through the real resolver** — account rows
with real email addresses in Postgres, settings saved through the settings
service — so it also needs the integration database: set `TEST_DATABASE_URL`
and run `npm run db:test:setup` first, as for `test:int`.

Before returning it verifies that `memberOf` is populated, that the service
account and an anonymous reader can see people, that the chain validates over
both LDAPS and STARTTLS, and that `:3892` refuses STARTTLS — so a suite failure
means the code, not the fixture.

A stale container of the default name (`nexuspuppet-test-ldap`) from an older
checkout blocks the run; rather than removing it, pick another name:
`LDAP_TEST_CONTAINER=my-ldap npm run ldap:up --workspace @nexuspuppet/api`.

Why a script and not a bare `docker compose up`:

- **The memberOf overlay must be active before the tree is written**, or
  `memberOf` comes back empty on every user and every login is refused — a
  failure indistinguishable from a wrong role mapping.
- **It generates its own CA** (into `certs/`, gitignored). The osixia image ships
  a CA minted in 2021 that expired in January 2026 and signs its server
  certificate with it, so its chain cannot validate at all. Owning the CA also
  makes the `ldaps://` tests verify a real trust chain.
- **It enables `bind_anon_dn`** deliberately, so the suite can show the server
  accepting an empty password while the provider still refuses it — in every
  bind type.
- **It lets an anonymous reader search `ou=people`** (never `userPassword`), for
  the Anonymous bind type. Simple bind relies on the image's own `by self read`.

Override the endpoints with `TEST_LDAP_URL` / `TEST_LDAPS_URL`.

## OIDC — Keycloak in a container

```bash
docker compose -f apps/api/test/oidc/docker-compose.oidc.yml up -d
```

A development fixture on `http://127.0.0.1:8092` with the `nexuspuppet` realm
from `test/oidc/realm.json`. The unit tests sign their own tokens, which proves
the verifier accepts and refuses the right things but not that it speaks the
protocol a real provider speaks — discovery document shape, the claims Keycloak
actually emits, group formatting, PKCE as sent. Point a development API at it
with `OIDC_ISSUER=http://127.0.0.1:8092/realms/nexuspuppet` to exercise that.
