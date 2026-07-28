# Contributing to NexusPuppet

Thanks for considering it. This document covers local setup, the test suites, and the architectural rules that `npm run lint` enforces.

New to the project? [ROADMAP.md](ROADMAP.md) has a [good first issues](ROADMAP.md#good-first-issues) section.

---

## The five-minute version

```bash
git clone https://github.com/eth-man/nexuspuppet.git && cd nexuspuppet
npm install
docker compose -f docker-compose.dev.yml up -d     # Postgres on :5432
cp .env.example .env                               # set JWT_SECRET and DATABASE_URL
npm run db:migrate
npm run dev:stack                                  # stand-in + API + console
```

Then, before you open a PR:

```bash
npm run typecheck && npm run lint && npm test
```

---

## What you need to know about the architecture first

NexusPuppet has a small number of rules that are not stylistic preferences. Breaking one is a design problem, and `npm run lint` will fail you for it. Each is recorded as an ADR with the reasoning and the alternatives that were rejected.

| Rule | Why | ADR |
|---|---|---|
| **`puppetserver` never calls NexusPuppet.** The ENC generates files; it does not serve requests. No HTTP ENC endpoint, not even "just for testing". | It is what makes a NexusPuppet outage harmless to Puppet. | [0003](docs/architecture/adr/0003-enc-generate-dont-serve.md) |
| **PuppetDB is read-only.** No writes to `/pdb/cmd/v1`, ever. All queries go through `PqlBuilder` as a parameterised AST — never an interpolated PQL string, and never raw PQL from a non-admin caller. | The mTLS certificate is estate-wide and read-everything, so the API is a confused deputy by construction. | [0004](docs/architecture/adr/0004-puppetdb-read-only-mtls.md) |
| **Never `import` the enterprise package.** Core must compile and pass with it absent. Capabilities are resolved through DI tokens at runtime. | Open core only works if core is genuinely complete. | [0002](docs/architecture/adr/0002-open-core-runtime-discovery.md) |
| **`apps/web` gets no database and no credentials.** It must never import `@prisma/client` or hold a PuppetDB certificate. | The browser tier is the least trusted process in the system. | [0008](docs/architecture/adr/0008-nextjs-app-router-latest-stable.md) |
| **Classification writes are transactional.** Any change to node classification writes its `EncMaterializationJob` outbox row and its `AuditLog` row in the *same* transaction. | An audit trail that can miss changes that did happen is worse than none, because it looks authoritative. | [0005](docs/architecture/adr/0005-postgres-prisma-local-state.md) |
| **Import `PrismaClient` from `apps/api/src/generated/prisma`**, not `@prisma/client`. | The generated client is the one the schema matches. | — |

Two more worth reading before your first substantive PR: [0009 — merge semantics](docs/architecture/adr/0009-classification-merge-semantics.md) (union classes, last-writer-wins, no deep merge) and [0006 — auth](docs/architecture/adr/0006-auth-local-jwt-modular-sso.md).

Day-to-day working conventions live in [CLAUDE.md](CLAUDE.md).

---

## Layout

```
apps/api             NestJS      business logic, authz, PuppetDB proxy, ENC materializer
apps/web             Next.js     rendering only — no database or PuppetDB credentials
packages/contracts   types       interfaces, DI tokens, Zod schemas shared by both
packages/enterprise  (absent)    optional private layer, loaded at runtime
docs/architecture    C4 + ADRs   binding decisions
fixtures/            data        PuppetDB responses captured from a real estate
scripts/dev/         harnesses   local stacks: stand-in, real Puppet, real OpenVox, LDAP
```

`packages/contracts` is the only thing both apps may depend on. If you find yourself wanting `apps/web` to import from `apps/api`, the type belongs in contracts.

---

## Database work

```bash
npm run db:generate     # after ANY change to schema.prisma
npm run db:migrate      # create + apply a migration locally
npm run db:deploy       # apply existing migrations (what CI and production do)
```

`db:generate` is not optional after a schema edit — the generated client is imported directly, so a stale one produces type errors that look unrelated to your change.

Migrations are reviewed like code. A migration that drops or rewrites a column needs a note in the PR describing what happens to existing rows.

---

## Tests

```bash
npm test                                          # unit — fast, no services
npm run test:int --workspace @nexuspuppet/api     # integration — needs Postgres
npm run test:e2e                                  # browser — needs a running stack
```

### Unit

The usual thing, plus one suite worth knowing about: `apps/api/src/enterprise/capability-wiring.spec.ts` inspects the DI graph and fails if a capability token has no core default, is registered twice, or is bypassed by a consumer injecting the concrete class directly. It iterates `CAPABILITY_TOKENS`, so a new token is covered automatically. If it fails, read the message — it names the exact provider and the seam it broke.

### Integration

**These truncate tables.** They run against a separate `nexuspuppet_test` database and never `DATABASE_URL`, so they cannot disturb a stack you are using. Once, first:

```bash
npm run db:test:setup --workspace @nexuspuppet/api
```

The transactional outbox and the advisory lock cannot be verified against a mock. A mock confirms whatever the code already believes; these assert on the database after the fact.

### End-to-end

E2E drives a real browser against a stack you have already started with `npm run dev:stack`. You will need the browser once:

```bash
npx playwright install chromium
```

The suite is deliberately thin on styling assertions and thick on behaviour that breaks silently: that a classification write answers `202` and never `200`, that the console reports materialization as *queued* rather than applied, that a rule change queues a **full** reconcile, and that regex metacharacters in a filter are matched literally instead of returning the whole estate.

Tests create node groups prefixed `e2e-` and sweep them before and after, so running against a stack you are also using by hand is safe.

**If you change anything in `fixtures/`, run the E2E suite.** The browser tests read those files through the PuppetDB stand-in, so a fixture change has a blast radius beyond the unit and integration suites. (Learned the hard way.)

In CI, [`scripts/ci/e2e-stack.sh`](scripts/ci/e2e-stack.sh) boots the stack from **built** artifacts — `next start`, not `next dev` — waits for the first projection to land, then runs the suite. On failure it dumps service logs and uploads traces and screenshots.

---

## Fixtures

`fixtures/*.sample.json` are **captured from a real Puppet estate**, not generated from documentation. That distinction is load-bearing: the previous synthetic fixtures invented facts that no real node reports, those names reached a shipped default, and classification rules written against them silently matched nothing.

Re-capture with a real estate running:

```bash
sudo ./scripts/dev/puppet-stack.sh      # if it is not already up
node scripts/capture-fixtures.mjs
```

Read [`fixtures/README.md`](fixtures/README.md) before changing them. It states precisely what is captured, what is synthesised, and what a single-node capture cannot prove. **Read a capture before committing it** — the script masks known hardware identifiers, but it cannot know what a custom fact in your estate contains.

---

## Local harnesses

Beyond the default stand-in, `scripts/dev/` has full estates for the things that are hard to reason about without the real thing:

| Command | What it gives you |
|---|---|
| `npm run dev:stack` | PuppetDB stand-in + API + console. No Puppet needed. |
| `sudo ./scripts/dev/puppet-stack.sh` | A real `puppetserver` + PuppetDB + agent, with certificates issued and the ENC wired |
| `sudo ./scripts/dev/openvox-stack.sh` | The same estate on OpenVox, alongside the Puppet one |
| `./scripts/dev/openvox-compat.sh` | Runs the standard connection test plus a fork-specific probe against openvoxdb |
| `npm run test:puppetdb` | Six-stage diagnostic against a real PuppetDB — files, TLS, authorisation, the real client |

These need `sudo` only because Docker does.

---

## Opening a pull request

1. **Branch** from `main`.
2. **Sign off your commits** — `git commit -s` (DCO).
3. **Run `npm run typecheck && npm run lint && npm test`.** A lint failure on an architectural rule is a design problem, not a style one; do not silence it with a disable comment without saying why in the PR.
4. **Explain the *why* in the commit message.** What the diff does is visible; why it does it is not. If you fixed a bug, say what it would have done to a real estate.
5. **CI must be green.** Five checks run: core-isolation build (typecheck, lint, unit tests, with the enterprise layer absent), Prisma migrations and integration tests, browser E2E, formatting, and a copyleft dependency check.

### Commit messages

Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`) and a body that explains reasoning. Good ones read like a short incident note: what was wrong, what it would have cost, what changed.

### Dependencies

The `licenses` CI job fails the build on copyleft dependencies. If you are adding a package, check its licence first — an incompatible one will not be discovered politely.

---

## Reporting bugs and security issues

Ordinary bugs: [open an issue](https://github.com/eth-man/nexuspuppet/issues) with the version, the Puppet or OpenVox version, and what you expected.

**Security issues: do not open a public issue.** Report them privately via [GitHub security advisories](https://github.com/eth-man/nexuspuppet/security/advisories/new). Never paste certificates, private keys, or tokens into an issue, a PR, or a CI variable — anything in a build log is effectively public.
