# ADR-0002 — Open-core boundary via runtime discovery, not compile-time imports

- **Status:** Accepted
- **Deciders:** Project owner, architect
- **Related:** [ADR-0001](./0001-typescript-monorepo-npm-workspaces.md), [ADR-0007](./0007-apache-2-0-for-public-core.md)

## Context

NexusPuppet ships as open core: a public Apache-2.0 repository containing the whole product, plus a private enterprise layer (SSO, advanced RBAC, licensing) that only paying deployments receive.

The naive implementations both fail:

- **Git submodule referenced from the public repo** — `.gitmodules` publishes the private repository URL, and every external contributor gets a clone that cannot install or typecheck, because `packages/enterprise` is an empty directory that other packages import from.
- **Compile-time imports guarded by a flag** — TypeScript resolves imports at build time. If any core file writes `import { SsoProvider } from '@nexuspuppet/enterprise'`, the public repository no longer typechecks for anyone who lacks the private package. The boundary erodes on the first PR that finds it convenient.

The project owner's directive is explicit: public CI must compile, typecheck, and pass all tests entirely independently of the enterprise layer, with a lint rule preventing compile-time imports and no private URL in the public repo.

## Decision

**1. No git submodule.** `packages/enterprise/` is listed in `.gitignore`. The public repository contains no reference to the private repository — no `.gitmodules`, no URL, no name.

**2. Environment-driven clone.** `scripts/enterprise.mjs` clones the private repo into `packages/enterprise/` using `NEXUSPUPPET_ENTERPRISE_REPO` and `NEXUSPUPPET_ENTERPRISE_REF` from the environment. Absent that variable, the script exits 0 with a notice — never an error. It is safe to run in public CI, where it does nothing.

**3. Core depends only on `@nexuspuppet/contracts`.** Every extensible seam is an interface plus an injection token declared there. Core provides a default implementation of every token. There is no token that only enterprise can satisfy — the product is complete without it.

**4. Runtime discovery at boot.** `EnterpriseLoader` performs a dynamic `import('@nexuspuppet/enterprise')` inside try/catch. On `ERR_MODULE_NOT_FOUND` it logs once at info level and continues. On any *other* error it fails loudly — a present-but-broken enterprise package must not silently downgrade a paying deployment to core.

**5. Registration is one-way.** The enterprise module returns a descriptor listing `{ token, implementation }` pairs, which `CapabilityRegistry` uses to override core defaults. Enterprise may implement contracts; it may not import core internals. Enforced by lint on both sides.

**6. Lint enforcement.** ESLint `no-restricted-imports` bans `@nexuspuppet/enterprise` and any path containing `enterprise/` across the whole repo, with a single file-scoped exemption for `apps/api/src/enterprise/enterprise.loader.ts`. A second rule bans `apps/web` from importing `@prisma/client`. A CI job (`core-isolation`) additionally asserts `packages/enterprise` is absent, then runs the full build and test suite.

## Consequences

- The public repository is genuinely buildable and testable by strangers. This is the difference between open core and a marketing claim.
- Enterprise-only endpoints must return `501 Not Implemented` in core rather than 404 — the route exists, the capability does not. This is deliberate: it makes the feature boundary legible to users and testable in core.
- Every enterprise seam costs an interface in `contracts` and a default implementation in core. That is the price of the boundary, and it is paid up front rather than at the first integration.
- Dynamic `import()` means the enterprise package cannot participate in tree-shaking or type inference across the boundary. Types flow through `contracts` only, which is the intent.
- Losing type-checking across the boundary means the enterprise repo must run its own CI against a published `contracts` version. Contract changes are therefore breaking changes and must be versioned.

## Alternatives considered

- **Git submodule with a public URL** — rejected: publishes the private repo's location and breaks public clones.
- **Build-time feature flags with dead-code elimination** — still requires the enterprise source at build time, so public builds break. Rejected.
- **Separate enterprise fork of the whole product** — merge burden grows without bound; the two products diverge within months. Rejected.
- **Enterprise as a published private npm package** — a reasonable future refinement, and the runtime-discovery design already supports it unchanged. Deferred because it requires a private registry the project does not yet have.
