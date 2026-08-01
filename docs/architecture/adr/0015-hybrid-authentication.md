# ADR-0015 — Hybrid authentication: local and directory accounts at the same time

- **Status:** Proposed
- **Deciders:** Architect
- **Related:** [ADR-0002](./0002-open-core-runtime-discovery.md), [ADR-0006](./0006-auth-local-jwt-modular-sso.md), [ADR-0014](./0014-enterprise-licensing.md)

## Context

**Enabling a directory locks every local account out, permanently, with no way back.**

Setting `LDAP_URL` or `OIDC_ISSUER` makes the enterprise layer override `AUTH_PROVIDER`. `TokenService` injects exactly one `IAuthProvider`, so the local provider is not shadowed — it is *gone*. At the next restart:

- `admin@example.com`, and every `authSource: local` account, can no longer sign in.
- Directory users cannot sign in either until an account exists for each, because there is deliberately no auto-provisioning.

If the accounts were not provisioned first, that is everybody locked out. Confirmed on a clean VM, not reasoned about.

The escape does not exist. Removing `LDAP_URL` makes the API refuse to boot — a throw from `register()` is fatal by design (ADR-0002) — so backing the change out is not possible either. Recovery was a direct `INSERT` into `users`, bypassing the audit trail. That is documented in [DEPLOYMENT.md §2](../../../DEPLOYMENT.md) ([#61](https://github.com/eth-man/nexuspuppet/pull/61)) as a hazard, which is the right thing to do with a defect you have not fixed yet, and no substitute for fixing it.

### Why this blocks licensing

[ADR-0014](./0014-enterprise-licensing.md) §2 promises that an expired licence degrades to core and never stops the estate. §3 concedes the authentication case is not harmless and mandates a break-glass — `LICENSE_GRACE_LOGIN` — to re-enable local admin authentication for recovery.

That mechanism exists because the local provider is *replaced* rather than *supplemented*. Fix the replacement and the special case disappears: an expired licence deregisters the directory provider, local accounts keep working, and "degrades to core" becomes true rather than aspirational.

**Hybrid authentication is therefore a prerequisite for licensing, not a sibling feature.** Shipping licensing first would ship graceful degradation that degrades into an outage.

## Decision

### 1. `authSource` on the account is authoritative. One account, one provider

A login resolves the account first, reads its `authSource`, and dispatches to exactly that provider. No fallback, no second attempt, no guessing.

**This is a security decision before it is an ergonomic one.** The obvious alternative — try local, then the directory — means anyone who can create a local account can shadow a directory identity and bypass the directory entirely, including whatever conditional access, MFA or offboarding it enforces. Chaining providers turns account creation into an authentication bypass.

It also makes a latent hazard inert. The create-user dialog notes that an external account is given no password because "a stored hash would keep it usable through local auth after the directory revoked access" (`apps/web/src/components/data/users-panel.tsx`). Under strict dispatch a leftover hash is never consulted — the account's `authSource` is `ldap`, so the local provider is never asked. The reasoning stays and the hash should still not be there, but it stops being exploitable.

**The bootstrap administrator is always `local`.** That is what makes break-glass structural rather than a flag somebody has to remember to set.

### 2. Dispatch must not become a user-enumeration oracle

The current local provider is careful about this and the care is documented in the code: an absent user is verified against a dummy hash, and a locked account still pays the full scrypt cost, because "skipping the hash here would make a locked account answer in a millisecond while every other rejection takes ~100ms".

Dispatching by `authSource` threatens exactly that property, and more sharply. A local rejection costs one scrypt (~100ms). A directory rejection costs a network round trip to the LDAP server — plausibly 5ms on a LAN, plausibly 2s on a bad day. An attacker who can time responses learns which of *no account*, *local account* and *directory account* they are looking at, without ever guessing a password. That is a live map of which staff are provisioned where.

**Therefore: a failed login returns after a floor derived from the slowest configured provider, and the resolver — not each provider — owns that floor.** Providers stay honest about their own latency; the resolver makes every refusal indistinguishable. The floor is measured and configurable, because a hardcoded constant will be wrong for somebody's directory.

This is the part of the change most likely to be got wrong by accident later, so it needs a test that fails on timing, not only on status codes.

### 3. Providers register additively. Core owns the resolver and the local provider

This requires amending the registration model, and the amendment is the substance of this ADR.

**ADR-0002 §5's model is override-based**: `CapabilityRegistration` is `{ token, provider }`, and the registry replaces core's binding. That is right for `AUDIT_SINK`, where there is exactly one sink, and wrong for authentication, where there must be at least two.

So:

- Core binds an `AuthProviderResolver` and keeps `LocalAuthProvider` bound unconditionally.
- The enterprise layer **contributes** its provider to a collection rather than replacing a token.
- The resolver maps `authSource` → provider and refuses unknown sources.
- **`IAuthProvider` does not change.** Existing providers implement exactly what they implement today; only who calls them moves.

`TokenService` injects the resolver instead of a provider. The enterprise layer's `register()` changes shape for authentication only; `AUDIT_SINK` and `AUDIT_TRANSPORT` keep overriding, because for those it is correct.

**The local provider must not be removable by the enterprise layer.** Not "should not" — the registry must refuse a registration that would displace it. An enterprise build that could unbind local authentication can lock an operator out of their own console, which is the defect this ADR exists to close; leaving that possible and merely documenting it would be repeating the mistake one layer down.

### 4. Configuration precedence: environment is the bootstrap baseline, the database wins once set

For the settings UI that follows this work:

- Environment variables configure a provider at first boot, before any UI exists to use.
- Once a configuration row exists, it takes precedence.
- **Precedence is per provider configuration, not per field.** Half the LDAP settings from the environment and half from the database is not a feature; it is an unreproducible bug report.

**This needs an escape hatch, or it recreates the lockout in a new place.** A directory configuration saved through the UI that does not work leaves an operator unable to authenticate *and* unable to override it from the environment, because the database wins. So: `AUTH_CONFIG_SOURCE=env` forces the environment and ignores stored configuration, as a documented recovery path requiring host access — which the operator has, since they are running the thing.

Bind credentials stored in the database are secrets: never returned by any read endpoint, write-only in the UI, and encrypted at rest with a key that is not in the same database.

### 5. What does not change

- **No auto-provisioning.** A directory user with no NexusPuppet account is still refused. Authentication is not authorisation, and silent account creation from a directory is how an estate acquires administrators nobody approved.
- **Group mapping remains authoritative for role.** An account stored `VIEWER` whose group maps to `ADMIN` signs in as `ADMIN`.
- **Refusal messages stay identical** across every failure mode, as they are today.

## Consequences

### What this buys

- An administrator cannot be locked out by a directory that is misconfigured, unreachable, or newly enabled.
- ADR-0014's "degrade to core" becomes literally true, and `LICENSE_GRACE_LOGIN` is no longer needed — the graceful path is the normal path.
- A directory can be introduced incrementally: enable it, migrate accounts one at a time, keep local accounts for service and break-glass use.
- The settings UI becomes safe to build, because a bad configuration saved through it is recoverable.

### What it costs

- An amendment to ADR-0002's registration model, and a new failure mode in the registry — a rejected registration — that must be tested.
- The timing floor is real work and easy to regress silently.
- Two authentication paths are two paths to keep correct. Account lockout, audit records and rate limiting must behave identically on both, which is a test-matrix cost rather than a design one.

### What it does NOT buy

- **It is not multi-directory.** One directory provider at a time, as today. Several LDAP servers, or LDAP and OIDC together, is a larger change and not required by anything here.
- **It does not let one person authenticate two ways.** That is the shadowing bypass, refused in §1.
- **It does not migrate accounts.** Changing an account's `authSource` remains an administrative action, and one that should clear any stored password hash.

## Alternatives considered

**Chain the providers: try local, then the directory.** Simplest, and the usual first instinct. Rejected: it makes local account creation an authentication bypass for directory-managed identities (§1). It also makes the timing leak worse, since a directory rejection is then always preceded by a full local rejection.

**Keep the override model; have the enterprise provider delegate to local internally.** No change to ADR-0002. Rejected: it puts local-authentication behaviour inside the enterprise layer, so whether an operator can break the glass depends on a private build honouring a convention. The break-glass has to be a property of core.

**A dedicated break-glass login path outside the normal flow.** A separate endpoint accepting only the bootstrap admin. Rejected as a second authentication path with its own bugs, and because an emergency-only path is exercised for the first time during the emergency.

**Environment-only configuration, no database.** Avoids §4 entirely. Rejected because the settings UI is a stated requirement, and because editing `.env` and restarting to change a search base is the rigidity being complained about.

## Open questions

1. **What is the timing floor, in milliseconds, and is it measured or configured?** A constant is wrong for somebody. Measuring the slowest provider at boot is self-tuning but makes login latency depend on a startup probe. Leaning towards a configured floor with a sane default and a warning when a provider regularly exceeds it.

2. **Where does the encryption key for stored bind credentials live?** `JWT_SECRET` is available and would be reuse of a key for a second purpose, which is usually a mistake. A separate `CONFIG_ENCRYPTION_KEY` is cleaner and is one more thing to lose.

3. **What happens to sessions belonging to a provider that is deregistered mid-flight** — licence expiry, or a provider disabled in the UI? Existing refresh tokens resolve through the provider. ADR-0014 §3 says existing sessions continue until their refresh tokens expire; that needs to be true of a resolver that no longer has the provider, which suggests refresh must fail closed and gracefully rather than throw on an unknown `authSource`.

4. **Does the login form need to change?** With one provider the form asks for whatever `identifierLabel` says. With two, the label is ambiguous until the account is resolved — and resolving before the password is entered would leak which accounts exist. Probably: keep one form, label it `Email`, resolve server-side, and never tell the browser which provider answered.

5. **Should `authSource` be visible in the users table?** It already is. Worth confirming it stays, because with two providers live it stops being trivia and becomes the field that explains why a login behaves the way it does.
