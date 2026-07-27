# ADR-0004 — PuppetDB is read-only, reached over mTLS, and projected into Postgres

- **Status:** Accepted
- **Deciders:** Architect
- **Related:** [ADR-0003](./0003-enc-generate-dont-serve.md), [ADR-0005](./0005-postgres-prisma-local-state.md)

## Context

PuppetDB is the source of truth for facts, catalogs, reports, and node status. NexusPuppet needs all of it for the visibility half of the product, and needs facts for rule evaluation in the classification half.

PuppetDB's query API is authenticated by **mTLS client certificate**, and its authorization model is coarse: a certificate whitelisted in `auth.conf` can query everything about every node. There is no per-user, per-node, or per-fact scoping.

## Decision

**1. Read-only, always.** NexusPuppet issues `GET`/`POST` against `/pdb/query/v4` only. It never writes commands to `/pdb/cmd/v1`. Deactivating a node, replacing facts, or submitting reports are not NexusPuppet's business.

**2. mTLS with a dedicated client certificate.** Cert, key, and CA arrive as mounted file paths (`PUPPETDB_CERT_PATH`, `PUPPETDB_KEY_PATH`, `PUPPETDB_CA_PATH`), never inline in env vars, never in the image. `PuppetDbClient` builds one `undici.Agent` at boot and reuses it.

**3. The API is a confused deputy — treat it as one.** The client certificate is estate-wide. Any user who can reach an endpoint that proxies to PuppetDB can, absent controls, read everything. Therefore:

- Authorization is enforced in `api` **before** the PuppetDB call, never by PuppetDB.
- **User input is never interpolated into PQL.** Endpoints accept a typed, Zod-validated filter object; `PqlBuilder` translates it into PQL with values passed as PuppetDB query parameters. There is no endpoint that accepts a raw PQL string from a non-admin, and the admin one is audited.
- Every proxied query is logged with the acting user, the resolved PQL, and the row count.

**4. Facts are projected into Postgres for classification.** `NodeProjectionService` periodically pulls `certname`, `environment`, `report_timestamp`, node status, and a configured subset of facts into `ManagedNode`. Rule evaluation reads only this projection.

The reason is [ADR-0003](./0003-enc-generate-dont-serve.md): if materialization called PuppetDB live, a PuppetDB outage would block classification changes, reintroducing exactly the coupling that ADR exists to remove.

**5. Visibility queries are not projected.** Inventory tables and report views query PuppetDB live, with a short-TTL cache. Mirroring the whole report corpus into Postgres would duplicate a purpose-built store for no gain.

**6. PuppetDB unavailability is an explicit UI state.** Not an empty table, not a spinner that never resolves, not a generic 500. Inventory and report screens render a distinct "PuppetDB unreachable" state showing the last successful contact time. Classification screens remain fully functional, and say so.

## Consequences

- A PuppetDB outage degrades half the product and leaves the other half working — and the UI communicates which half.
- The fact subset in `ManagedNode` is a configured allow-list, not the full fact blob. Facts are unbounded in size and a full mirror at 1,000 nodes is a large, useless table. Adding a fact to a matching rule may require adding it to the projected set; the UI must surface that rather than silently never matching.
- Stale facts are possible in classification. Bounded by the projection interval, displayed as "facts as of <timestamp>", and force-refreshable.
- Certificate rotation requires an `api` restart in v1. Acceptable; a file watcher is a later refinement.
- The `PqlBuilder` indirection costs real work per new query shape. It is the control that makes the confused-deputy problem tractable, and is not optional.

## Alternatives considered

- **Proxy raw PQL from the frontend.** Fast to build, and hands every authenticated user full estate read access plus a query-of-death denial-of-service vector. Rejected.
- **Mirror all of PuppetDB into Postgres.** Removes the runtime dependency for reads, at the cost of reimplementing PuppetDB's storage and accepting permanent replication lag. Rejected as vastly disproportionate.
- **Query PuppetDB live during materialization.** Simpler, fresher facts, and directly contradicts ADR-0003. Rejected.
- **Use the PE Orchestrator/RBAC API for scoping.** Not available on open-source Puppet, which the intake fixes as the core target. Available to the enterprise layer as a future capability.
