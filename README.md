# NexusPuppet

A web console for Puppet estates running open-source `puppetserver` + PuppetDB:
read-only inventory and run-report visibility, plus a native ENC for node
classification.

Apache-2.0. Open core — the entire product below is in this repository.

> **Status: API complete, UI pending.** Architecture, contracts, schema, the
> classification engine and materializer, the PuppetDB client, and
> authentication are implemented and tested. The web console screens are not
> yet built.

## The defining property

**NexusPuppet cannot cause a Puppet outage.**

A conventional ENC is an HTTP endpoint `puppetserver` calls during every catalog
compilation, for every node, on every run — putting a monitoring console on the
critical path of fleet-wide configuration management.

NexusPuppet instead *materializes* classification to YAML files on a shared
volume. `puppetserver` reads them with a dependency-free `cat`. Stop the
containers, drop the database, deploy a broken image: agents keep converging
against the last known good state on disk.

The cost is that classification changes are eventually consistent, typically
sub-second. For infrastructure tooling that is the right trade. See
[ADR-0003](docs/architecture/adr/0003-enc-generate-dont-serve.md).

## Layout

```
apps/api             NestJS      business logic, authz, PuppetDB proxy, ENC materializer
apps/web             Next.js     rendering only — no database or PuppetDB credentials
packages/contracts   types       interfaces, DI tokens, Zod schemas
packages/enterprise  (absent)    optional private layer, loaded at runtime
docs/architecture    C4 + ADRs   binding decisions
```

## Quick start

```bash
npm install
cp .env.example .env          # then fill in JWT_SECRET and DATABASE_URL
npm run build
npm test
```

Requires Node ≥ 22.12. Postgres is needed only once you run migrations.

Start the development database, then migrate:

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres only, port 5432
npm run db:generate                              # after any schema.prisma change
npm run db:migrate                               # apply migrations locally
```

`docker-compose.yml` is the full stack and builds both app images — use it for
deployment, not for the edit-run loop.

## Connecting it to Puppet

1. Mount the ENC volume **read-only** on your puppetserver.
2. Install [`scripts/nexuspuppet-enc.sh`](scripts/nexuspuppet-enc.sh).
3. Configure the node terminus:

```ini
# /etc/puppetlabs/puppet/puppet.conf
[master]
node_terminus  = exec
external_nodes = /usr/local/bin/nexuspuppet-enc.sh
```

That script makes no network calls and depends on nothing but `/bin/sh`. That is
deliberate — do not "improve" it into an API client.

## Architecture

Start with [`docs/architecture/README.md`](docs/architecture/README.md), then the
diagrams: [context](docs/architecture/c4-l1-context.md) ·
[containers](docs/architecture/c4-l2-container.md) ·
[API components](docs/architecture/c4-l3-component-api.md).

Eleven ADRs record the binding decisions. The four worth reading before your
first PR:

| | |
|---|---|
| [0002](docs/architecture/adr/0002-open-core-runtime-discovery.md) | Open core via runtime discovery — never import the enterprise package |
| [0003](docs/architecture/adr/0003-enc-generate-dont-serve.md) | The ENC generates files; it does not serve requests |
| [0004](docs/architecture/adr/0004-puppetdb-read-only-mtls.md) | PuppetDB is read-only; never interpolate user input into PQL |
| [0009](docs/architecture/adr/0009-classification-merge-semantics.md) | Merge semantics — union classes, last-writer-wins, no deep merge |

Working conventions are in [`CLAUDE.md`](CLAUDE.md).

## Open core

The enterprise layer (SSO, scoped RBAC, licensing) lives in a separate private
repository. This repository contains no reference to it — no submodule, no URL.
It is fetched by an environment-driven script and discovered at runtime:

```bash
NEXUSPUPPET_ENTERPRISE_REPO=... npm run enterprise:fetch && npm install
```

Without that variable the script is a no-op and you get the core edition. CI
proves on every commit that the public repository builds, typechecks, lints, and
tests with no enterprise layer present.

## Contributing

Sign off commits with `git commit -s` (DCO). Run `npm run lint` before opening a
PR — it enforces the architectural boundaries above, so a lint failure there is a
design problem rather than a style one.
