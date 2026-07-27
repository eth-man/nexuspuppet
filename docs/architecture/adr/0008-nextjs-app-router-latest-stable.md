# ADR-0008 — Next.js App Router on current stable; the web tier holds no data credentials

- **Status:** Accepted
- **Deciders:** Project owner, architect
- **Related:** [ADR-0002](./0002-open-core-runtime-discovery.md), [C4 L2](../c4-l2-container.md)

## Context

The intake originally pinned Next.js 14 and the project owner subsequently dropped that pin, directing the scaffold to use current stable to pick up present-day App Router and caching behaviour.

At scaffold time the registry reports **Next.js 16.2.12** with **React 19.2.8**. Next 15 and 16 changed caching defaults materially from 14 — `fetch` is no longer cached by default, and route-level caching is opt-in. Scaffolding on 14 semantics and upgrading later would mean re-auditing every data path.

## Decision

**Next.js 16.x (App Router) with React 19.x**, scaffolded against the current stable release rather than a legacy pin.

### Binding constraints on the web tier

1. **No data-layer credentials.** `apps/web` has no `DATABASE_URL`, no PuppetDB certificate, and no ability to reach either. It talks to `apps/api` over HTTP and nothing else. Enforced by an ESLint rule banning `@prisma/client` and `undici` imports in `apps/web`.

   Next.js server components make direct database access technically easy. Doing it would place authorization logic in two applications and split the audit trail — the single most likely way this architecture decays.

2. **Authorization is never decided in the web tier.** It may *hide* UI a user cannot use; the API independently rejects the request regardless. Hidden UI is a usability affordance, not a security control.

3. **Server components for the first paint, TanStack Query for interaction.** Inventory tables render server-side for fast first paint over large datasets, then hydrate into TanStack Query for pagination, filtering, and polling. Pagination is server-driven — a 10,000-row table must never ship 10,000 rows to the browser.

4. **Caching is explicit.** Because Next 15+ no longer caches `fetch` by default, every cached read states its `revalidate` and cache tags at the call site. PuppetDB-backed reads use short TTLs; classification reads are not cached at all, since showing stale classification after a save would misrepresent the state of the estate ([ADR-0003](./0003-enc-generate-dont-serve.md)).

5. **Version floors are recorded in the lockfile, not in prose.** Ranges are `^`-pinned in `package.json`; `package-lock.json` is committed and is the reproducibility guarantee.

## Consequences

- Current caching semantics from day one, no upgrade audit later.
- Next 16 requires React 19; the component ecosystem must be React 19 compatible. shadcn/ui and Tailwind 4 are.
- A separate `web` and `api` container means one extra network hop versus co-locating logic in Next.js route handlers. Accepted deliberately: it is what keeps the API independently testable, independently deployable, and the sole place authorization lives.
- Next.js major upgrades are a recurring maintenance cost. Mitigated by keeping business logic entirely in `api`, so an upgrade touches rendering only.

## Alternatives considered

- **Stay on Next.js 14** as originally scoped. Rejected by the project owner; would have meant scaffolding against superseded caching semantics.
- **Next.js route handlers as the backend, no separate API.** One fewer container and less duplication, but couples the entire product to the rendering framework, blocks the enterprise DI model from ADR-0002, and makes NestJS's dependency injection — the mechanism the open-core boundary relies on — unavailable. Rejected.
- **Pages Router.** More mature and better documented, but forgoes server components, which are the reason SSR is viable for large inventory tables. Rejected.
- **A pure SPA (Vite + React).** Simpler mental model, worse first paint on large tables, and no server-side rendering for the report views. Rejected.
