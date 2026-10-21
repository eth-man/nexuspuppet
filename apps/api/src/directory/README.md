# Directory authentication — LDAP/AD and OIDC

These providers are contributed **alongside** core's local provider, never
instead of it (ADR-0015). A login whose typed address is a local (or OIDC)
account is dispatched by that account's `authSource`, and nothing else; every
other login, with LDAP configured, is **directory-first** (ADR-0031) — see
below. Local accounts keep working whatever happens here.

Both are registered on every deployment (ADR-0029). Each resolves its
configuration per sign-in: a row saved in the console, else its environment
(`LDAP_*`, `OIDC_*`), else none — **dormant**, reported by `isConfigured()`,
which keeps it off the login page and has the resolver refuse its accounts like
a wrong password. The environment is still validated **at boot**
(`config/integrations.ts`): a malformed value stops the API from starting,
rather than surfacing at someone's first login. See ADR-0027.

This code lived in `packages/enterprise` until ADR-0027. The notes below moved
with it.

## LDAP provider

Regular and Anonymous bind types use the standard two-bind flow:

1. bind as the service account (or not at all) and **search** for the user, to
   discover their DN — a DN cannot be reliably constructed from an email;
2. bind **as that DN** with the supplied password. A successful bind *is* the
   authentication. This code never compares a password.

Simple bind (ADR-0030) has no service account: the DN (or AD UPN) is built from
`LDAP_USER_DN_PATTERN`, with the username escaped for DN context (RFC 4514) or,
for a UPN, refused if it holds anything that could name another account. The
person binds as it and their own entry is read, as them, on the same
connection. With STARTTLS, every connection is upgraded before its first bind,
and a refused or failed upgrade ends the operation with nothing sent.

Then group membership decides the role, and the NexusPuppet account is found
(ADR-0031), in order:

1. **linked** — the account whose `directoryId` is the entry's `objectGUID`
   (AD, 16 bytes, decoded to the GUID string AD's tools print) or `entryUUID`
   (OpenLDAP);
2. **linkable** — an `ldap` account with no link whose email is what was typed
   (when the search or bind proved it is this entry's), or the entry's `mail`
   or UPN — those only when that address, searched for, finds this entry and
   no other. It is linked in one transaction with a `user.directory.link`
   audit row. Never a `local` account; never one linked to another entry;
3. **created** — with `autoCreateAccounts` (`LDAP_AUTO_CREATE_ACCOUNTS`), an
   account keyed by the entry's `mail` (else UPN), with the mapped role and the
   link, in one transaction with a `user.create` audit row by `directory:ldap`.

`DirectoryAccountWriter` (`src/auth/directory-accounts.ts`) does both writes;
the provider decides. Concurrent first sign-ins meet the unique `email` and
`directoryId` and re-read rather than fail.

### Configuration

| Variable | Required | Notes |
|---|---|---|
| `LDAP_DIALECT` | no | `openldap` (default) or `ad`. Sets the defaults below. The console *detects* this from the RootDSE; the environment does not, so set it for AD |
| `LDAP_URL` | yes | `ldaps://host[:port]`, or `ldap://host[:port]` with `LDAP_STARTTLS=true`. Plain `ldap://` alone still works and warns — binds are cleartext |
| `LDAP_STARTTLS` | no | `true` upgrades an `ldap://` URL with STARTTLS before any bind; refused with `ldaps://` (ADR-0030) |
| `LDAP_BIND_TYPE` | no | `regular`, `simple` or `anonymous`. Default: `regular` with `LDAP_BIND_DN`, else `anonymous` |
| `LDAP_USER_DN_PATTERN` | with `simple` | One of `{username}` (what is typed, before any `@`) or `{email}` (a whole address): `{username}@corp.local` for AD, `uid={username},ou=people,dc=…` for OpenLDAP, or `{email}` where everyone types their UPN |
| `LDAP_SEARCH_BASE` | yes | e.g. `ou=people,dc=example,dc=com` |
| `LDAP_BIND_DN` | no | Service account for the search (Regular). Anonymous if unset |
| `LDAP_BIND_PASSWORD` | with `LDAP_BIND_DN` | Set together or not at all |
| `LDAP_SEARCH_FILTER` | no | Must contain `{{input}}`. Default matches `uid` or `mail` (OpenLDAP), `sAMAccountName`, UPN or `mail` (AD) |
| `LDAP_ROLE_MAPPINGS` | effectively yes | `<groupDn>=<ROLE>;…`. No mappings ⇒ every login refused |
| `LDAP_TIMEOUT_MS` | no | Default 10000 |
| `LDAP_CA_PATH` | no | PEM bundle signing the directory's certificate. Needed for an internal CA |
| `LDAP_NESTED_GROUPS` | no | AD only. Resolve transitive membership via `LDAP_MATCHING_RULE_IN_CHAIN` |
| `LDAP_GROUP_SEARCH_BASE` | no | Where nested-group search runs. Defaults to `LDAP_SEARCH_BASE` |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | no | Default true. `false` disables certificate verification |
| `LDAP_AUTO_CREATE_ACCOUNTS` | no | `true` creates an account at first sign-in for anyone in a mapped group (ADR-0031). Default `false`; anything but `true`/`false` refuses to boot |

```bash
LDAP_ROLE_MAPPINGS="cn=puppet-admins,ou=groups,dc=example,dc=com=ADMIN;cn=ops,ou=groups,dc=example,dc=com=OPERATOR"
```

Split on the **last** `=` in each pair, because DNs contain `=` themselves.

### Active Directory

`LDAP_DIALECT=ad` changes defaults, never behaviour you cannot override:

| | OpenLDAP | Active Directory |
|---|---|---|
| Search filter | `(&(objectClass=person)(\|(uid={{input}})(mail={{input}})))` | `(&(objectClass=user)(objectCategory=person)(\|(sAMAccountName={{input}})(userPrincipalName={{input}})(mail={{input}})))` |
| Login label | Username or email | Username or email |
| Directory id | `entryUUID` (text) | `objectGUID` (16 bytes) |
| Nested groups | unavailable | available, off by default |

**Users sign in with their username, UPN or email** (ADR-0031). The directory
is asked first, so `jdoe` finds the person, and the login field says *Username
or email*. Up to 1.13.1 the account was found by the address typed before any
directory was asked, so a bare username was refused, and the address also had
to be the entry's `mail` or UPN — in real ADs the UPN suffix is often `.local`
while email is `.com`, and `mail` is often empty. A stored or environment
filter exactly equal to an old default (AD without `mail`, OpenLDAP `mail`
only) is read as the default; any other explicit filter is used as written.

**An address two entries answer to is refused.** The user search asks for at
most two entries and refuses a second (`More than one directory entry carries
this sign-in name`), so one person's `mail` that is another's UPN can never
bind against whichever entry the server happens to list first.

**Why a sign-in was refused is logged** (never told to the caller): *no
directory entry matched under `<base>` (searched `<attributes>`)* at WARN,
*the directory rejected the password for `<DN>`* at LOG, *no NexusPuppet
account is linked to that entry or carries one of its addresses* at LOG, and
the linking refusals at WARN. For an identifier no account has, these are
throttled to ten a minute with a suppressed count. None contains the password.

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
look simply absent. For a multi-domain forest, point the console at a Global
Catalog (3269 for LDAPS, 3268 for STARTTLS) and search the whole forest from one server.

### Decisions that look like bugs until you know why

**No default role.** A user in none of the mapped groups is refused, not made a
VIEWER. Defaulting would grant estate-wide read access to everyone the directory
contains — contractors, service accounts, former staff whose entries linger. An
estate inventory is a map of every host, its OS, and its patch state.

**An empty password is rejected before any bind.** LDAP treats a bind with a DN
and an empty password as an *unauthenticated bind* (RFC 4513 §5.1.2), which a
server **may** answer with success while granting nothing — so forwarding a
blank password can authenticate anybody. Whether it is accepted is a server
setting, which is exactly why the check belongs here. The integration suite
proves it by configuring OpenLDAP to accept an empty password and showing the
provider still refuses.

**An internal CA is supplied by path, never inline.** Without `LDAP_CA_PATH` the
only route to `ldaps://` against an internal CA would be disabling verification.
Certificate material in an environment variable ends up in `docker inspect`,
process listings and crash reports, so it is a path to a mounted file — the same
rule the PuppetDB client follows. Two combinations fail at boot: an
`LDAP_CA_PATH` that does not exist, and a CA supplied alongside
`LDAP_TLS_REJECT_UNAUTHORIZED=false`, which would ignore it.

**Every rejection returns the same reason.** Unknown user, wrong password, and
unmapped group are indistinguishable to the caller. Otherwise login becomes a
user-enumeration oracle against the *corporate directory*.

**A directory outage returns `PROVIDER_ERROR`, never `INVALID_CREDENTIALS`,**
and never falls through to another provider. Otherwise an outage reads to every
user as "my password stopped working".

**Identifiers are escaped per RFC 4515 before entering a filter.** An unescaped
`*` turns `(mail=alice)` into `(mail=*)`, which matches the whole directory. The
same rule as PQL: never interpolate user input into a query language.

**A search filter template without `{{input}}` is rejected at boot.** Such a
filter ignores the username, matches the subtree, and authenticates the first
entry found.

### What has and has not been run against a real server

The integration suite (`apps/api/test/ldap/`) runs against a real OpenLDAP over
a real socket — including `ldaps://` with certificate verification **enforced**
against an internal CA, and the negative case proving the same connection fails
without it.

**Active Directory support has not been run against a real AD server by this
suite.** The dialect defaults, `sAMAccountName` filters, nested-group resolution
and referral handling are covered by unit tests against a fake directory;
OpenLDAP does not implement `LDAP_MATCHING_RULE_IN_CHAIN` and cannot exercise
the chain query. Treat first contact with a real domain controller as
commissioning: the likely surprises are attribute names in a customised schema,
a service account without rights to read `memberOf`, and referrals in a
multi-domain forest.
