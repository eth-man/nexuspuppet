# ADR-0020 — How a program acts on Production

- **Status:** Accepted (2026-08-06)
- **Deciders:** Architect
- **Related:** [ADR-0006](./0006-auth-local-jwt-modular-sso.md), [ADR-0015](./0015-hybrid-authentication.md), [ADR-0018](./0018-custom-roles.md)

## Context

Work has reached the point where a program — an agent session, a script, a CI
job — needs to make a real change on Production: create a node group, assign a
class, trigger materialization. Until now every Production change was made by a
human in the console.

The obvious shortcut is to hand the program the operator's admin login. That
breaks the one record built to answer *who did this*. Every classification write
lands in `AuditLog` inside the same transaction as the change itself, with an
`actorUserId` and a denormalised `actorEmail`. Share one credential between a
person and a program and that column stops distinguishing them — not degraded,
**wrong**, on every row either of them touches. Nothing downstream recovers the
distinction afterwards.

The product also has no machine credential. The schema holds `Role`, `User` and
`RefreshToken`; there is no API key, token or scope model. The strongest thing
that can be issued to a program today is a human's password.

So the question is not "which credential type" — there is one — but what
identity holds it, what it may do, and how it is taken away.

## Decision

**A dedicated automation account, resting inert, granted for one task at a time
and revoked afterwards.**

### 1. A distinct identity, never a shared login

`automation@nexuspuppet.invalid`, display name naming whoever drives it
(`Automation (Claude Code)`). `.invalid` is reserved by RFC 6761 to guarantee
non-resolution, so the address cannot be mistaken for a person or mailed.

This exists for the audit trail and for nothing else. A program's writes must be
distinguishable from a person's forever, including after the account is gone —
which `actorEmail` already provides, being denormalised precisely so the record
survives deletion.

### 2. It rests deactivated, at a role that grants nothing it needs

Between tasks the account is `isActive: false` and parked. Granting activates
it; revoking deactivates it again. A parked credential that cannot authenticate
at all is a stronger resting state than one that authenticates and is merely
limited.

### 3. Revocation, stated exactly

The three levers do not reach the same things, and the differences are not
intuitive. Written out because getting this wrong produces false confidence:

| Lever | What it reaches | Lag |
|---|---|---|
| Empty the role's permissions | Every request, including in-flight sessions | Next request; ≤10s across replicas |
| Deactivate the account | New logins and token refreshes | Immediate for those; **does not** stop a live access token |
| Reset the password | Same, and revokes every refresh token | Immediate for those; same access-token caveat |
| Change which role it holds | Nothing, until the token is refreshed | Up to one `ACCESS_TOKEN_TTL` |

The trap is the last row. A user's role is a **claim in the access token**,
resolved by `verifyAccessToken` from the JWT and not from the database, so
demotion does not bite until refresh. What `RoleRegistry` re-reads per request
is the *role's permission set*, not the *user's role assignment*. Demoting an
account and believing it disarmed is therefore wrong for up to a token lifetime.

**Emptying the role's permissions is the only lever that reaches a session
already running.** That is why §4 gives the account a role of its own.

Production sets `ACCESS_TOKEN_TTL=15m`, which bounds every case above.

### 4. Its own role, so the kill switch exists

Role `AUTOMATION`, holding `inventory:read`, `classification:read`,
`classification:write` and `materialization:trigger` — `OPERATOR` minus
`reports:read`. Custom roles require the `rbac.custom` capability
([ADR-0018](./0018-custom-roles.md)); Production runs the enterprise edition.

A dedicated role is not tidiness. Emptying `VIEWER` to revoke one program would
revoke every viewer, so without its own role the instant lever from §3 does not
exist at all.

### 5. The credential is dead between tasks

The password is reset when granting and reset again to a random value when
revoking. `resetPassword` revokes every refresh token as a side effect, so a
rotation is also a session kill.

Between tasks the stored password authenticates nothing. Without this, parking
the account is undone by a single forgotten revocation — the resting state would
still contain a working Production credential.

The password lives in a `0600` file on the operator's workstation, never in a
transcript, an issue, a commit or a log.

### 6. Local, not a directory account

`authSource: 'local'`. An Active Directory service account was considered and is
the more conventional answer, but the grant itself — `isActive` and the role —
lives in NexusPuppet either way. Putting the credential in AD would not move
those; it would add a second system that must also be in the right state, so
each grant becomes two operations in two places and each revocation acquires a
way to be half-done. It would also make automation depend on AD being reachable.

### Binding constraints

1. **The automation account must never hold `users:manage` or
   `settings:manage`.** Either one lets it widen its own permissions, and the
   whole design reduces to a shared admin login with extra steps.
2. **Every grant has a revocation.** An account left active is the single
   failure mode this ADR has; it does not announce itself, and the design gives
   no protection against it beyond someone remembering.
3. **No human authenticates as it.** The moment a person uses it, the audit
   trail it exists to protect is worthless.

## Consequences

### Gained

- Audit attribution survives: a program's writes are permanently distinguishable
  from a person's.
- A revocation that reaches a live session, which no built-in role permits.
- No credential at rest between tasks.
- Least privilege by construction — the account cannot administer, configure, or
  run raw PQL.

### Paid

- Three steps to grant and three to revoke, all manual, all skippable.
- A credential file that is *supposed* to be stale, so staleness no longer looks
  like a fault.
- A 403 mid-task whenever the minimal permission set turns out to be too
  minimal. Deliberate: a 403 that teaches the boundary beats a permission nobody
  remembers granting.
- Production-only. Staging is not covered here and should not silently inherit
  this.

## Alternatives considered

**Share the operator's admin login.** Rejected: it makes `actorUserId` and
`actorEmail` wrong on every affected row, which is not a degradation of the
audit log but a corruption of it.

**An Active Directory service account.** Rejected per §6 — it splits a single
grant across two systems without moving the toggles that matter.

**A real machine credential** — a token model with scopes and expiry. The
correct long-term answer, and out of scope here; filed as a gap. The current
position, that the strongest credential issuable to a program is a human's
password, is a genuine limitation and should be recorded as one rather than
rationalised.

**Enforce `isActive` on every request.** Would remove the access-token lag for
everyone, and `RoleRegistry` already shows the house pattern — cache, invalidate
on write, refresh on a timer. Rejected here only because it changes the
authorization read path for every user in the product, which deserves its own
ADR rather than arriving as a side effect of a service-account decision.

**Create and delete the account per task.** Viable — attribution survives via
`actorEmail`. Rejected because it buys nothing over parking, fragments the audit
history across a new account id each time, and makes the routine operation a
destructive one.
