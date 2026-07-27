# ADR-0001 — TypeScript monorepo on npm workspaces

- **Status:** Accepted
- **Deciders:** Project owner, architect

## Context

NexusPuppet is a frontend (Next.js), a backend (NestJS), and a shared contract surface that both consume — plus an optional private package that must slot in without ceremony. These share types constantly: an `EncDocument` rendered in the UI is the same shape the materializer writes.

The intake fixes the language as TypeScript throughout and the layout as an npm-workspaces monorepo.

## Decision

A single repository with npm workspaces:

```
apps/api          @nexuspuppet/api          NestJS
apps/web          @nexuspuppet/web          Next.js
packages/contracts @nexuspuppet/contracts   interfaces, tokens, Zod schemas
packages/enterprise @nexuspuppet/enterprise optional, private, gitignored
```

Workspace globs are `apps/*` and `packages/*`. The enterprise package is picked up automatically when present and is simply absent otherwise — no workspace configuration differs between public and private builds.

**npm workspaces specifically**, not pnpm/yarn/turbo/nx:

- It ships with Node. An on-prem infrastructure tool should not require a package manager install as step zero.
- The workspace glob makes the optional-enterprise-package trick work with no extra machinery ([ADR-0002](./0002-open-core-runtime-discovery.md)).
- At four packages, the build-orchestration features of Turbo/Nx are not yet worth their configuration surface.

TypeScript is configured with a root `tsconfig.base.json` in `strict` mode plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Packages reference each other through **TypeScript project references** and their `package.json` `exports` field — never through relative paths that escape a package root.

## Consequences

- One `npm install`, one lockfile, atomic cross-package changes in a single commit.
- `strict` plus the two extra flags will reject some idiomatic-looking code. That is the intent: this tool writes configuration that reconfigures a thousand machines.
- If build times become painful, adding Turborepo later is additive and does not invalidate this layout.
- Contributors must not add a dependency from `contracts` to anything but `zod` — enforced by lint ([ADR-0002](./0002-open-core-runtime-discovery.md)).

## Alternatives considered

- **Polyrepo** — every contract change becomes a multi-repo version dance. Rejected outright for a team of this size.
- **pnpm workspaces** — stricter hoisting and faster, genuinely better on the merits, but adds an install prerequisite for on-prem operators. Revisit if install time becomes a real complaint.
- **Nx** — powerful generator and boundary tooling, but its module-boundary enforcement would duplicate the ESLint rule we need anyway, at the cost of a large configuration surface.
