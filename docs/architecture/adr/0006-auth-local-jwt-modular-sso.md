# ADR-0006 — Local JWT auth in core, modular SSO in enterprise

- **Status:** Accepted
- **Deciders:** Project owner, architect
- **Related:** [ADR-0002](./0002-open-core-runtime-discovery.md)

## Context

The intake fixes authentication as local accounts in the open core, with AD/LDAP/SAML/OIDC delivered by the enterprise layer. The core product must be genuinely usable — not a crippled demo — while the enterprise seam must not be a special case bolted on later.

## Decision

**Authentication is a contract with a core implementation and an optional enterprise override.**

### The seam

`@nexuspuppet/contracts` declares `IAuthProvider` and the injection token `AUTH_PROVIDER`. Core registers `LocalAuthProvider`. If the enterprise package is present it may register its own implementation for the same token, and `CapabilityRegistry` overrides the default ([ADR-0002](./0002-open-core-runtime-discovery.md)).

Everything downstream of authentication — guards, RBAC, controllers, audit — depends on the resulting `AuthenticatedPrincipal`, never on how it was obtained. Adding SAML must change exactly one registration, not a single controller.

### Core: local accounts

- Passwords hashed with **scrypt from `node:crypto`** (N=2^15, r=8, p=1, 32-byte salt, 64-byte key), stored as a self-describing `scrypt$N$r$p$salt$hash` string so parameters can be raised later and verified per-record.

  Chosen over argon2/bcrypt deliberately: both require native compilation, which is a real burden for on-prem operators on locked-down or air-gapped hosts. `node:crypto` scrypt is a memory-hard KDF in the standard library with zero build dependencies. The self-describing format leaves the door open to argon2 in the enterprise layer.

- **Short-lived access JWT** (15 min, HS256, signed with `JWT_SECRET`) plus an **opaque refresh token** persisted as a SHA-256 hash in `RefreshToken`. Refresh tokens rotate on use; reuse of a consumed token revokes the whole family and writes an audit record.

- Tokens are delivered as `HttpOnly`, `SameSite=Lax`, `Secure` cookies. The browser never holds a bearer token in JavaScript-readable storage.

- `JWT_SECRET` has no default. The API refuses to boot without it. A development fallback secret is the kind of thing that reaches production.

### Authorization

Three roles in core: `VIEWER`, `OPERATOR`, `ADMIN`.

| | VIEWER | OPERATOR | ADMIN |
|---|---|---|---|
| Inventory, reports | ✓ | ✓ | ✓ |
| Edit node groups, rules, classes | | ✓ | ✓ |
| Force reconcile | | ✓ | ✓ |
| Manage users, settings, raw PQL | | | ✓ |

RBAC is a separate contract (`IAuthorizationPolicy`) from authentication, because the enterprise layer's finer-grained model — group-scoped and environment-scoped permissions — replaces authorization without touching authentication. Coupling them would force enterprise to reimplement both to change one.

Guards are applied globally and opt out explicitly via `@Public()`. A new controller is protected by default; forgetting the decorator fails closed.

### Enterprise-only endpoints in core

Routes for enterprise capabilities exist in core and return **`501 Not Implemented`** with a machine-readable `capability` field. Not 404 — the feature exists, this deployment lacks it. This keeps the boundary legible to the UI and testable in core CI.

## Implementation notes

Recorded here because they were decided while building, and each is the kind of
thing a future reader would otherwise re-litigate.

**HS256 is implemented on `node:crypto`, not a JWT library.** `jsonwebtoken`
pulls ten transitive dependencies including six lodash micro-packages, which is
a poor supply-chain trade for an air-gapped on-prem product needing exactly one
algorithm. The primitive is Node's HMAC; what is hand-written is the
serialisation and — the part that actually matters — the verification rules.
Each documented JWT failure mode has an adversarial test: `alg: none`, the
RS256→HS256 confusion attack, payload tampering, truncated and empty
signatures, a validly-signed token with no `exp`, and issuer/audience
mismatch. The header is never allowed to select the verifier.

**Refresh tokens are hashed with SHA-256, not scrypt.** They are 256 bits of
CSPRNG output, not a human-chosen secret, so there is no dictionary to slow
down and a KDF per request would buy nothing.

**Reuse detection revokes the whole family.** Presenting an already-consumed
refresh token means either the attacker or the legitimate user is replaying a
token the other spent, and we cannot tell which. Revoking the family is
deliberately more disruptive than ignoring it: one forced login costs less than
a session that might be compromised.

**Login is rate limited, and that is part of the password design.** scrypt costs
~100ms and 32 MiB per verification, which protects stolen hashes but makes an
unthrottled endpoint a cheap denial of service. The limiter is in-memory and
therefore per-replica; a shared store is the obvious upgrade and is not yet
built.

**A route with no `@RequirePermission` is denied, not allowed.** Authentication
alone grants nothing. Access is granted by an explicit decorator, never by
forgetting one.

**`IAuthProvider` carries a `mode`.** A redirect-mode provider (SAML/OIDC)
answers the same `POST /auth/login` with a challenge instead of a session, so
the enterprise layer never adds routes and core never learns they exist. Session
issuance, rotation, and cookie handling stay in core, so swapping the provider
cannot change them.

## Consequences

- Core is fully usable with no external identity infrastructure.
- Adding SSO changes one token registration.
- Session revocation is immediate for refresh tokens, and up to 15 minutes delayed for access tokens. Accepted; a deny-list is available if that window proves unacceptable.
- scrypt is CPU-expensive by design; login endpoints are rate-limited to keep that from becoming a denial-of-service vector.
- Password reset, MFA, and account lockout are **not** in core v1. Lockout after repeated failures is the first thing to add and is tracked as a known gap, not an oversight.

## Alternatives considered

- **Require an external IdP even in core.** Cleanest security posture, but makes the open-core product unusable without infrastructure most evaluators will not stand up. Rejected — it would make "open core" a formality.
- **NextAuth/Auth.js in the web tier.** Puts authentication in the rendering tier, which contradicts the C4 L2 trust boundary and would split authorization across two applications. Rejected.
- **bcrypt or argon2.** Better-known KDFs, but both are native modules. Rejected for on-prem installability; the storage format permits a later switch per-record.
- **Bearer tokens in `localStorage`.** Simpler SPA integration, direct XSS token theft. Rejected.
