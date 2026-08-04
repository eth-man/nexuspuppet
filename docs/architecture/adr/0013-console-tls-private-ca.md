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

None remain. Every question below was resolved during implementation; they are kept with their answers because the reasoning is the useful part.

2. ~~**Where do certificates live by default?**~~ Resolved: `/etc/nexuspuppet/tls/`, holding `console.pem` and `console.key`.

   A **separate directory from `/etc/nexuspuppet/certs/`**, and the separation is load-bearing rather than tidiness. `certs/` is mounted into the **api**; `tls/` is mounted into the **proxy**. Putting the TLS key alongside the PuppetDB client material would place it inside a directory the api already mounts, which is exactly what §2 of this ADR forbids. Same parent so an operator learns one convention; different leaf so the two mounts cannot blur into each other.
3. ~~**How is expiry surfaced?**~~ Resolved: a separate `GET /system/tls`, gated on `settings:manage` rather than `inventory:read`. It is infrastructure detail — issuer, subject alternative names, a filesystem path in the error case — and belongs to whoever administers the deployment rather than to everyone who may look at the estate.
4. ~~**Does the reload need an audit row?**~~ Moot: there is no reload action, see §3.
5. ~~**What is the exact ownership requirement?**~~ Resolved, and the answer is to stop asking operators to match a uid.

   | Path | Mode | Owner |
   | --- | --- | --- |
   | `/etc/nexuspuppet/tls/` | `0755` | `root:root` |
   | `console.pem` | **`0444`** | `root:root` |
   | `console.key` | `0400` | `root:root` |

   **`0444` on the certificate is the substance of this.** [#28](https://github.com/eth-man/nexuspuppet/pull/28) happened because a `0600 root:root` file was mounted into a container running as uid 100, and the fix was to document a `chown` — correct, but it leaves the same trap for the next container with a different uid. A certificate is *public*; it is sent to every browser that connects. Making it world-readable means the single-file mount into the api works whatever uid the api runs as, today or after a base-image bump. The failure mode is removed by construction rather than by documentation.

   The key stays `0400 root:root` because only the proxy mounts it, and the proxy runs as root.

   The directory is `0755` because a tighter mode buys nothing: Docker resolves bind sources as root regardless of the container's uid, and nothing secret is revealed by the listing.

   **The proxy's uid is not pinned.** The official Caddy image runs as root so it can bind 80 and 443, and that is left alone. The api image *does* pin `-u 100` ([#33](https://github.com/eth-man/nexuspuppet/pull/33)) because §3 of DEPLOYMENT.md asks operators to name that number for the PuppetDB certificates. The rule the two cases share: pin a uid when the documentation asks an operator to match it, and arrange things so it rarely has to.

   Considered and deferred: running Caddy non-root with Docker owning the privileged port (`443:8443`). Better isolation for the internet-facing component, but it needs a non-root user in an image that ships none, plus writable `/data` and `/config`. Worth doing on its own; not worth bundling into this.
6. ~~**HSTS**~~ Resolved: **off**, and not offered as a toggle. Caddy adds no `Strict-Transport-Security` header on its own and none is added here.

   A browser that has seen HSTS refuses plain HTTP to that host for the whole `max-age`, regardless of what the server later says. That turns "drop to HTTP for ten minutes to find out why the proxy is routing wrongly" into a per-browser cache-clearing exercise, during an incident. It is trivial to enable at an edge or load balancer, where whoever turns it on also owns the rollback — so it belongs there, not in a default we ship. The Caddyfile carries a commented one-liner for operators who want it anyway.

   The HTTP→HTTPS **redirect** stays on: it is reversible, and serving the console unencrypted by accident is the failure it prevents.

---

## Amendment — self-signed fallback on an empty first run

**Status:** Accepted, superseding the "not automatic issuance" note above in one
narrow case.

The original decision said no ACME, no CA integration, no auto-issue, and that
automatic issuance was "a plausible follow-on and a poor thing to design
speculatively". Two of those still hold. The third stopped being speculative.

### What went wrong

A first run against an empty `/etc/nexuspuppet/tls` does not start. Caddy is
handed `live/console.pem` and there is nothing there, so `docker compose
--profile tls up` fails — and the operator's remaining options are to run
`puppetserver ca generate` (which needs a Puppet CA and root), or to bring the
console up without the `tls` profile, on plain HTTP.

That second option is the problem. It is the path of least resistance from a
failed start, it is reachable by an operator who has not yet read §7, and it
serves a login form over cleartext. An appliance that answers a fresh install by
either crashing or falling back to unencrypted HTTP has chosen the two worst
outcomes available to it.

This was found by rebuilding the VM from nothing and noticing that the install
only succeeded because the previous certificate had been preserved. Nothing in
the test suite covered it: every environment that runs the stack already has a
certificate on disk, so the empty case had never been executed.

### Decision

**cert-helper generates a self-signed certificate when, and only when, the TLS
directory holds nothing it can serve.** The order at boot is: adopt an existing
`console.pem`/`console.key` if present, else generate. An operator who has put a
certificate there always keeps it; generation is reachable only from empty.

The certificate carries `O=NexusPuppet temporary self-signed` in its subject.
That is not decoration: a certificate that is self-signed because we made one and
a certificate that is self-signed because the operator meant it look identical
otherwise, and the console has to be able to say "replace this" about the first
without nagging about the second. `CertificateSummary.temporary` is derived from
that marker, and the console leads with it.

It is a real certificate with the console's hostname in the SAN, five-year
validity, and a 2048-bit RSA key — long-lived deliberately, because a fallback
that expires turns a working console into a broken one at a date nobody wrote
down.

### What this costs

**A browser warning on first contact.** Accepted. The alternative on offer was
not "no warning" — it was "no encryption", or "no console". A warning is a thing
an operator can read, understand, and fix by installing their own certificate;
cleartext is a thing they do not notice.

**`openssl` in the cert-helper image**, about 5 MB. Node has no
certificate-signing API, and the alternative was a JavaScript X.509 library in
the one component whose entire job is handling private keys. A binary from the
distribution, invoked with a fixed argument list through `execFile` and never a
shell, is the smaller thing to trust.

### What is still not done

No ACME. No issuance from the Puppet CA. No renewal of anything. The product
still expects an operator to install a certificate their organisation trusts,
and still tells them when it is expiring — this only removes the state where
there is nothing to serve at all.
