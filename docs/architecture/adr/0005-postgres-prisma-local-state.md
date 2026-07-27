# ADR-0005 — PostgreSQL + Prisma, for local state only

- **Status:** Accepted
- **Deciders:** Project owner, architect
- **Related:** [ADR-0003](./0003-enc-generate-dont-serve.md), [ADR-0004](./0004-puppetdb-read-only-mtls.md)

## Context

NexusPuppet owns state PuppetDB has no concept of: users, node groups, matching rules, class assignments, the materialization outbox, and the audit trail. It needs a transactional store, because [ADR-0003](./0003-enc-generate-dont-serve.md)'s outbox pattern depends on writing a domain change and its materialization job atomically.

## Decision

**PostgreSQL 16, accessed exclusively through Prisma ORM, holding local application state only.**

### Scope boundary

| In Postgres | Not in Postgres |
|---|---|
| Users, roles, refresh tokens | Facts (beyond the projected subset) |
| Node groups, rules, class/param assignments | Catalogs |
| `EncMaterializationJob` (outbox), `EncMaterialization` | Reports |
| `AuditLog` | Anything PuppetDB is authoritative for |
| `AppSetting`, `SavedQuery` | |
| `ManagedNode` — an explicitly disposable cache | |

`ManagedNode` is the one deliberate exception, and it is a cache: truncating it must never lose data that cannot be rebuilt from PuppetDB.

### Why Postgres

- Transactional outbox requires real transactions. This is non-negotiable given ADR-0003.
- **Advisory locks** give single-materializer election across `api` replicas with no additional infrastructure — no Redis, no leader-election sidecar.
- `jsonb` handles class parameters and the projected fact subset, which are genuinely schemaless, without abandoning relational integrity for the rest.
- Operators running Puppet already run Postgres — PuppetDB itself is backed by it.

### Why Prisma

- Generated types are the schema, which suits a `strict` TypeScript monorepo: a schema change that breaks a query is a compile error, not a runtime surprise.
- Migrations are versioned, reviewable SQL files in the repo.
- `prisma migrate deploy` on container start is a well-trodden on-prem upgrade path.

Prisma 7 requires Node `^20.19 || ^22.12 || >=24.0`, consistent with the repo's Node 22+ floor.

### Prisma 7 connection wiring

Prisma 7 removed `url` from the `datasource` block. Two consequences, both load-bearing:

1. **Migration/introspection commands** read `apps/api/prisma.config.ts`, which resolves `DATABASE_URL` from the environment. `prisma generate` therefore requires `DATABASE_URL` to be set even though it never contacts a database — CI supplies a dummy value.
2. **The runtime client takes an explicit driver adapter** (`@prisma/adapter-pg` over `pg`), constructed in `PrismaService`. The connection string is passed in from validated config rather than read ambiently from the environment by the client.

The generated client is emitted to `apps/api/src/generated/prisma` and is gitignored. Importing `PrismaClient` from the `@prisma/client` package root does not resolve under npm workspace hoisting; code imports the generated path directly.

### Rules

1. **Only `apps/api` may import `@prisma/client`.** Enforced by ESLint. `apps/web` has no database credentials and no data-layer access ([C4 L2](../c4-l2-container.md)).
2. **Every classification write is a transaction** containing the domain change, the `AuditLog` row, and the outbox upsert. Partial writes here mean the disk and database disagree about what a thousand machines should be running.
3. **Migrations are forward-only.** No `migrate reset` outside local development; the npm script that runs it is named `db:reset:dev` and refuses to run when `NODE_ENV=production`.
4. **No raw SQL** except for advisory locks, which Prisma does not model. Those are isolated in `PrismaService`.

## Consequences

- One more container to operate. Justified by the transactional requirement.
- Prisma's generated client must be regenerated after every schema change; CI runs `prisma generate` before typecheck, and a stale client is a build failure rather than a runtime one.
- The `ManagedNode` cache can grow stale or wrong. Treated as disposable and rebuilt by the projector; never a source of truth.
- Prisma's query API constrains some complex analytical queries. Acceptable — analytics belong to PuppetDB, not here.

## Alternatives considered

- **SQLite.** Attractive for single-VM on-prem: no extra container. But it lacks advisory locks, has weak concurrent-write behaviour, and would block the multi-replica path. Rejected — though it remains plausible for a future single-binary demo mode.
- **Reuse PuppetDB's Postgres instance.** Couples the product's schema to an external system's database and risks operators losing NexusPuppet state during PuppetDB maintenance. Rejected firmly.
- **Drizzle instead of Prisma.** Lighter, closer to SQL, better raw-query ergonomics. Prisma chosen for migration tooling maturity and the stronger generated-type story, which matters more here than query flexibility.
- **Redis for the job queue instead of a Postgres outbox.** Adds infrastructure and, critically, breaks atomicity: the domain write and the queue write could no longer share a transaction. That would let a committed classification change silently never materialize. Rejected.
