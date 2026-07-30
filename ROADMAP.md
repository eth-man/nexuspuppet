# Roadmap

Where NexusPuppet is, where it is going, and where you can help.

This is a living document rather than a commitment. Dates are deliberately absent — items move when someone picks them up.

---

## Shipped

The core product is complete, verified against real Puppet and OpenVox software, and installed on a production host from the deployment guide by someone who had not seen the code.

| | |
|---|---|
| ✅ **Asynchronous ENC** | Classification materialized to YAML; `puppetserver` reads it with `cat`. A NexusPuppet outage cannot affect a Puppet run. |
| ✅ **Read-only PuppetDB client** | mTLS, parameterised AST queries, no write surface. Verified against real PuppetDB 7.10 and openvoxdb 8.15. |
| ✅ **Node inventory and run reports** | Filter, sort, page; per-node facts, run history, and resource-level report detail. |
| ✅ **Classification engine** | Groups, fact rules, class assignment, parameters, pins, rank-ordered merge with conflict reporting. |
| ✅ **Transactional outbox** | Every classification change writes its materialization job and audit row in one transaction. |
| ✅ **Fact projection** | Incremental polling, keyset-paginated full reconcile, prune safety rails, deactivation handling. |
| ✅ **Local authentication** | JWT sessions, scrypt hashing, account lockout, full audit trail. |
| ✅ **OpenVox support** | Works unchanged; verified operator-by-operator against a live openvoxdb. |
| ✅ **Console TLS** | An optional bundled proxy terminating HTTPS from your own CA, and a Settings card reporting the certificate's subject, the names it covers and days remaining. Reads a file, so it works whatever terminates TLS ([ADR-0013](docs/architecture/adr/0013-console-tls-private-ca.md)). |
| ✅ **Enterprise LDAP / Active Directory** | Nested groups, dialect switching, secure referral handling, admin-managed group→role mapping. |
| ✅ **Enterprise OIDC SSO** | Authorization-code with PKCE, ID-token validation on `node:crypto` with an algorithm allow-list, discovery and JWKS caching with rotation, claim→role mapping. Verified against a live Keycloak. |
| ✅ **Enterprise audit export** | A forwarding sink that composes over core's rather than replacing it, a transactional delivery outbox with leases and backoff, and a webhook transport. The local audit trail is never traded for the external copy. |

---

## Next up

### Enterprise capabilities

Four of the five declared capability tokens have no implementation yet. Routes for them already exist and return `501` with the capability name, so wiring one up is additive rather than invasive.

| Capability | Token | Notes |
|---|---|---|
| **SAML SSO** | `AUTH_PROVIDER` | The redirect plumbing OIDC needed now exists, so this is a provider implementation only. Read the caution below before starting. |
| **Scoped RBAC** | `AUTHORIZATION_POLICY` | **Deferred** — designed and declined. See [ADR-0011](docs/architecture/adr/0011-scoped-rbac.md). |

#### A caution about SAML

SAML's security rests on XML digital signatures, a materially nastier surface
than the JWT verification OIDC needed. Signature wrapping, canonicalisation
differences and entity expansion have each produced authentication bypasses in
widely used implementations, and none of them fail loudly.

OIDC was built directly on `node:crypto` to keep a dependency out of the
component that decides who is an administrator. **That reasoning does not
transfer.** Hand-rolling XML-DSig is harder than hand-rolling JWS by a wide
margin, and the honest options are a well-audited library or not shipping SAML.

Entra ID, Okta, Keycloak and Google all speak OIDC, so this is worth doing when
a specific deployment needs it and not before.

### Core

- **Estate-scale validation.** Everything is verified for correctness but not for scale. A 1,000+ node estate with large custom facts will stress pagination, projection and the materializer in ways a local harness does not. **If you run one, we would like to hear what breaks.**
- **Fixture diversity.** Captured fixtures come from one Debian node on puppet-agent 7.20. Captures from RedHat, Windows and Puppet 8 estates would exercise mappers that nothing currently touches.
- **Estate-wide conflict report.** Per-node classification conflicts are surfaced today; an estate-wide "these groups disagree" view is designed ([ADR-0009](docs/architecture/adr/0009-classification-merge-semantics.md)) but not built.

---

## Known constraints

Real limits of what is built, recorded so nobody discovers them in production.

| Constraint | Impact | Where |
|---|---|---|
| **OIDC login state is in-process** | A load-balanced deployment can route a callback to a replica that did not begin the login, and that login fails. Needs sticky sessions until there is an external store. | [DEPLOYMENT.md §8](DEPLOYMENT.md#8-high-availability-and-horizontal-scaling) |
| **Login rate limiting is per replica** | N replicas permit N× the configured attempts. Account lockout is durable and still applies, so this widens the online-guessing window rather than removing the protection. | as above |
| **JWKS refetch has a cooldown** | A rotated signing key is picked up within the cooldown rather than instantly. Deliberate — it bounds a flood of tokens bearing kids that will never exist. | enterprise `OidcDirectory` |
| **Not exercised at estate scale** | Correctness is verified against real Puppet and OpenVox estates; throughput is not. | [fixtures/README.md](fixtures/README.md) |
| **`pg` deprecation on multi-relation `include` inside a transaction** | Prisma's interpreter loads relations concurrently on the single connection an interactive transaction pins, which `pg` 9 will stop tolerating. Noise today, a failure on upgrade. Not fixable from application code — see below. | `PrismaService`, `apps/api/src/prisma/prisma.service.ts` |

## Deferred, with reasons

These were considered and consciously postponed. Each ADR records the alternatives.

| Item | Why it is waiting |
|---|---|
| **GitOps classification mirror** ([ADR-0012](docs/architecture/adr/0012-gitops-classification-mirror.md)) | Designed and held. Not rejected — just not next. The first live install by someone who had not seen the code hit four blocking defects in its first fifteen minutes, none of them found by CI. Stabilising installation, upgrade and estate-scale behaviour comes before adding a git transport with its own credentials and its own secrets question. |
| **Scoped RBAC** ([ADR-0011](docs/architecture/adr/0011-scoped-rbac.md)) | Designed in full and declined. Scoping by node group turns out not to bound anything — group membership is fact-based, so a scoped operator can rewrite a rule to match the whole estate. A sound design exists (check the *effect* of a write, not the request) but costs a security-critical check on the classification write path, and the future-node loophole cannot be closed at write time. Deferred until a deployment actually needs it. |
| **Enterprise as a published private npm package** ([ADR-0002](docs/architecture/adr/0002-open-core-runtime-discovery.md)) | The runtime-discovery design already supports it unchanged. Blocked only on a private registry the project does not have. |
| **PE Orchestrator / RBAC API scoping** ([ADR-0004](docs/architecture/adr/0004-puppetdb-read-only-mtls.md)) | Not available on open-source Puppet, which is the core target. Available to the enterprise layer as a future capability. |
| **SQLite single-binary demo mode** ([ADR-0005](docs/architecture/adr/0005-postgres-prisma-local-state.md)) | Rejected for production — no advisory locks, weak concurrent writes, blocks the multi-replica path. Still plausible for a demo build. |

---

## Explicitly not planned

Saying no is part of a roadmap.

- **A synchronous HTTP ENC endpoint.** Not "for convenience", not "for immediate consistency", not "just for testing". It would put this console on the critical path of every Puppet run and destroy the one property the project exists for. Changing this requires a superseding ADR with the failure analysis redone, not a pull-request comment. ([ADR-0003](docs/architecture/adr/0003-enc-generate-dont-serve.md))
- **Writing to PuppetDB.** Deactivating nodes, submitting facts, or issuing commands is not NexusPuppet's business. ([ADR-0004](docs/architecture/adr/0004-puppetdb-read-only-mtls.md))
- **Deep-merging class parameters.** Hiera exists for layered data and does it properly. Deep merge makes a parameter's effective value a function of every group in the chain, so an operator reading one group cannot know what a node receives. ([ADR-0009](docs/architecture/adr/0009-classification-merge-semantics.md))
- **Raw PQL from the UI.** The mTLS certificate is estate-wide and read-everything. A query box would make the API a confused deputy for anyone who can reach it.

---

## Good first issues

Genuinely useful, self-contained, and a good way to learn the codebase. None require Puppet infrastructure unless noted.

### 🟢 Small

- **Capture fixtures from a non-Debian estate.** Run `scripts/capture-fixtures.mjs` against a RedHat, Ubuntu or Windows node and contribute the result as an additional fixture set. Directly widens what the mapper tests cover. See [`fixtures/README.md`](fixtures/README.md).
- **Add rule operators to the classification UI.** The engine supports `IN`, `NOT_IN`, `EXISTS` and `NOT_EXISTS`; check the editor exposes all of them clearly, with useful placeholder text per operator.
- **Improve empty states.** Several screens render a bare table when the estate has no matching data. A short explanation of *why* it is empty and what to do next would help a first-run user considerably.
- **Document a fact-path cookbook.** A short guide of useful `factPath` values for common classification patterns (`os.family`, `networking.fqdn`, `processors.count`) with the gotchas — legacy flat facts, Puppet 8 differences. Would slot into [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md).

### 🟡 Medium

- **Estate-wide conflict report.** The data exists — `ClassMerger` returns conflicts and they are persisted per materialization. This is a query, a route and a page.
- **Bulk group operations.** Enable/disable or re-rank several groups at once, going through the same transactional service so the outbox and audit rows stay correct.
- **A `docker-compose.demo.yml`.** One command bringing up Postgres, API, console *and* the PuppetDB stand-in, so the quickstart becomes a single `docker compose up`. Today the stand-in runs outside compose.
- **Prometheus metrics.** Projection lag, outbox depth, materialization failures, PuppetDB latency. All already measured internally; they just need exposing.

### 🔴 Larger

- **External state store for OIDC flows**, so a load-balanced deployment does not need sticky sessions. The PKCE verifier and nonce for a login in flight are held in memory today; moving them to PostgreSQL with a short TTL would let any replica complete any login. Self-contained, and it removes a constraint recorded above.
- **More audit transports** — syslog (RFC 5424) or Splunk HEC alongside the existing webhook, behind `AUDIT_TRANSPORT`. The queue, retries and leases are core's; a transport is one method.
- **Estate-scale load testing** with a synthetic 5,000-node PuppetDB, to find where projection and materialization actually bend.

---

## Before you start

Read [CONTRIBUTING.md](CONTRIBUTING.md), especially the architectural rules table — those are enforced by `npm run lint`, and a violation is a design problem rather than a style one.

For anything larger than a good-first-issue, **open an issue describing the approach before writing much code.** Several apparently reasonable designs are ruled out by existing ADRs, and it is much cheaper to find that out in an issue than in review.
