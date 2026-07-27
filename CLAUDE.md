# NexusPuppet — working rules

Read `docs/architecture/README.md` before making structural changes. ADRs in
`docs/architecture/adr/` are binding; where an ADR and any other document
conflict, the ADR wins.

## What this is

A Puppet estate console: read-only PuppetDB visibility plus a native ENC that
classifies nodes. Open core (Apache-2.0) with an optional private enterprise
layer loaded at runtime.

```
apps/api            NestJS      all business logic, authz, PuppetDB, materializer
apps/web            Next.js     rendering only
packages/contracts  types       interfaces, DI tokens, Zod schemas
packages/enterprise private     optional, gitignored, absent in this repo
```

## The three rules that are not negotiable

**1. Nothing may make Puppet depend on NexusPuppet at runtime.** (ADR-0003)

The ENC writes YAML to a shared volume; `puppetserver` reads it with a
dependency-free `cat`. Do not add an HTTP ENC endpoint, a "just for testing"
classifier route, or any synchronous path from `puppetserver` into this
application. If NexusPuppet is down, agent runs must continue unaffected.
Changing this requires a superseding ADR, not a PR comment.

**2. Core must build, typecheck, lint, and test with no enterprise layer.** (ADR-0002)

Never `import` from `@nexuspuppet/enterprise`. Depend on an interface in
`@nexuspuppet/contracts`; the enterprise layer registers an implementation at
boot. The only file permitted to reference enterprise code is
`apps/api/src/enterprise/enterprise.loader.ts`. ESLint enforces this.

**3. `apps/web` never touches data directly.** (C4 L2, ADR-0008)

No `@prisma/client`, no database URL, no PuppetDB certificate in the web tier.
The browser calls same-origin `/api/*`, which `app/api/[...path]/route.ts`
relays server-side; `API_INTERNAL_URL` is deliberately not `NEXT_PUBLIC_`.
Authorization is decided in `api` only — `can()` in the UI hides what a user
cannot use, and is never a security control.

## Writing UI

- **Never colour a Puppet state ad hoc.** `lib/status.ts` is the single mapping
  from state to appearance; use `<StateBadge>` or `stateStyle()`. A second
  mapping is how "failed" ends up amber on one screen and red on another.
- Monospace is mandatory for facts, YAML, and run logs — proportional type
  destroys the column alignment that makes nested data legible.
- Density is the point: 32px controls and tight rows. An operator wants the
  estate on one screen.
- The main content area is fluid-width, never boxed. Wide tables scroll inside
  their own container so the page body never scrolls horizontally.

## Writing classification code

`apps/api/src/materialization/pure/` decides what a thousand machines run.

- Keep it **pure**: no I/O, no clock, no randomness. ESLint enforces this.
- Keep it **deterministic**: identical input must produce byte-identical YAML.
  Content-hash change detection depends on it; non-determinism turns a no-op
  into estate-wide file churn.
- Coverage floor is 95% lines / 90% branches, versus 60% elsewhere.
- Merge semantics are fixed by ADR-0009: union classes, last-writer-wins per
  key, **no deep merge**. Do not add deep merging because it "seems more
  useful" — it makes effective values unreadable from any single group.

## Writing anything that reads PuppetDB

- Read-only. There is no command/write surface and none may be added. (ADR-0004)
- **Never interpolate user input into PQL.** Accept a typed, Zod-validated
  filter; let `PqlBuilder` produce parameterised PQL. The mTLS certificate is
  estate-wide, so the API is a confused deputy by construction — authorization
  happens in `api`, before the query.
- PuppetDB being unreachable is an explicit UI state showing last contact time.
  Not an empty table, not an endless spinner, not a generic 500.
- **Never delete local state because PuppetDB returned less than expected.** A
  partial fetch looks exactly like a shrunken estate. NodeProjectionService
  refuses to prune on an empty or implausibly small response — deleting
  ManagedNode cascades to EncMaterialization, the reconciler then removes the
  YAML, and a network blip would unclassify the fleet.

## Writing anything that changes classification

Every classification write is **one transaction** containing:

1. the domain change,
2. the `AuditLog` row,
3. the `EncMaterializationJob` outbox row.

Splitting these lets a committed change silently never reach disk. Return `202`
with the job id — never imply a change is live before `EncMaterialization`
confirms it.

## Writing anything behind authentication

- Routes are protected by default. A route with **no** `@RequirePermission` is
  denied even to an authenticated caller — access is granted by an explicit
  decorator, never by forgetting one. `@Public()` opts out and is greppable.
- Depend on the `AUTHORIZATION_POLICY` and `AUTH_PROVIDER` tokens, never on
  `RbacPolicy` or `LocalAuthProvider` directly. The enterprise layer replaces
  either one independently (ADR-0006).
- Login failures return one message for every cause. Distinguishing "no such
  user" from "wrong password" makes login a user-enumeration oracle.
- Never log a token, a password, or a refresh value.

## Conventions

- TypeScript is pinned to `~5.9.3` on purpose. See ADR-0010 before upgrading.
- `strict`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
  Indexing a record yields `T | undefined`; handle it rather than asserting.
- Enterprise-only routes exist in core and return `501` with a `capability`
  field — not `404`. The feature exists; this deployment lacks it.
- Secrets arrive as env vars or mounted files. `JWT_SECRET` has no default and
  the API refuses to boot without it; do not add a development fallback.
- Passwords use `node:crypto` scrypt. No native crypto dependencies — on-prem
  operators may have no build toolchain. (ADR-0006)

## Commands

```bash
npm install                  # one lockfile, all workspaces
npm run build                # contracts first, then apps
npm run typecheck
npm run lint                 # includes the ADR boundary rules
npm test                     # unit tests
npm run db:generate          # after any schema.prisma change
npm run enterprise:fetch     # no-op without NEXUSPUPPET_ENTERPRISE_REPO
```

## Definition of done

Reviewed PR · unit tests for new logic · `npm run typecheck` clean ·
`npm run lint` clean · `prisma generate` run if the schema changed · new
architectural decisions captured as an ADR.
