# ADR-0031 — Standard directory sign-in: username, linked accounts, created on first sign-in

- **Status:** Accepted
- **Deciders:** Project owner, architect
- **Related:** [ADR-0005](./0005-postgres-prisma-local-state.md), [ADR-0015](./0015-hybrid-authentication.md) (amends §1 and §5), [ADR-0018](./0018-custom-roles.md), [ADR-0023](./0023-several-authentication-sources.md), [ADR-0029](./0029-directory-from-the-console.md), [ADR-0030](./0030-ldap-connection-fields.md) (amends §3)

## Context

Two operator reports, both reproduced on staging against a real Active Directory, on the same day.

**The first.** A person in the AD group mapped to `ADMIN` signs in and is refused. The log says *Login refused for "&lt;email&gt;": no account exists. Directory users are not provisioned automatically (ADR-0015 §5)*. The operator expected what FortiGate, Grafana, GitLab and Jenkins do: a person who authenticates against the directory **and** is in a mapped group gets an account.

**The second, after the operator created the account by hand.** The same person is still refused, now with *no directory entry matched under … (searched sAMAccountName, userPrincipalName, mail)*. The account was created with the person's email, `jdoe@example.com`. In that AD — as in many — the UPN suffix is `.local` (`jdoe@corp.local`) and `mail` is **empty**, because there is no Exchange. Nothing on the entry carries the address the account was created with, so nothing could ever find it. And the person would rather type `jdoe`, which is what every other AD-backed login they own accepts.

Both come from one design, which ADR-0015 and ADR-0030 recorded and the code faithfully implemented:

1. The NexusPuppet account is looked up by the **email typed**, before any directory is asked.
2. That email then has to **also** be something the directory can search by — `mail` or UPN.
3. No account, no directory: refused before the directory is contacted.

The first rule makes `jdoe` impossible. The second makes the account's key depend on attributes that real directories leave empty or set to an internal domain. The third makes every directory user an administrator's chore. The industry pattern inverts the first rule: **ask the directory who this is, then find their account.**

## Decision

**LDAP sign-in is directory-first. People sign in with their username, UPN or email; the directory authenticates them; the account is the one LINKED to their directory entry by its stable id — linked at their first sign-in, or created then where the operator turned that on.**

### 1. What people type

For LDAP the login field accepts the **username** (`sAMAccountName`, `uid`), the **UPN**, or the **email**, and is labelled **Username or email**. Local accounts still sign in with their email; the field is one text input, and the label is the directory's when one is configured.

- **AD's default filter is unchanged**: `(&(objectClass=user)(objectCategory=person)(|(sAMAccountName={{input}})(userPrincipalName={{input}})(mail={{input}})))`.
- **OpenLDAP's default gains `uid`**: `(&(objectClass=person)(|(uid={{input}})(mail={{input}})))`. A stored or environment filter exactly equal to the old `mail`-only default is read as the default, as ADR-0030's amendment did for AD; any other filter is used as written.
- **More than one entry is refused**, not guessed (ADR-0030, unchanged).
- **Simple bind** with `{username}` takes a bare username. Someone who types an *address* with a `{username}` pattern must type one of their entry's own (mail or UPN) — so `alice@two.example` still cannot use the entry of `alice@one.example`. A pattern built from `{email}` binds as the whole address, so there the label stays **Email**.

### 2. The resolver's order

1. **Normalise** the identifier: trimmed, lower-cased for comparison. AD's and OpenLDAP's default matching rules for these attributes are case-insensitive, and account emails are stored lower-case.
2. **An account whose email is what was typed and whose `authSource` is not `ldap`** — a local account above all — is dispatched to its own provider and to nothing else, exactly as before. **ADR-0015 §1's no-shadowing rule stands:** a local account is never reached through a directory, and a directory password never opens a local account.
3. **Otherwise, with LDAP configured, the directory is asked first** — search, then bind as the DN found (or Simple bind), then group resolution and role mapping. An `ldap` account whose email is what was typed takes this path too.
4. **Otherwise** the request is refused as before.

### 3. Which account

After the person has authenticated **and** resolved to at least one mapped role:

1. **Linked.** The account whose `directoryId` is the entry's stable id. Whatever was typed, and however their mail or UPN has changed since.
2. **Linkable.** An `ldap` account with no `directoryId` whose email is:
    - what was typed, when the directory **vouched** for it — the search matched this entry by it, or a Simple bind bound as it; or
    - the entry's `mail` or UPN, **when that address, searched for through the configured filter, finds this entry and no other.** Mail is unique in neither directory, and one entry's mail can be another's UPN; without this check, an account an administrator created for person B could be linked to person A who merely carries the same address. Simple bind has no account to search with, so there only a vouched address links.

    It is linked in one transaction with its audit row (§4). **Never a `local` account; never an account already linked to a different entry** — that is refused with its own log line, and re-linking is an administrator's act (§6).
3. **Created** — only with `autoCreateAccounts` on (§5). The email is the entry's `mail`, else its UPN, else its username if that is an address; none of them is refused with a log line. Display name from the entry (else the email, trimmed to what an account may hold). Role: the primary resolved role, with `role` and `roleId` written together, as every other user write does. `directoryId` set from the start. Active.
4. **Else refused**, generically, with the precise reason in the log.

A **deactivated** account found at step 1 or 2 is refused as `ACCOUNT_DISABLED` — never recreated, never reactivated, and not linked if it was not yet.

**The stable id.** AD's `objectGUID` is 16 raw bytes, requested as a Buffer (decoded as text it is mangled beyond recovery) and converted to the GUID string AD's own tools print — Microsoft's mixed-endian layout, first three fields little-endian — lower-cased. OpenLDAP's `entryUUID` is already text, and is operational, so it is requested by name. Both are stored as canonical lower-case UUIDs. Neither attribute is configurable: pointing it at something mutable would silently re-key every account.

**When the directory hides the id** from the account that searched — an ACL — nothing can be linked or created, and step 2 falls back to the account carrying a vouched or unique address, unlinked: exactly how every directory sign-in worked before this decision, so such a deployment keeps working. The log says so, naming the attribute to grant.

### 4. Every write is audited, in the same transaction

As ADR-0005 and every other user write require:

| Write | Audit row |
|---|---|
| Account created | `user.create`, `entityType` `User`, `after: { email, role, authSource: 'ldap', directoryId, via: 'directory-sign-in' }` |
| Account linked | `user.directory.link`, `before: { email, directoryId: null }`, `after: { email, authSource, directoryId, via }` |

The actor is `directory:ldap` with `actorUserId` null — a marker no address can be, in the same shape as the CLI's `cli:deploy.sh@host`. No user did this: the person had no account or no link until this write, and the administrator who configured the directory did so in a row of its own. IP address and user agent are the sign-in request's. The rows go through `AUDIT_SINK`, so they are forwarded like any other.

The link is a conditional update — this account, this source, no link yet — so it cannot overwrite a link written a moment earlier, nor touch an account moved off `ldap` meanwhile.

### 5. Automatic creation is opt-in, per directory

`autoCreateAccounts` in the stored LDAP configuration, default **false**: every configuration saved before this decision, and every environment configuration, behaves as it did — an authenticated person with no account is refused. Environment parity: `LDAP_AUTO_CREATE_ACCOUNTS=true|false`; anything else refuses to boot, like every malformed `LDAP_*` value. In the console it is a checkbox under **Role mappings** — *Create accounts automatically for people in a mapped group* — because ticking it changes what the mapping table means, and it is saved with the form. Linking (§3.2) is not opt-in: it creates nobody, and only ever attaches an `ldap` account an administrator already made.

### 6. Schema

`users.directoryId`, nullable, unique — the one migration in this change. **No backfill:** an existing directory account is linked at its next sign-in, by its email matching the entry's. Unique, so one entry can never open two accounts.

**Moving an account to another source clears it.** The link says which entry an account belongs to; after a move it belongs to none until a directory sign-in links it again. That is also how an administrator re-links a person who has a new entry (a new domain, say): move the account to local and back. A sign-in never re-links on its own.

### 7. Concurrency

Two first sign-ins of one person at once both reach the insert; Postgres's unique `email` and `directoryId` refuse the second, which re-reads the account **linked to this entry** and continues with it — no 500, one account, one audit row. Two links race the same way. What took the email meanwhile, if it is not linked to this entry — a local account an administrator created in the same moment — is refused.

### 8. Refusals, timing and the log

- **One answer.** For an identifier no account has, every refusal — no entry, a wrong password, no mapped group, the directory unreachable, no account that may be used — is the same `INVALID_CREDENTIALS`. An unreachable directory must not look different from "no such person" to somebody probing names. For an `ldap` account's own email the provider's answer stands, as before.
- **The floor.** Directory-first sign-in runs inside the resolver's timing floor (ADR-0015 §2). It is now a path where an identifier with no account reaches a directory — a bind's worth of time — and without the floor that difference would say which names the directory knows. Tested: a name nobody has and a wrong password both take the floor, in unit tests and against the real OpenLDAP.
- **The login limiter** runs before the resolver, for every path, unchanged.
- **The log** says which: *no directory entry matched*, *the directory rejected the password*, *member of no mapped group — no account linked or created*, *no NexusPuppet account is linked to that entry or carries one of its addresses (…)*, *is a "local" account, which is never linked*, *linked to a different directory entry … never re-linked*, *does not identify only that entry … not used to link*, *did not return its stable id*, *no email address … to key an account by*, *Created an account for …*, *Linked the account …*. For an identifier no account has, the refusal lines are throttled to ten a minute with a count of the rest: the login limiter keys on address and IP, so it does not bound a stranger varying the name. No line contains the password.

### 9. Security

- **With automatic creation on, the role mappings are the access-control list.** Anyone who can authenticate to the directory and is in a mapped group gets an account. Map specific groups — never `Domain Users` or an equivalent. The console says so beside the checkbox, and the guides say so where it is described.
- **Every identifier with no local account now reaches the directory.** Before, only an address that was already an `ldap` account's did. Timing stays under the floor (above). What changes is the **directory's** view: a stranger can now cause failed binds against any directory account, not only those with a NexusPuppet account, and an AD lockout policy counts them. This is true of every LDAP-backed login page; the login limiter bounds it per source address and name. Do not expose the console where the directory's lockout policy is a concern.
- **Local accounts are untouched.** A local account is dispatched by its own email to the local provider only, is never a link candidate, and is never created this way.

### 10. Out of scope

**OIDC.** A redirect provider never reaches this path, and its linking (by `sub`) and creation have their own questions — which claim is the key, and whether the issuer's `email_verified` can be trusted. A follow-up. Until then OIDC accounts are created by an administrator first, as ADR-0015 §5 said.

## Consequences

- **People sign in the way every other AD-backed product lets them**: `jdoe`. The two staging reports are fixed by construction — the account is found by the entry, so an empty `mail` or a `.local` UPN no longer matters.
- **An operator who ticks one box stops creating accounts by hand.** One who does not tick it still creates them, but with any address on the entry, and it is linked at first sign-in.
- **A person's mail or UPN can change** without stranding their account.
- **One migration**, additive and nullable; `deploy.sh` applies it. Downgrading leaves an unused column.
- **A new class of refusal**: an account linked to an entry that no longer exists or has been recreated. It is logged, and fixed by moving the account to local and back.
- **The directory sees more failed binds**, as above.
- **ADR-0015 §1 and §5 are amended**: dispatch for LDAP is directory-first, and accounts may be created at sign-in where that is turned on. **ADR-0030 §3 is amended**: people no longer always sign in with their account's email.

## Alternatives considered

- **Keep looking up the account by the typed email first, and only add creation.** Rejected. It fixes the first report and not the second: the account's key would still have to be on the entry as `mail` or UPN, which a real AD leaves empty or internal, and `jdoe` would still be refused.
- **Find the account by the typed username's local part** (`jdoe` → `jdoe@…`). Rejected: it is a guess about two namespaces nobody keeps in step, and the guess decides whose account a password opens.
- **Link by DN.** Rejected: a DN changes when an entry is renamed or moved between OUs, which is routine; the stable id does not.
- **Link by the entry's mail without checking it names only this entry.** Rejected: mail is not unique, and on AD one entry's mail can be another's UPN — the account would go to whoever signed in first.
- **Re-link automatically when the id changes.** Rejected: an id that changes is a *different* entry, and opening the old person's account to it is exactly the takeover linking exists to prevent.
- **Creation on by default.** Rejected: every existing deployment would start admitting anybody in a mapped group at the next sign-in, a change of who can get in that nobody chose.
- **Make the id attribute configurable.** Rejected for now: the two directories have one each, and a configurable one is a way to re-key every account by accident.
