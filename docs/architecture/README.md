# NexusPuppet — Master Architecture

**Status:** Baseline. Supersedes nothing.
**Source of truth for scope:** [`/INTAKE.md`](../../INTAKE.md).
**Binding decisions:** [`adr/`](./adr/). Where this document and an ADR disagree, the ADR wins.

---

## 1. What NexusPuppet is

A web console for Puppet estates running open-source `puppetserver` + PuppetDB, providing:

1. **Visibility** — node inventory, facts, run reports, failure triage. Read-only projection of PuppetDB.
2. **Classification** — a native ENC (External Node Classifier): node groups, fact-based matching rules, class and parameter assignment, stored in PostgreSQL and **materialized to YAML files on disk** for `puppetserver` to consume.

It is delivered as **open core**: a public Apache-2.0 repository containing the entire product above, plus an optional, separately-licensed enterprise layer loaded at runtime.

## 2. What NexusPuppet is not

- Not a Puppet code editor, linter, or CI system.
- Not a writer to PuppetDB. PuppetDB access is read-only, always. ([ADR-0004](./adr/0004-puppetdb-read-only-mtls.md))
- Not on the synchronous critical path of a Puppet agent run. ([ADR-0003](./adr/0003-enc-generate-dont-serve.md))
- Not multi-tenant in v1.

## 3. The two load-bearing decisions

Everything else in this architecture follows from two choices.

### 3.1 The ENC generates files; it does not serve requests

A conventional ENC is an HTTP endpoint `puppetserver` calls on every run of every node. That would make a monitoring console a hard dependency of fleet-wide configuration management: if the API or database is down, agent runs fail estate-wide.

Instead, NexusPuppet **materializes** each node's classification to `${ENC_OUTPUT_DIR}/nodes/<certname>.yaml`. `puppetserver` runs a dependency-free shell script that `cat`s that file. NexusPuppet can be stopped, redeployed, or broken entirely and Puppet runs continue against the last known good state on disk.

The cost is that classification changes are eventually consistent — typically sub-second, bounded by the materializer's queue depth. This is the correct trade for infrastructure tooling.

See [ADR-0003](./adr/0003-enc-generate-dont-serve.md).

### 3.2 The enterprise layer is discovered at runtime, never imported at compile time

The public repository must build, typecheck, lint, and pass its full test suite with no knowledge that an enterprise layer exists. Enterprise code lives in a separate private repository, cloned into `packages/enterprise/` by an environment-driven script at build time. It is `.gitignore`d in the public repo, so no private URL is ever published.

Core depends only on interfaces declared in `@nexuspuppet/contracts`. At boot the API attempts a dynamic `import()` of the enterprise entrypoint; on failure it silently continues with core implementations. An ESLint boundary rule makes a static import of enterprise code a lint error everywhere except the single loader file.

See [ADR-0002](./adr/0002-open-core-runtime-discovery.md).

## 4. Component responsibilities

| Component | Responsibility | Explicitly not responsible for |
|---|---|---|
| `apps/web` | Next.js App Router UI. Server components fetch through the API. Never talks to PuppetDB or Postgres directly. | Business rules, authorization decisions |
| `apps/api` | NestJS. Owns all business logic, authorization, PuppetDB access, Postgres access, and ENC materialization. | Rendering |
| `packages/contracts` | Interfaces, injection tokens, Zod schemas, shared DTO types. Zero runtime dependencies beyond `zod`. | Any implementation |
| `packages/enterprise` | Optional, private, not in this repo. Implements contracts. | Reaching into core internals |
| PostgreSQL | Users, sessions, node groups, rules, class assignments, the materialization outbox, audit log, cached node projection. | Being a source of truth for facts or reports |
| PuppetDB | Source of truth for facts, catalogs, reports, node status. | Storing anything NexusPuppet owns |
| ENC volume | Shared filesystem. Written by `api`, read by `puppetserver`. | Anything else |

## 5. Data ownership

```
PuppetDB  ──(read-only, mTLS, PQL)──▶  api  ──(projection)──▶  Postgres.ManagedNode
                                        │
                                        ├─ owns: User, NodeGroup, rules, classes, params, audit
                                        │
                                        └─(materialize)──▶  ENC volume  ──(cat)──▶  puppetserver
```

`ManagedNode` is a **cache**, never authoritative. It exists so materialization can evaluate fact-based rules without a live PuppetDB call — the materializer must keep working when PuppetDB is unreachable. It is refreshed on a schedule and is safe to truncate.

## 6. Request paths

**Read (inventory/reports)** — browser → `web` (RSC) → `api` → PuppetDB. Cached per [ADR-0004](./adr/0004-puppetdb-read-only-mtls.md). PuppetDB unavailability degrades these screens to an explicit error state; it does not affect classification.

**Write (classification)** — browser → `api` → single Postgres transaction writing the domain change *and* an `EncMaterializationJob` outbox row → transaction commits → materializer worker drains the outbox → atomic file write → `EncMaterialization` row updated. The outbox guarantees a committed classification change is never lost, even if the process dies immediately after commit.

**Puppet run** — agent → `puppetserver` → `exec` node terminus → `nexuspuppet-enc.sh <certname>` → `cat nodes/<certname>.yaml` (falling back to `default.yaml`). No network. No NexusPuppet process involved.

## 7. Failure posture

| Failure | Consequence |
|---|---|
| `api` down | UI unavailable. **Puppet runs unaffected.** |
| Postgres down | UI degraded, classification edits rejected. **Puppet runs unaffected.** |
| PuppetDB down | Inventory/report screens show an explicit error. Classification and materialization continue from the `ManagedNode` cache. **Puppet runs unaffected.** |
| ENC volume unmounted on `api` | Materialization fails loudly, jobs retry. `puppetserver` still reads its own mount. |
| ENC volume lost entirely | Nodes fall back to `default.yaml`. Full reconcile rebuilds it from Postgres. |
| Enterprise package absent | Core runs. Enterprise-only endpoints return `501 Not Implemented`. |

## 8. Security posture

- PuppetDB is reached over **mTLS** with a client certificate; the cert grants read access to the whole estate, so **the API is a confused deputy by construction**. All per-user authorization is enforced in `api` before any PuppetDB call. Never proxy a user-supplied PQL string unmodified — see [ADR-0004](./adr/0004-puppetdb-read-only-mtls.md).
- The ENC output directory is mounted **read-only** in `puppetserver`. Only `api` may write it.
- Certificates and secrets arrive as mounted files or env vars, never in the image, never in the repo.
- Every classification change writes an `AuditLog` row in the same transaction as the change itself.

## 9. Diagrams

- [C4 L1 — System Context](./c4-l1-context.md)
- [C4 L2 — Containers](./c4-l2-container.md)
- [C4 L3 — API Components](./c4-l3-component-api.md)

## 10. Decision index

| ADR | Title |
|---|---|
| [0000](./adr/0000-record-architecture-decisions.md) | Record architecture decisions |
| [0001](./adr/0001-typescript-monorepo-npm-workspaces.md) | TypeScript monorepo on npm workspaces |
| [0002](./adr/0002-open-core-runtime-discovery.md) | Open-core boundary via runtime discovery |
| [0003](./adr/0003-enc-generate-dont-serve.md) | ENC generates files, does not serve requests |
| [0004](./adr/0004-puppetdb-read-only-mtls.md) | PuppetDB is read-only over mTLS |
| [0005](./adr/0005-postgres-prisma-local-state.md) | PostgreSQL + Prisma for local state only |
| [0006](./adr/0006-auth-local-jwt-modular-sso.md) | Local JWT in core, modular SSO in enterprise |
| [0007](./adr/0007-apache-2-0-for-public-core.md) | Apache-2.0 for the public core |
| [0008](./adr/0008-nextjs-app-router-latest-stable.md) | Next.js App Router, latest stable |
| [0009](./adr/0009-classification-merge-semantics.md) | Classification merge and conflict resolution |
| [0010](./adr/0010-typescript-version-pinned-below-latest.md) | TypeScript pinned to 5.9.x, below published `latest` |
| [0011](./adr/0011-scoped-rbac.md) | Scoped RBAC: bounding writes by environment — **Deferred** |
| [0012](./adr/0012-gitops-classification-mirror.md) | GitOps mode: classification mirrored to Git — **Deferred** |

## 11. Open questions

Tracked in [`/INTAKE.md` §K](../../INTAKE.md). Nothing in this document is blocked on them; §12 below is.

## 12. Not yet decided

- Materializer execution model at >10k nodes (in-process scheduler is adequate at the stated ~1k; a dedicated worker container is the escape hatch).
- Report retention/archival strategy — depends on PuppetDB retention answers still outstanding in §B.
- Kubernetes topology. Docker Compose is the v1 target; the container boundaries here are chosen to make the port mechanical.
