# Intake — NexusPuppet

Dual-architecture: Open Core (public repo) + Enterprise (private Git submodule).
Strict TypeScript monorepo (npm workspaces).

Status: pre-scaffold. Working directory empty.

---

## A. The 6 Blocking Questions

| # | Question | Default (assumed unless corrected) |
| --- | --- | --- |
| 1 | Open-source Puppet or Puppet Enterprise? | OSS: PuppetDB read-only + custom NestJS ENC. Enterprise features load dynamically via the private submodule. |
| 2 | Primary job of the GUI? | Inventory/reports visibility (PuppetDB proxy) + lightweight native node classification (ENC rules in PostgreSQL). |
| 3 | Scale — how many managed nodes? | ~1,000 nodes, ~2 runs/node/day. Dictates pagination strategy for the Next.js frontend. |
| 4 | Who logs in? | Ops team, ~10–30 users. Core = local auth; Enterprise = AD/LDAP dynamic module. |
| 5 | Deployment target? | Docker Compose (Node API, Next.js web, PostgreSQL) on a single on-prem VM; clean path to Kubernetes. |
| 6 | Does the GUI ever WRITE? | Writes strictly to local PostgreSQL (UI settings, users, ENC node-to-class mappings). PuppetDB stays read-only. |

## B. Puppet Environment Facts — NEEDED FROM CLIENT

- [ ] puppetserver version, agent versions, OS mix of managed nodes
- [ ] PuppetDB version, URL, PQL access, client cert/key for NestJS mTLS
- [ ] Report processor enabled? Retention period, daily run volume
- [ ] Control-repo layout + code deployment method (r10k / Code Manager / manual)
- [ ] Current node classification strategy (site.pp / Foreman / roles-and-profiles)
- [ ] Environments in use (production, staging, dev)

### Fixtures to drop in `/fixtures/`
- [ ] One node's full facts JSON
- [ ] One successful report JSON
- [ ] One failed report JSON
- [ ] `puppet-query 'nodes[certname, report_timestamp] {}'` — ~50 rows

## C. Product & Scope Inputs

- [ ] Problem statement: what hurts today that justifies this hybrid UI?
- [ ] Must-haves for v1 (Core only)
- [ ] Enterprise triggers: which workflows define the public/private boundary?

## D. Integration & Constraints

- [ ] Auth source: Local DB (Core) vs AD/LDAP/SAML (Enterprise module)
- [ ] Private Enterprise repo host (GitHub Enterprise / GitLab) — for submodule hooks
- [ ] Network: egress restrictions? npm proxy?
- [ ] Secrets: how are PuppetDB mTLS certs injected into the NestJS container?

## E. Designer Inputs

- UI framework: shadcn/ui + Tailwind CSS
- Density: dense ops console (Grafana-like)
- Theme: dark mode first
- Reference products: Foreman, PE console, Datadog

## F. QA Inputs

- Target: solid internal infrastructure tool
- [ ] Non-prod Puppet environment to query against
- Performance: node table handles 10k rows gracefully; SSR mitigates heavy client load
- Definition of Done: reviewed PR + Jest unit tests + Prisma typechecks + ESLint

## G. Access Checklist

- [ ] Main Git repository created, push access
- [ ] Private Enterprise Git repository created for the submodule
- [ ] Read-only PuppetDB endpoint + client certificate/key for mTLS testing
- [ ] Staging host for Docker deployment

## H. Tech Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | Next.js (App Router) + React + TanStack Query | SSR/CSR blending; TanStack handles complex table state and caching |
| Styling | Tailwind CSS + shadcn/ui | Component ownership, no vendor lock-in |
| Backend | NestJS (TypeScript) | DI allows hot-swapping Core modules with Enterprise submodule plugins |
| Database | PostgreSQL via Prisma ORM | Local app state, users, native ENC rules |
| Auth | Local JWT (Core) / modular SSO (Enterprise) | Fits dual-architecture strategy |
| Testing | Jest + Playwright + Testcontainers | Native to the TypeScript monorepo ecosystem |

## I. Deliverables

- **Architect:** `CLAUDE.md` rulebook · Prisma schema · monorepo scaffolding (npm workspaces) · dynamic Enterprise module hook logic
- **Designer:** responsive layouts · table pagination components · error/offline states for PuppetDB mTLS drop
- **QA:** Jest suites for the ENC YAML generator · API proxy unit tests

## J. Minimum to Start

1. Confirmation of Section A defaults
2. Section B fixtures
3. Confirmation to initialize npm workspace + generate Prisma schema

---

## K. OPEN ARCHITECTURAL ITEMS (raised by architect, unresolved)

1. **ENC availability coupling** — a custom NestJS ENC puts this app on the critical path of every Puppet run fleet-wide. Needs a fail-safe design decision before scaffold. See ADR-001 (pending).
2. **Master architecture document** — referenced but not present in repo. Must be committed or drafted.
3. **Open-core licensing** — public repo license undecided; submodule boundary has license implications.
4. **Private submodule in a public repo** — `.gitmodules` leaks the private URL; public CI must build green without the submodule present.
5. **Cross-boundary type contract** — Core and Enterprise need a shared `@nexuspuppet/contracts` package; neither may import the other directly.
6. **Next.js version** — doc pins 14; current stable is newer. Confirm pin or upgrade.
