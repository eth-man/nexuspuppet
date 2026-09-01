# @nexuspuppet/enterprise

**Apache-2.0**, like the rest of this repository. See the root
[`LICENSE`](../../LICENSE).

Directory authentication (LDAP and Active Directory), single sign-on (OIDC) and
audit forwarding. Core discovers this package at runtime and works completely
without it.

The name is historical. This was a private, separately-licensed layer until
2026, when NexusPuppet went fully open source and the licensing was removed
(see [ADR-0014](../../docs/architecture/adr/0014-enterprise-licensing.md)). What
survives is the runtime seam — now an internal boundary that keeps these
integrations independently testable, not a commercial one.

## How it attaches to core

It does not import core, and core does not import it. The single connection is
a dynamic `import('@nexuspuppet/enterprise')` inside
`apps/api/src/enterprise/enterprise.loader.ts` — the one file exempted from the
ESLint boundary rule (ADR-0002).

`src/index.ts` exports `register()`, which returns a descriptor naming the
capability tokens this build overrides. Core layers those over its own defaults.
Registration is one-way.

```
register() ──> { capabilities: ['directory.ldap'],
                 registrations: [{ token: AUTH_PROVIDER, provider: LdapAuthProviderModule }] }
```

**A throw from `register()` is fatal, by design.** An operator who installed
this layer must never silently get core behaviour instead — a deployment that
paid for SSO must not quietly fall back to local password auth at 3am. Bad
configuration therefore fails at boot, not at someone's first login.

## Development

This package is **not** installed by the public repository's lockfile. Doing so
would add its dependencies to a lockfile that is committed publicly, and would
break `npm ci` for everyone who does not have this directory.

```bash
# from the monorepo root, with this directory present:
ln -sfn ../../packages/enterprise node_modules/@nexuspuppet/enterprise
cd packages/enterprise && npm install ldapts   # optional peer, needed at runtime
npm run build && npm test
```

Node resolves `@nexuspuppet/contracts`, `jest` and `typescript` upward from the
monorepo root, so no separate install is needed for those.

> Before committing to the **public** repository, confirm `git status` is clean
> and `package-lock.json` is unchanged. `packages/enterprise/` is gitignored
> there, so this should be automatic — verify anyway.

## LDAP provider

Standard two-bind flow:

1. bind as the service account (or anonymously) and **search** for the user, to
   discover their DN — a DN cannot be reliably constructed from an email;
2. bind **as that DN** with the supplied password. A successful bind *is* the
   authentication. This code never compares a password.

Then group membership decides the role, and the account is looked up in
NexusPuppet to obtain a stable `userId`.

### Configuration

| Variable | Required | Notes |
|---|---|---|
| `LDAP_DIALECT` | no | `openldap` (default) or `ad`. Sets the defaults below |
| `LDAP_URL` | yes | `ldaps://…`. `ldap://` warns — binds are cleartext |
| `LDAP_SEARCH_BASE` | yes | e.g. `ou=people,dc=example,dc=com` |
| `LDAP_BIND_DN` | no | Service account for the search. Anonymous if unset |
| `LDAP_BIND_PASSWORD` | with `LDAP_BIND_DN` | Set together or not at all |
| `LDAP_SEARCH_FILTER` | no | Must contain `{{input}}`. Default matches `mail` |
| `LDAP_ROLE_MAPPINGS` | effectively yes | `<groupDn>=<ROLE>;…`. No mappings ⇒ every login refused |
| `LDAP_TIMEOUT_MS` | no | Default 10000 |
| `LDAP_CA_PATH` | no | PEM bundle signing the directory's certificate. Needed for an internal CA |
| `LDAP_NESTED_GROUPS` | no | AD only. Resolve transitive membership via `LDAP_MATCHING_RULE_IN_CHAIN` |
| `LDAP_GROUP_SEARCH_BASE` | no | Where nested-group search runs. Defaults to `LDAP_SEARCH_BASE` |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | no | Default true. `false` disables certificate verification |

```bash
LDAP_ROLE_MAPPINGS="cn=puppet-admins,ou=groups,dc=example,dc=com=ADMIN;cn=ops,ou=groups,dc=example,dc=com=OPERATOR"
```

Split on the **last** `=` in each pair, because DNs contain `=` themselves.

### Active Directory

`LDAP_DIALECT=ad` changes defaults, never behaviour you cannot override:

| | OpenLDAP | Active Directory |
|---|---|---|
| Search filter | `(&(objectClass=person)(mail={{input}}))` | `(&(objectClass=user)(objectCategory=person)(\|(sAMAccountName={{input}})(userPrincipalName={{input}})))` |
| Login label | Email | Username |
| Nested groups | unavailable | available, off by default |

**Users sign in with `sAMAccountName` or UPN.** IT tells people their "username"
(`jdoe`); the UPN (`jdoe@corp.example.com`) looks like an email and is what many
try first. The default filter accepts either, because refusing one produces a
login screen that works for some colleagues and not others.

**`objectCategory=person` is not decoration.** Computer accounts are
`objectClass=user` in AD; without it a machine account could match the search
and be bound against.

**Nested groups are off by default, even on AD.** They cost an extra query per
login against the whole group subtree. Turn them on when roles are granted
through a chain — a person in `platform-team`, which is a member of
`puppet-admins`. Without it that person is refused despite being entitled, and
nothing in this application can tell them why. Requesting them on a dialect that
cannot do them is a **boot failure**, not a silent downgrade to direct
membership, which would quietly grant the wrong roles.

**Referrals are never followed.** AD answers a search for an object in another
domain with "ask that server instead". Chasing it means binding to a host the
*directory* nominated — with the service account's credentials — so a
compromised or misconfigured DC could name any host and be handed them. They are
logged instead, because ignoring one silently makes a user in a referred domain
look simply absent. For a multi-domain forest, point `LDAP_URL` at a Global
Catalog (port 3268) and search the whole forest from one server.

### Decisions that look like bugs until you know why

**No default role.** A user in none of the mapped groups is refused, not made a
VIEWER. Defaulting would grant estate-wide read access to everyone the directory
contains — contractors, service accounts, former staff whose entries linger. An
estate inventory is a map of every host, its OS, and its patch state.

**Highest role wins**, not first match. `memberOf` ordering is unspecified, so
first-match would make a person's privileges depend on directory internals.

**An empty password is rejected before any bind.** LDAP treats a bind with a DN
and an empty password as an *unauthenticated bind* (RFC 4513 §5.1.2), which a
server **may** answer with success while granting nothing — so forwarding a
blank password can authenticate anybody.

Whether it is accepted is a server setting, which is exactly why the check
belongs here. OpenLDAP refuses it unless `allow bind_anon_dn` is configured;
other directories accept it by default, and an operator can enable it by
accident. Rejecting before the bind makes the outcome independent of a setting
this application does not control — and the integration suite proves it by
configuring OpenLDAP to accept an empty password and showing the provider still
refuses.

**An internal CA is supplied by path, never inline.** On-prem directories are
usually signed by a CA that is not in the system trust store. Without
`LDAP_CA_PATH` the only route to `ldaps://` would be disabling verification,
which makes every password submitted to the console readable by anyone on the
network path. Certificate material in an environment variable ends up in
`docker inspect`, process listings and crash reports, so it is a path to a
mounted file — the same rule the PuppetDB client follows in core.

Two combinations fail at boot rather than at someone's first login: a
`LDAP_CA_PATH` that does not exist, and a CA supplied alongside
`LDAP_TLS_REJECT_UNAUTHORIZED=false` — the latter because `rejectUnauthorized:
false` ignores the CA and accepts any certificate, so honouring it silently
would leave a deployment feeling secured while it is not.

**Every rejection returns the same reason.** Unknown user, wrong password, and
unmapped group are indistinguishable to the caller. Otherwise login becomes a
user-enumeration oracle against the *corporate directory* — a much richer target
than this application's own user table.

**A directory outage returns `PROVIDER_ERROR`, never `INVALID_CREDENTIALS`,**
and never falls through to another provider. Otherwise an outage reads to every
user as "my password stopped working".

**Identifiers are escaped per RFC 4515 before entering a filter.** An unescaped
`*` turns `(mail=alice)` into `(mail=*)`, which matches the whole directory —
and the provider would then bind against whichever entry came back first. The
same rule as PQL in core: never interpolate user input into a query language.

**A search filter template without `{{input}}` is rejected at boot.** Such a
filter ignores the username, matches the subtree, and authenticates the first
entry found.

## Status

60 unit tests against a fake directory, plus 22 integration tests against a real
OpenLDAP over a real socket — including `ldaps://` with certificate
verification **enforced** against an internal CA, and the negative case proving
the same connection fails without it.

`test/ldap/up.sh` generates its own CA and a server certificate for
`localhost`. The osixia image ships a CA minted in 2021 that expired in January
2026 and signs its freshly-generated server certificate with it, so its chain
cannot validate at all; owning the CA also makes the ldaps:// tests verify a
real trust chain rather than working around a broken one.

**Active Directory support is implemented but has never been run against a real
AD server.** The dialect defaults, `sAMAccountName` filters, nested-group
resolution and referral handling are covered by unit tests against a fake
directory; the integration suite runs against OpenLDAP, which does not implement
`LDAP_MATCHING_RULE_IN_CHAIN` and cannot exercise the chain query at all.

Treat first contact with a real domain controller as commissioning. The most
likely surprises are attribute names in a customised schema, a service account
without rights to read `memberOf`, and referrals in a multi-domain forest.

### Known gap: identity store

`LdapAuthProvider` needs `findById` and `recordLogin` from the host's
`USER_DIRECTORY`, which the published `IUserDirectory` does not yet declare —
see `asIdentityStore()` in `src/index.ts`. It is checked at boot and fails with
a precise message rather than at someone's first login. Closing it means adding
two methods to `IUserDirectory` in the public contracts package and implementing
them in `LocalUserDirectory`. Both are additive and backward compatible.
