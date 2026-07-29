# ADR-0013 — TLS for the console, from a private CA, visible in Settings

- **Status:** Accepted
- **Deciders:** Architect
- **Related:** [ADR-0002](./0002-open-core-runtime-discovery.md), [ADR-0004](./0004-puppetdb-read-only-mtls.md), [ADR-0006](./0006-auth-local-jwt-modular-sso.md), [ADR-0008](./0008-nextjs-app-router-latest-stable.md)

## Context

The console serves plain HTTP on port 3000. [DEPLOYMENT.md §7](../../../DEPLOYMENT.md#7-put-tls-in-front-of-it) tells operators to put their own reverse proxy in front and terminate TLS there, and both published ports default to `127.0.0.1` precisely because nothing in this stack terminates TLS ([#26](https://github.com/eth-man/nexuspuppet/pull/26)).

That is a defensible position for a component meant to sit behind existing infrastructure. It is a poor one for a product whose first two installs both finished with "TLS reverse proxy" still on the to-do list.

**This is not cosmetic.** Session cookies are `HttpOnly` with the refresh token scoped to `/api/auth`, and they need a secure context to behave correctly in current browsers. Serving the console over bare HTTP is a functional limitation, not a missing padlock — and until the operator finishes §7, every login crosses the network in cleartext.

The estates this runs on already have a certificate authority: the Puppet or OpenVox CA that issued NexusPuppet's own PuppetDB client certificate. Nothing needs to be procured. What is missing is a supported path from "the CA is right there" to "the console is on `https://`", and a way to see and change that certificate without editing files on a host.

## Decision

### 1. TLS terminates in a bundled reverse proxy, not in the web tier

An optional service in `docker-compose.yml`, behind a Compose profile so it is off unless asked for.

**Not a custom Next.js server.** Terminating TLS inside `apps/web` puts bespoke code we own on the request path of every session, in the one place where a mistake is a security incident rather than a bug. Next.js standalone output is also not designed to be wrapped this way, and doing it means owning certificate reload, SNI, protocol negotiation and cipher selection ourselves. A mature proxy has solved all of that.

**Not a bare instruction to install nginx.** That is the status quo, and the status quo is what left two installs on plain HTTP.

The proxy must expose an **administrative reload API on the Compose network only**, so that changing a certificate does not mean restarting the console. This is the property that makes the rest of the decision possible, and it is the reason to prefer a proxy with a proper config API over one reloaded by signals — the API has no business holding a Docker socket in order to send `SIGHUP` to a sibling container.

### 2. Private keys are mounted files, and never touch the API

Certificates and keys are bind-mounted into the proxy, exactly as PuppetDB client certificates are mounted into the API today ([ADR-0004](./0004-puppetdb-read-only-mtls.md)).

**The Settings page does not accept uploads.** This is the load-bearing constraint of the whole design, so it is worth being explicit about what it rules out: no private key is ever sent to the API, stored in Postgres, written to an audit row, held in an environment variable, or rendered by any `describe()`. A key that only exists as a file mounted from a path the operator chose cannot leak through any of those.

Accepting an upload would put key material through the API and into storage, breaking the pattern ADR-0004 established and the boundary that keeps the web tier incapable of holding credentials at all.

### 3. What Settings actually does

Reads the **public certificate** — never the key — and reports what an operator needs to know:

- subject, issuer, and SANs, so they can see whether it matches the hostname people use
- **expiry, with a warning ahead of time.** An expired console certificate is an outage, and it is the single most common way TLS breaks
- whether the certificate and the configured hostname agree
Most deployments will have exactly one certificate, and will still benefit from being told it expires in nine days.

**No reload action, and no certificate selection.** An earlier draft promised both. Neither survives the decision below that the API stays proxy-agnostic: reloading means talking to a specific proxy's control plane, and this product cannot reload an operator's nginx, HAProxy or F5. Replacing the file and reloading the proxy is the operator's business, and it is one command they already know. Offering a button that worked only for the proxy we happen to ship would be worse than offering none — it would break silently for exactly the estates most likely to have replaced it.

Reading an X.509 certificate needs no new dependency — `node:crypto`'s `X509Certificate` already does this in `scripts/test-puppetdb.mjs`.

### 4. A bad certificate must never take the console away

Validate before switching: parse it, check the key pairs with the certificate, check it is not expired, check the chain resolves. If any of that fails, **refuse and keep serving what is currently working.**

The failure mode to design against is an operator locking themselves out of the console while trying to fix the console.

### 5. Core, not enterprise

HTTPS is not a premium feature. Putting basic transport security behind a licence would undercut the adoption story that open core depends on ([ADR-0002](./0002-open-core-runtime-discovery.md)) and would be difficult to defend on any other grounds.

### 6. Optional, and additive

An operator with an existing reverse proxy is unaffected: the profile stays off, §7's advice remains correct, and nothing about the web tier changes. This adds a supported path; it does not replace one.

## Consequences

### What this buys

A documented route from a private CA to a console on `https://`, without the operator writing proxy configuration. Certificate expiry becomes visible in the product rather than discovered by outage. Session cookies get the secure context they were designed for.

It also makes `WEB_BIND=0.0.0.0` a defensible choice for the first time. Today the loopback default exists because there is no TLS; with TLS terminating in the stack, exposing the console becomes a deliberate decision rather than a hazard.

### What it costs

**Browsers do not trust a private CA.** Everyone gets a warning page until the CA certificate is distributed to the machines that use the console. This is the main practical cost, it is not something this product can solve, and it must be stated plainly in the documentation rather than discovered. Estates running Puppet usually have a mechanism for this — Puppet itself — which is worth pointing at.

**A new component in the deployment.** One more container, one more thing to upgrade, one more log to read. Kept optional partly for this reason.

**A reload API on the Compose network.** It must not be published to the host, and the documentation must say so. An unauthenticated config API is a serious hazard if exposed.

**Certificate naming becomes load-bearing.** The certificate must carry the name people type into the browser. A certificate issued for the host's FQDN does not help someone reaching the console by IP, and the resulting error is confusing.

### What it does NOT buy

**Not mutual TLS for console users.** Client-certificate authentication for operators is a different feature with a different design, and this ADR does not begin it.

**Not automatic renewal.** No ACME, no CA integration, no auto-issue from the Puppet CA. The operator replaces files; the product tells them when to and reloads without downtime. Automatic issuance is a plausible follow-on and a poor thing to design speculatively.

## Alternatives considered

**Terminate TLS in `apps/web` with a custom Node server.** Removes the extra container and gives the app direct control over reload. Rejected: it puts code we own on the security-critical path of every request, requires owning cipher and protocol decisions, and fights Next.js standalone output. The convenience is real; it is not worth being the ones who get TLS wrong.

**Accept certificate uploads through Settings.** The most obvious reading of "change it from app settings", and the friendliest workflow. Rejected on the key-material boundary: it would route private keys through the API and into storage, contradicting ADR-0004 and the web tier's credential isolation. Visibility plus reload delivers most of the value at none of that cost.

**Document nginx or Caddy properly and ship nothing.** Cheapest, and honest — many operators genuinely do have a proxy. Rejected as the *only* answer because it is what we already do, and two installs in a row finished without TLS. Better documentation does not appear to be the missing piece.

**Store certificates in Postgres so multiple replicas share them.** Solves distribution for a horizontally scaled deployment. Rejected: private keys in the database is precisely the outcome the rest of this design exists to avoid, and the HA story is already constrained for other reasons ([DEPLOYMENT.md §8](../../../DEPLOYMENT.md#8-high-availability-and-horizontal-scaling)).

**Do nothing.** Viable. §7 is accurate, the loopback default is safe, and an operator who follows the guide ends up correct. The argument against is empirical: the guide has now been followed twice by capable people and both deployments are still on plain HTTP behind loopback, which means the console is reachable only via SSH tunnel and the product is harder to actually use than it should be.

## Resolved during implementation

**The API is proxy-agnostic, and reads a file.** Settings reports the certificate by reading a single mounted `.pem`, not by asking Caddy's admin API what it loaded.

The reasoning is not about coupling as a matter of taste. Enterprise operators replace a bundled proxy with their existing nginx, HAProxy or F5 as a matter of course — that is the normal case, not an exception — and an API that learned about certificates by interrogating Caddy would report "not configured" on a correctly running deployment the moment anyone did. A file path is the one interface every one of those layouts shares.

It also keeps the key isolation trivial rather than careful: the API is given the public certificate as a **single file**, never the directory containing the key. There is no path from the API to key material even if someone later adds a careless field to the response, because the process cannot open the file.

The cost is that the product cannot offer a reload button — see the amended §3.

**Which proxy: Caddy.** The requirement was a reload path reachable on the Compose network without signals or a Docker socket, and Caddy's admin API provides exactly that — `POST /load` replaces the running configuration atomically, no restart, no process signalling.

nginx would have needed `nginx -s reload`, which from another container means either sharing a PID namespace or handing the API a Docker socket. The second trades a certificate-reload feature for full control of every container on the host, which is not a trade worth making for this.

Caddy also defaults to a sensible TLS configuration and does the HTTP→HTTPS redirect without extra directives, which keeps the shipped config short enough that an operator will actually read it.

The cost is a component most Puppet operators will not have used before. Mitigated by the config being a few lines, and by the whole service being optional.

## Open questions
2. **Where do certificates live by default?** A single mounted directory scanned for pairs, or explicit paths in `.env` like the PuppetDB certificates? The latter matches existing practice; the former makes "select between them" natural.
3. ~~**How is expiry surfaced?**~~ Resolved: a separate `GET /system/tls`, gated on `settings:manage` rather than `inventory:read`. It is infrastructure detail — issuer, subject alternative names, a filesystem path in the error case — and belongs to whoever administers the deployment rather than to everyone who may look at the estate.
4. ~~**Does the reload need an audit row?**~~ Moot: there is no reload action, see §3.
5. **What is the exact ownership requirement?** The certificate-ownership defect in [#28](https://github.com/eth-man/nexuspuppet/pull/28) came from the API container's uid; a proxy container will have its own, and the documentation must not repeat that class of mistake.
6. **HSTS and the HTTP→HTTPS redirect** — on by default, or opt-in? HSTS is difficult to reverse if an operator later needs plain HTTP for a diagnosis.
