# Roadmap

Where NexusPuppet is, where it is going, and where you can help.

This is a living document rather than a commitment. Dates are deliberately absent — items move when someone picks them up.

---

## Shipped

The core product is complete and verified against a real estate, not just a test suite.

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
| ✅ **Enterprise LDAP / Active Directory** | Nested groups, dialect switching, secure referral handling, admin-managed group→role mapping. |
| ✅ **Enterprise audit export** | A forwarding sink that composes over core's rather than replacing it, a transactional delivery outbox with leases and backoff, and a webhook transport. The local audit trail is never traded for the external copy. |

---

## Next up

### Enterprise capabilities

Four of the five declared capability tokens have no implementation yet. Routes for them already exist and return `501` with the capability name, so wiring one up is additive rather than invasive.

| Capability | Token | Notes |
|---|---|---|
| **OIDC SSO** | `AUTH_PROVIDER` | **In progress.** See the note below — core needs its redirect routes before any redirect-mode provider can work. |
| **SAML SSO** | `AUTH_PROVIDER` | After OIDC, which builds the redirect plumbing SAML also needs. |
| **Scoped RBAC** | `AUTHORIZATION_POLICY` | Today's policy is role-based and estate-wide. Scoped RBAC means permissions bounded by node group or environment. Large: it touches every route and guard, and wants an ADR before code. |

#### Before OIDC: core's redirect routes

`IAuthProvider` already declares `beginRedirect` and `completeRedirect`, the login
screen already renders a "Continue with …" button, and that button points at
`/auth/redirect` — **a route that does not exist**. A redirect-mode provider is
impossible today, and configuring one would produce a login page whose only
control 404s.

So the first increment is core's: the two routes, the state correlation that
binds a callback to the browser that began it, and the open-redirect guard on
the return path. That plumbing is shared by OIDC and SAML alike.

### Core

- **Estate-scale validation.** Everything is verified for correctness but not for scale. A 1,000+ node estate with large custom facts will stress pagination, projection and the materializer in ways a local harness does not. **If you run one, we would like to hear what breaks.**
- **Fixture diversity.** Captured fixtures come from one Debian node on puppet-agent 7.20. Captures from RedHat, Windows and Puppet 8 estates would exercise mappers that nothing currently touches.
- **Estate-wide conflict report.** Per-node classification conflicts are surfaced today; an estate-wide "these groups disagree" view is designed ([ADR-0009](docs/architecture/adr/0009-classification-merge-semantics.md)) but not built.

---

## Deferred, with reasons

These were considered and consciously postponed. Each ADR records the alternatives.

| Item | Why it is waiting |
|---|---|
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

- **More audit transports** — syslog (RFC 5424) or Splunk HEC alongside the existing webhook, behind `AUDIT_TRANSPORT`. The queue, retries and leases are core's; a transport is one method.
- **Estate-scale load testing** with a synthetic 5,000-node PuppetDB, to find where projection and materialization actually bend.

---

## Before you start

Read [CONTRIBUTING.md](CONTRIBUTING.md), especially the architectural rules table — those are enforced by `npm run lint`, and a violation is a design problem rather than a style one.

For anything larger than a good-first-issue, **open an issue describing the approach before writing much code.** Several apparently reasonable designs are ruled out by existing ADRs, and it is much cheaper to find that out in an issue than in review.
