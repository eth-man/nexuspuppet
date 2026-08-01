# ADR-0014 — Enterprise licensing: a signed offline claim, and degradation that never touches the estate

- **Status:** Proposed
- **Deciders:** Architect
- **Related:** [ADR-0002](./0002-open-core-runtime-discovery.md), [ADR-0003](./0003-enc-generate-dont-serve.md), [ADR-0006](./0006-auth-local-jwt-modular-sso.md), [ADR-0007](./0007-apache-2-0-for-public-core.md)

## Context

**The licensing seam exists and nothing implements it.**

`LICENSE_SERVICE`, `ILicenseService` and `LicenseStatus` are all defined in contracts. `LicenseStatus` already carries `licensed`, `capabilities[]`, `expiresAt` and `subject` — the shape of a real entitlement. `CoreLicenseService` returns `{ licensed: false, capabilities: [] }`, which is correct for core.

A comment above it reads:

> The enterprise layer overrides `LICENSE_SERVICE` with one that validates a real licence.

It does not. The enterprise `register()` returns exactly three token overrides — `AUTH_PROVIDER`, `AUDIT_SINK`, `AUDIT_TRANSPORT`. `LICENSE_SERVICE` appears nowhere outside core's own binding.

So today an enterprise capability activates when two things are true: the package is present in the image, and the relevant environment variable is set (`OIDC_ISSUER`, the LDAP block, `AUDIT_EXPORT_URL`). Nothing validates anything. `GET /capabilities` reports what the **build** contains, not what the deployment is entitled to.

This is [LESSONS §1](../../LESSONS.md) again — a seam declared and never resolved — and it survived for the same reason the others did: core's answer is correct in core, so no test ever notices the other half is missing.

**The comment is the actively harmful part.** A reader auditing entitlement sees a sentence asserting a mechanism, and stops looking.

### What makes this different from ordinary licensing

This product's job is to keep an estate converging. Under [ADR-0003](./0003-enc-generate-dont-serve.md) there is deliberately **no synchronous path** from puppetserver to this application: classification is materialised to YAML and read with `cat`. A NexusPuppet outage cannot stop a Puppet run.

A licence check that can stop the API is therefore a licence check that can undo the central architectural guarantee of the product — not immediately, but as soon as classification stops being written and the files on disk go stale. Any design here has to be judged against that first and against revenue protection second.

## Decision

### 1. A signed offline claim, verified locally. No licence server

The licence is a **JWT**, signed with an offline private key held by the vendor, verified against a public key **compiled into the enterprise build**. It is supplied as a mounted file, path in `NEXUSPUPPET_LICENSE_FILE`.

Claims map onto the existing `LicenseStatus`:

| Claim | Meaning |
| --- | --- |
| `sub` | Licensed organisation — shown in Settings, never used for a decision |
| `capabilities` | Capability names from `CAPABILITIES`, e.g. `sso.oidc`, `directory.ldap` |
| `exp` | Expiry |
| `iat`, `iss` | Issued-at and issuer, for support diagnostics |

**No phone-home, and this is not negotiable.** The deployments this product targets are frequently air-gapped or egress-filtered; an entitlement check that needs the internet fails exactly where Puppet is most load-bearing. It also creates an outbound channel from a host holding PuppetDB credentials, which [ADR-0004](./0004-puppetdb-read-only-mtls.md) works hard to keep narrow.

**A file, not an environment variable.** A JWT is long, and environment variables leak into `docker inspect`, process listings, crash reporters and support bundles. Mounted files are already the convention here for private keys ([ADR-0013](./0013-console-tls-private-ca.md) §2) and PuppetDB material.

**Asymmetric, so verification never carries a secret.** The enterprise build ships a public key. A stolen image yields no ability to mint licences.

### 2. Expiry degrades to core. It never stops the API

This is the load-bearing decision and the reason this ADR exists.

On an expired or invalid licence:

- The API **starts**, and stays running.
- Enterprise capabilities are **not registered**. Core defaults own every token.
- Classification, materialisation, the ENC and the whole read path continue **unchanged**.
- The condition is loud: `ERROR` at boot, `GET /capabilities` reports `licensed: false` with the reason, and a persistent banner appears in the console for anyone holding `settings:manage`.

The estate keeps converging. An operator's Puppet runs do not know or care that a licence lapsed.

**The alternative — refuse to boot — was considered and rejected outright.** A lapsed invoice is a commercial problem. Halting classification turns it into an outage in someone else's infrastructure, at an hour nobody chose, and the failure would be at its worst precisely where this product is most valuable: a large estate, mid-incident, where the console is how people are trying to fix things.

There is also a self-interested argument, and it points the same way. A vendor whose licence expiry can take down an estate is a vendor operations teams route around.

### 3. Degradation is not silent, and the fallback must be honest

Falling back to core is not always harmless, and the design must not pretend otherwise.

**The dangerous case is authentication.** If `AUTH_PROVIDER` is enterprise LDAP or OIDC and the licence lapses, dropping to core's local provider means every directory-authenticated user loses their way in — while any local account still works. That is a lockout on one axis and, if local accounts were provisioned loosely, a widened door on the other.

Therefore:

- **`AUTH_PROVIDER` degrades but does not silently swap.** On an expired licence with an enterprise provider configured, the API starts, keeps serving reads and classification, and refuses **new** interactive logins through the lapsed provider with an explicit message naming the licence as the cause. Existing sessions continue until their refresh tokens expire.
- **A break-glass path is mandatory.** `LICENSE_GRACE_LOGIN=true` re-enables local admin authentication for recovery. It is loud, audited, and exists so that "the licence expired" is never "nobody can log in to fix it".
- **`AUDIT_SINK` degradation is the opposite case and must fail closed to the database.** Losing audit *export* must never lose audit *records*; core's `PrismaAuditSink` keeps writing to Postgres, and the export queue holds rather than drops.

### 4. A grace period, measured in weeks

`exp` starts a **30-day grace window** rather than an immediate cutoff. Inside it everything keeps working and the warnings escalate. After it, §2 and §3 apply.

Renewals cross purchasing departments and time zones. The failure this avoids — a Friday expiry nobody saw — is common, cheap to prevent, and expensive to experience.

### 5. Verification lives in the enterprise layer, not in core

Core keeps `CoreLicenseService` returning `{ licensed: false }` and gains nothing. The verification code, the public key and the grace logic ship in `packages/enterprise/`.

Core must not contain a licence checker. Under [ADR-0007](./0007-apache-2-0-for-public-core.md) core is Apache-2.0 and complete on its own; an Apache-2.0 tree carrying entitlement enforcement invites exactly the fork that removes it, and would be answering a question nobody asked of core.

The enterprise layer registers `LICENSE_SERVICE` — **which is the specific defect this ADR closes.**

### 6. Capabilities are checked at registration, then at use

`register()` filters its registrations against the verified capability set: a build containing OIDC and a licence without `sso.oidc` registers no OIDC provider. `ILicenseService.has()` remains the runtime check for anything that must be re-evaluated after boot, such as the grace window elapsing while the process runs.

## Consequences

### What this buys

- The declared seam becomes real, and `GET /capabilities` starts describing entitlement rather than build contents.
- Offline, air-gapped and egress-filtered deployments are first-class.
- The strongest thing we can say to an operations team stays true: **nothing here can stop your estate converging**, including our own commercial terms.

### What it costs

- Key custody becomes a vendor responsibility. The signing key must outlive every licence it has issued, and rotation means shipping a build carrying both public keys.
- Clock skew and stopped clocks become licensing bugs. Verification must tolerate modest skew and treat an implausible system time as a warning, not an expiry.
- A grace period plus degradation is more states than a boolean, and every one needs a test. The states are: valid, in-grace, expired-degraded, malformed, absent.

### What it does NOT buy

- **It is not piracy prevention.** Anyone holding the enterprise package can patch out verification; the code is on their disk. This makes entitlement *legible and auditable* for honest operators, which is the achievable goal. Treating it as a copy-protection scheme would justify hostile measures — phone-home, hardware binding — that this ADR rejects.
- **It does not meter usage.** No node counting, no seat counting. Those need telemetry, and telemetry needs the phone-home this ADR declines.

## Alternatives considered

**A licence server, checked periodically.** Enables real metering and instant revocation. Rejected: it fails closed in exactly the environments this product is deployed into, and adds an outbound channel from a host holding PuppetDB credentials.

**A signed licence, but refuse to boot on expiry.** Simplest to implement and to reason about. Rejected on the estate-stability grounds in §2.

**No licensing; entitlement by contract and by who holds the package.** Honest, and close to today's behaviour. Rejected because `LicenseStatus` already promises `expiresAt` and `subject` through the API — the contract asserts an entitlement model, so either implement it or remove it from contracts. Leaving a documented field permanently unpopulated is the state this ADR exists to end.

**Per-capability licence files.** More granular, and worse: five files to mount, five to renew, and no single answer to "what is this deployment entitled to".

## Open questions

1. **Where is the licence file mounted by default?** `/etc/nexuspuppet/license/license.jwt` follows the `/etc/nexuspuppet/{certs,tls}` convention, but the licence is not key material — it is world-readable by nature, since it is a signed public claim. `0444` is probably right, and it should not sit in a directory the API cannot read.

2. **What does the console show during grace?** A dismissible banner risks being dismissed on day 1 and never seen again; a permanent one trains people to ignore banners. Escalating from dismissible to permanent in the final week is the likely answer, but it needs a decision.

3. **How is a licence replaced without a restart?** Re-reading the file on a timer would allow a renewal to take effect in place — attractive, but it means capability registration can change at runtime, which the DI graph does not currently support. A restart is acceptable for v1; the question is whether that closes off in-place renewal later.

4. **Does the grace window survive a restart?** If grace is computed purely from `exp`, yes, and it needs no state. If it is ever anchored to first-observed-expiry, it needs persistence and becomes tamperable. Prefer the stateless reading unless something forces otherwise.

5. **What happens to an audit export queue that fills during a long degradation?** The records are safe in Postgres, but the delivery queue is unbounded. It needs either a retention rule or a documented ceiling before this ships.
