# ADR-0027 — One product: the enterprise seam is removed

- **Status:** Accepted. Supersedes [ADR-0002](./0002-open-core-runtime-discovery.md).
- **Deciders:** Project owner, architect
- **Related:** [ADR-0001](./0001-typescript-monorepo-npm-workspaces.md), [ADR-0006](./0006-auth-local-jwt-modular-sso.md), [ADR-0007](./0007-apache-2-0-for-public-core.md), [ADR-0014](./0014-enterprise-licensing.md), [ADR-0015](./0015-hybrid-authentication.md), [ADR-0016](./0016-settings-store-and-audit-forwarding.md), [ADR-0018](./0018-custom-roles.md), [ADR-0023](./0023-several-authentication-sources.md)

## Context

ADR-0002 split NexusPuppet into a public core and a private enterprise layer. The core had to build and pass its tests without the layer. The layer was cloned into `packages/enterprise` at build time and discovered at boot by a dynamic `import()`. It registered implementations of `@nexuspuppet/contracts` interfaces over core defaults, and it advertised named capabilities (`directory.ldap`, `sso.oidc`, `rbac.custom`, `audit.export`) that core checked before allowing a feature. That design did its job while there was something private to protect.

In 1.9.0 that stopped being true. #260 removed licensing, and ADR-0014 was marked Rejected. #261 moved `packages/enterprise` into this repository under Apache-2.0. ADR-0002 was amended rather than superseded. The amendment kept the seam as "an internal boundary that keeps the auth and audit integrations independently testable" and deliberately left open **whether the seam still earns its keep with nothing private behind it**.

It does not. With nothing private left, this is what the seam cost:

- **The default install was the smaller product.** The image took an `EDITION` build argument that defaulted to `core`, and `scripts/deploy.sh` never set it. So anyone following DEPLOYMENT.md got an image without LDAP, OIDC, role editing or audit forwarding. Nothing told them. This was fixed in the packaging change that precedes this ADR. The build flag existed only because of the seam.
- **Two runtime products to keep correct.** The unit suite's wiring test branched on which edition was loaded. The e2e suite skipped gated tests in one edition or the other. `scripts/dev/e2e-edition.sh` existed because each direction had shipped bugs the other could not see.
- **A version contract with itself.** `CONTRACTS_VERSION`, a hard-coded target version in the layer, and a boot-time major-version check guarded against drift between two packages that were now built from the same commit in the same repository.
- **A product that talked about licences it no longer had.** Settings screens showed a padlock reading "Enterprise". Role editing and audit forwarding answered `501` with a `capability` field. `GET /capabilities` reported an `edition`.
- **Indirection where there was no longer a boundary.** Core could not parse `LDAP_*` itself, so the settings screen asked the running provider what its environment baseline was. The layer's Nest wrappers existed only to cross a line that ESLint drew.

None of these costs bought anything the interfaces alone do not already provide. What keeps the LDAP provider or the forwarding sink independently testable is that each depends on interfaces and receives its collaborators. A package boundary and runtime discovery add nothing to that.

## Decision

**One product. Every feature is always present. What varies between deployments is configuration, never an edition.**

### 1. The code moves into `apps/api`, and the seam is deleted

`packages/enterprise` becomes three directories of the API:

| From | To |
|---|---|
| `packages/enterprise/src/ldap/` | `apps/api/src/directory/ldap/` |
| `packages/enterprise/src/oidc/` | `apps/api/src/directory/oidc/` |
| `packages/enterprise/src/audit/` | `apps/api/src/audit-forwarding/` |

They are wired directly in `app.module.ts` with factory providers. The following are deleted, with no replacement: the package itself; `enterprise.loader.ts` and `capability.registry.ts`; the `coreDefaults` map; `contracts/src/enterprise.ts` (`CONTRACTS_VERSION`, the descriptor and entrypoint types, `EnterpriseLoadError`, `DeploymentCapabilities`); the `CAPABILITIES` constant; the ESLint enterprise-boundary block; and `NoopAuditTransport`. The integration tests that exercised "forwarding off" now use a local test double instead of that no-op transport.

`ldapts` becomes an ordinary dependency of `@nexuspuppet/api` and is imported statically. Before, it was an optional peer loaded with a dynamic `import()`, so a missing package showed up as a failed login rather than a failed build.

### 2. Interfaces and tokens stay where they have consumers

`@nexuspuppet/contracts` keeps `IAuthProvider`, `IAuditSink`, `IAuditTransport`, `IUserDirectory`, `IAuthorizationPolicy` and the rest, along with their DI tokens. They exist because a consumer depends on the interface and a test hands it a fake, and that reason survives this ADR. The wiring test still asserts that every token in `CAPABILITY_TOKENS` is bound exactly once and that nothing reaches around a token to its implementation.

`CORE_AUDIT_SINK`, `AUDIT_DELIVERY_OUTBOX`, `AUDIT_FORWARDING_SETTINGS` and `AUTH_PROVIDER_SETTINGS` existed to let the layer reach core classes it could not import. They stay for now. Each still decouples a consumer from a class, and pruning them is churn this change does not need.

Two designs that happened to sit across the seam are **not** artifacts of it, and they stay:

- **The forwarding sink composes over the Postgres sink** (ADR-0016). It delegates the transactional write and then enqueues. An estate that gains a SIEM does not lose its local trail.
- **Authentication providers are additive and dispatched by `authSource`** (ADR-0015, ADR-0023). The local provider is always first in `AUTH_PROVIDERS`, and the wiring test pins it.

### 3. `GET /capabilities` is removed

It was public and unauthenticated. It reported an `edition`, an `enterpriseVersion` and a list of licensed capabilities. After this ADR it could only return a constant, and a constant endpoint invites clients to keep gating on it. Each settings surface already reports its own configuration state. That is the question a client actually has.

### 4. Every capability gate is removed

- **Role editing** (`rbac.custom`, ADR-0018 §6) is always available to holders of `settings:manage`. The built-in three are still fixed.
- **Audit forwarding** (`audit.export`, ADR-0016 §5) is always registered. It still sends nothing until a transport is configured.
- Both `501` guards are deleted.
- `SystemStatus.auditForwarding.available` is removed from the contract rather than pinned to `true`. The web status card and the notification condition catalogue stop reading it.

The convention *"enterprise-only routes exist in core and return `501` with a `capability` field"* is retired. No route in this product answers `501` because a deployment lacks a feature.

### 5. Directory registration stays configuration-driven, and validation stays at boot

> **Amended 2026-10-01 ([ADR-0029](./0029-directory-from-the-console.md)).** The
> open follow-up below is done. Both directory providers are now registered on
> every deployment; configuration — a row saved in the console, else the
> environment — only decides whether one is dormant. A directory is enabled from
> the console with no restart, and the console no longer shows a header naming
> the variable that enables it. Validate-at-boot is unchanged: a present but
> malformed `LDAP_*`, `OIDC_*` or `AUDIT_EXPORT_*` still stops the API.

An LDAP provider is registered when `LDAP_URL` is set, and an OIDC provider when `OIDC_ISSUER` is. This is exactly what the layer's `register()` did. Registration happens at boot.

**Validate-at-boot is kept.** `config/integrations.ts` reads the LDAP, OIDC and audit-export environment once, before any provider is built. A value that is present but malformed throws `IntegrationConfigError`, which names the integration and the reason, and the API refuses to start. The loader used to enforce the same rule, for the same reason: a deployment that believes it has a directory must never quietly run without one.

The console's directory panels key on configuration instead of on capabilities. The settings view's `liveReload` is true when a provider for that source is registered. Without a provider, the card is a header that names the variable which enables it. There is no padlock and no "Enterprise".

**Open follow-up, deliberately not done here:** register both providers always, and let an operator enable a directory from the console without a restart. This changes what "validated at boot" means and removes the restart-required path from the settings flow, so it deserves its own decision.

### 6. Tests move with the code

The layer's unit specs sit next to the code they test under `apps/api/src/`. Its coverage floor becomes a per-directory `coverageThreshold` in the API's jest config: 90% lines and 85% branches for `directory/` and `audit-forwarding/`.

That floor is checked the way it always was: by `jest --coverage` (`npm run test:cov`), not by the `npm test` that CI runs. When this ADR was written, the moved code measured below it, as it had as a package, where the same floor also failed under `--coverage`: `directory/` at 86.9% lines / 78.3% branches, and `audit-forwarding/` at 88.4% / 61.4%. The floor records the intent. Meeting it is follow-up work, and is no reason to lower the number.

The keys are `./src/directory/` and `./src/audit-forwarding/`. Jest resolves a path threshold against the working directory, not against `rootDir`, so a key without `src/` matches nothing and is skipped without a word.

The LDAP integration suite moves to `apps/api/test/ldap/` and the Keycloak fixture to `apps/api/test/oidc/`. The LDAP suite is still run explicitly: `npm run ldap:up` and then `npm run test:ldap` in `@nexuspuppet/api`.

### 7. What remains of ADR-0002's guarantees

- **A fresh clone builds, typechecks, lints and passes its unit tests with no secrets and nothing from outside this repository.** CI's load-bearing job still proves it. It is renamed "Build, typecheck, lint, unit tests", and keeps the committed-certificate and private-key checks.
- **`@nexuspuppet/contracts` stays dependency-free apart from `zod`, and never imports its consumers.** ADR-0001's lint rule is unchanged.
- **`apps/web` never touches data directly.** That rule never came from ADR-0002 and is unaffected.

## Consequences

- **One image and one test run.** No build flag, no edition to probe, no test that passes in one product and skips in the other. Every e2e test for role editing and audit forwarding now runs in CI.
- **A public API change.** `GET /capabilities` answers `404`. Role and forwarding writes that answered `501` in a former core deployment now succeed. Both are recorded under *Upgrading* in the CHANGELOG.
- **A former core deployment gains features but not behaviour.** Nothing activates without configuration. The exception is an `.env` that already set `LDAP_*`, `OIDC_*` or `AUDIT_EXPORT_*` while the old core image ignored them: those values now take effect, and a malformed one stops boot.
- **Branch protection must follow the rename.** The required status check was named after the old job ("Core builds without the enterprise layer"). It has to be updated to the new name when this merges.
- **The name "enterprise" survives only in history.** Mentions of Puppet Enterprise are about a different product and are unaffected.
- **A future paid tier would need a new decision.** It could not reuse this code path, because the path no longer exists. ADR-0014's record of what licensing got right and wrong remains the place to start.

## Alternatives considered

- **Keep the seam as an internal boundary** (ADR-0002 as amended). Rejected. Every cost in *Context* persists, and the testability it was kept for comes from the interfaces, which stay.
- **Keep `packages/enterprise` as a workspace package, imported statically, with no loader.** Rejected. It would be a package with one consumer and a build step wedged between contracts and the API, and its name and location would keep inviting the core-versus-enterprise framing this ADR ends. Inside `apps/api`, provider wiring is ordinary Nest code next to everything else.
- **Keep `GET /capabilities` and return every capability.** Rejected. A public endpoint whose only answer is "all of it" is a contract nobody should build on, and clients that already do would keep gating on nothing.
- **Register both directory providers always, now.** Deferred to the follow-up in §5. It is the better end state. It also changes boot validation and the restart-required settings flow, which are separate decisions from removing an edition.
