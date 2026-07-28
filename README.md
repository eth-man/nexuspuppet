# NexusPuppet

**A web console and node classifier for Puppet and OpenVox that physically cannot cause an outage.** It never sits on the critical path of a Puppet run — classification is materialized to YAML files on disk, so agents keep converging even if every NexusPuppet container is dead.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/eth-man/nexuspuppet/actions/workflows/ci.yml/badge.svg)](https://github.com/eth-man/nexuspuppet/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<!-- INSERT_DEMO_GIF_HERE -->

![NexusPuppet dashboard](docs/images/dashboard.png)

<!-- INSERT_DASHBOARD_SCREENSHOT_HERE — replace the image above with your own if you prefer -->

<details>
<summary><b>More screenshots</b> — inventory, classification, reports</summary>

### Node inventory
![Node inventory](docs/images/nodes.png)

### Classification: a group, its rules and its classes
![Classification group](docs/images/classification-detail.png)

### Why a node has the classes it has
![Node classification](docs/images/node-detail.png)

### Run reports, down to the failing resource
![Report detail](docs/images/report-detail.png)

</details>

---

## Why NexusPuppet

**🛡️ Zero outage risk — by construction, not by uptime.**
A conventional ENC is an HTTP endpoint `puppetserver` calls during *every* catalog compilation, for *every* node, on *every* run. That puts a console on the critical path of fleet-wide configuration management. NexusPuppet writes YAML to a shared volume instead, and `puppetserver` reads it with a dependency-free `cat`. Stop the containers, drop the database, deploy a broken image — agents keep converging against the last known good state. ([ADR-0003](docs/architecture/adr/0003-enc-generate-dont-serve.md))

**🔌 Puppet *and* OpenVox, no configuration change.**
[OpenVox](https://github.com/openvoxproject) is Vox Pupuli's fork of Puppet. `openvoxdb` serves the same API and identifies as `PuppetDB`, so everything just works — and that was verified, not assumed: a live `openvoxdb 8.15.0` checked against a live `PuppetDB 7.10.0` across every AST operator, every mapped field, and the paging the reconciler depends on.

**🔒 Read-only by design, safe by default.**
PuppetDB is never written to. Queries are built as a parameterised AST, never string-interpolated PQL, so injection is structurally impossible rather than escaped-and-hoped-for. The web tier holds no database credentials at all.

**📖 Genuinely open core.**
Everything in this repository is Apache-2.0 and is a complete, usable product. The optional enterprise layer (SSO, scoped RBAC, licensing) is discovered at runtime — there is no submodule, no URL, and no compile-time reference to it anywhere in this repo. CI proves on every commit that core builds and passes with no enterprise layer present.

---

## Quickstart — try it in 2 minutes, no Puppet required

The fastest path runs the whole console against a **PuppetDB stand-in serving real captured fixture data over real mTLS**. You need Docker and Node ≥ 22.12; you do *not* need Postgres, puppetserver, or any Puppet infrastructure.

```bash
git clone https://github.com/eth-man/nexuspuppet.git
cd nexuspuppet

docker compose -f docker-compose.dev.yml up -d          # Postgres, in Docker

cp .env.example .env
# Fill in the three values that have no safe default. Edited in place rather
# than appended, so .env keeps exactly one line per key.
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet?schema=public|" .env
sed -i "s|^BOOTSTRAP_ADMIN_PASSWORD=.*|BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -base64 24)|" .env

npm install && npm run build
npm run db:migrate
npm run dev:stack
```

Open **<http://localhost:3000>** and sign in as `admin@example.com` with the
`BOOTSTRAP_ADMIN_PASSWORD` you just generated (`grep BOOTSTRAP_ADMIN_PASSWORD .env`).

That gives you a PuppetDB stand-in on `:8081`, the API on `:3001`, and the console on `:3000`. Throwaway certificates are generated on first run into `scripts/dev/certs/` (gitignored). The stand-in evaluates the same query AST the API emits, so filtering, sorting and pagination behave exactly as a real PuppetDB would.

> **New here?** The [**User Guide**](docs/USER_GUIDE.md) walks through the console, node classification, and run reports — start there once the stack is up.

### Want a *real* Puppet estate locally?

One command brings up a genuine `puppetserver` + PuppetDB + agent in Docker, issues NexusPuppet a certificate, and wires the ENC:

```bash
sudo ./scripts/dev/puppet-stack.sh
```

Or the OpenVox equivalent, with a compatibility report at the end:

```bash
sudo ./scripts/dev/openvox-stack.sh && ./scripts/dev/openvox-compat.sh
```

---

## Documentation

| | |
|---|---|
| 📘 [**User Guide**](docs/USER_GUIDE.md) | Using the console: inventory, classification, reports, administration |
| 🚀 [**Deployment**](DEPLOYMENT.md) | A fresh on-prem VM, end to end — certificates, `.env`, migrations, puppetserver wiring, TLS, backups |
| 🧭 [**Roadmap**](ROADMAP.md) | What is built, what is next, and where to help |
| 🤝 [**Contributing**](CONTRIBUTING.md) | Local development, tests, architecture boundaries, how to open a PR |
| 🏛 [**Architecture**](docs/architecture/README.md) | C4 diagrams and eleven ADRs recording the binding decisions |

---

## How it works

```
        ┌──────────────┐         mTLS, read-only          ┌──────────────┐
        │  NexusPuppet │ ───────────────────────────────► │   PuppetDB   │
        │     API      │      facts, reports, nodes       │  / openvoxdb │
        └──────┬───────┘                                  └──────────────┘
               │ writes YAML
               ▼
        ┌──────────────┐         plain file read          ┌──────────────┐
        │  ENC volume  │ ◄─────────────────────────────── │ puppetserver │
        │  (*.yaml)    │        `cat`, no network         │              │
        └──────────────┘                                  └──────────────┘
```

**There is no arrow from `puppetserver` back to NexusPuppet.** That absence is the whole design. The cost is that classification changes are eventually consistent — typically sub-second — and for infrastructure tooling that is the right trade.

```
apps/api             NestJS      business logic, authz, PuppetDB proxy, ENC materializer
apps/web             Next.js     rendering only — no database or PuppetDB credentials
packages/contracts   types       interfaces, DI tokens, Zod schemas
packages/enterprise  (absent)    optional private layer, loaded at runtime
docs/architecture    C4 + ADRs   binding decisions
```

---

## Connecting it to Puppet

1. Mount the ENC volume **read-only** on your puppetserver.
2. Install [`scripts/nexuspuppet-enc.sh`](scripts/nexuspuppet-enc.sh).
3. Point the node terminus at it:

```ini
# /etc/puppetlabs/puppet/puppet.conf
[master]
node_terminus  = exec
external_nodes = /usr/local/bin/nexuspuppet-enc.sh
```

That script makes no network calls and depends on nothing but `/bin/sh`. That is deliberate — please do not "improve" it into an API client.

**Running OpenVox?** Nothing changes, with one deployment note: `openvoxdb` requires the `pg_trgm` PostgreSQL extension and will not start without it. See [DEPLOYMENT.md](DEPLOYMENT.md#puppet-or-openvox).

---

## Project status

Verified against a real estate, not just a test suite. The architecture, contracts, schema, classification engine, materializer, PuppetDB client and projector, authentication and web console are implemented and tested — commissioned against a real `puppetserver 7.9.2`, `PuppetDB 7.10.0` and a real agent. The mTLS client, the AST queries, the projection, and the full ENC path from a classification write to an applied catalog all work end to end.

Test fixtures are **captured from a real estate**, not generated from documentation — see [`fixtures/README.md`](fixtures/README.md) for exactly what is captured, what is synthesised, and what a single-node capture still cannot tell you.

**Not yet exercised at estate scale.** If you run this against a large fleet, [we would like to hear what breaks](https://github.com/eth-man/nexuspuppet/issues).

---

## Open core

The enterprise layer lives in a separate private repository. This one contains no reference to it. It is fetched by an environment-driven script and discovered at runtime:

```bash
NEXUSPUPPET_ENTERPRISE_REPO=... npm run enterprise:fetch && npm install
```

Without that variable the script is a no-op and you get the core edition — a complete product, not a demo. See [ADR-0002](docs/architecture/adr/0002-open-core-runtime-discovery.md).

---

## Contributing

Contributions are welcome — see [**CONTRIBUTING.md**](CONTRIBUTING.md) for local setup, the test suites, and the architectural boundaries `npm run lint` enforces. New here? [**ROADMAP.md**](ROADMAP.md) has a good-first-issues section.

## License

[Apache-2.0](LICENSE).
