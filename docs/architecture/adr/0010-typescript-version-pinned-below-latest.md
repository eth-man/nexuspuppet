# ADR-0010 — TypeScript pinned to 5.9.x, below the published `latest`

- **Status:** Accepted
- **Deciders:** Architect
- **Related:** [ADR-0001](./0001-typescript-monorepo-npm-workspaces.md), [ADR-0008](./0008-nextjs-app-router-latest-stable.md)

## Context

[ADR-0008](./0008-nextjs-app-router-latest-stable.md) establishes a preference for current stable releases. Applying that uniformly to TypeScript breaks the build.

At scaffold time the registry reports:

```
typescript              latest = 7.0.2
ts-jest       peer  typescript >=4.3   <7        ← excludes 7.x
typescript-eslint 8.65.0
              peer  typescript >=4.8.4 <6.1.0    ← excludes 7.x and 6.1+
```

The intersection of what the toolchain actually supports is **TypeScript 5.x through 6.0.x**. Installing `typescript@latest` yields a repository that cannot lint and cannot run its Jest suites — which would silently disable the two quality gates the Definition of Done depends on.

## Decision

**Pin TypeScript to `~5.9.3`.**

- `typescript-eslint` supports up to `<6.1.0`, so 6.0.x is nominally available. 5.9.x is chosen over 6.0.x because NestJS 11 depends on `experimentalDecorators` and `emitDecoratorMetadata`, and the 6.x line begins the migration toward the standard decorator proposal. The decorator metadata that Nest's dependency injection reads at runtime is precisely the area in flux. On a codebase whose entire extensibility model is DI ([ADR-0002](./0002-open-core-runtime-discovery.md)), that is not a risk worth taking at scaffold time for no feature gain.
- `~5.9.3` rather than `^5.9.3`: patch updates only. TypeScript minors routinely introduce new errors in `strict` mode, and an unattended minor bump breaking CI is a bad trade for features nobody asked for.

**Revisit when** `typescript-eslint` and `ts-jest` both publish peer ranges admitting 7.x. Track it as a maintenance item, not a background upgrade — moving to TS 7 will require re-verifying NestJS decorator metadata end to end.

## Consequences

- Lint and test gates work. This is the entire point.
- The repo runs a TypeScript two majors behind `latest`, which will look stale to contributors. This ADR is the answer to "why aren't we on 7?" — hence writing it rather than leaving an unexplained pin.
- Any dependency added later that *requires* TS 7 is incompatible with the toolchain and must be rejected or must wait.
- No feature loss that affects this codebase. Nothing in the scaffold needs 6.x or 7.x language features.

## Alternatives considered

- **`typescript@7` and drop `typescript-eslint`.** Loses type-aware linting, which is what enforces the ADR-0002 module boundary. Rejected — the boundary rule is load-bearing.
- **`typescript@7` and replace `ts-jest` with `@swc/jest` or Node's native type stripping.** Solves the test half; the lint half remains broken. Rejected.
- **`typescript@6.0.3`.** Within both peer ranges and closer to current. Rejected for the decorator-transition risk against NestJS 11, for no offsetting benefit.
- **Float the version (`*` / `latest`).** Non-reproducible builds and a CI break on any upstream publish. Rejected outright.
