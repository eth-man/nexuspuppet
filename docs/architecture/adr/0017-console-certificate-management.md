# ADR-0017 — Installing a console certificate from the console

- **Status:** Accepted — option D, a CSR flow. Supersedes nothing in ADR-0013;
  the key boundary is not merely preserved but strengthened.
- **History:** first accepted as option B, a sidecar. Revised once the renewal
  frequency was known — once a year, or 90 days under automation. See
  *Why not B* below.
- **Deciders:** Architect
- **Related:** [ADR-0013](./0013-console-tls-private-ca.md), [ADR-0004](./0004-puppetdb-read-only-pql.md), [ADR-0016](./0016-settings-store-and-audit-forwarding.md)

## Context

The Console certificate card reports what is installed — subject, issuer, SANs,
days remaining — and nothing more. The request is to make it actionable: upload
a new certificate and apply it without touching the host.

This is not a gap that was overlooked. [ADR-0013 §2](./0013-console-tls-private-ca.md)
decided the opposite, in terms it called "the load-bearing constraint of the
whole design":

> **The Settings page does not accept uploads.** … no private key is ever sent
> to the API, stored in Postgres, written to an audit row, held in an
> environment variable, or rendered by any `describe()`.

and listed certificate upload under *Alternatives considered — Rejected*:

> **Accept certificate uploads through Settings.** The most obvious reading of
> "change it from app settings", and the friendliest workflow. Rejected on the
> key-material boundary.

So this ADR could not be written as an extension. Either ADR-0013 §2 was to be
superseded deliberately, with the cost stated, or the requirement had to be met
some other way. It was met the other way — see **Decision**.

### What the boundary currently buys

Concretely, today: the API process cannot open the private key. Not "does not",
*cannot* — it is given the public certificate as a single file mount, and the
key lives in a directory it has no path into. A vulnerability in the API — a
path-traversal in some future file handler, an SSRF, a careless `describe()`
that serialises too much — cannot yield the key that authenticates this console
to every operator who uses it.

That property is unusual and worth naming before trading it away. Most consoles
do not have it.

## Options

### A. Upload through the API, API writes the material, proxy reloads

What was asked for. The browser sends certificate + key to the API; the API
validates, writes both to the TLS directory, and asks the proxy to reload.

**Cost:** the API gains write access to key material and a privileged channel to
the proxy's admin endpoint. The property above is gone — every future API
vulnerability is now potentially a key-disclosure vulnerability. The key also
transits the browser, so it appears in whatever the operator's machine keeps
(browser memory, swap, an over-eager password manager, a corporate DLP proxy).

**Mitigations, all of which are real work:** verify the key matches the
certificate before writing; write `0600` and atomically; never log or audit the
key bytes, only the certificate's identity; restrict to `settings:manage`;
**and** roll back automatically if the proxy fails to reload — see below.

### B. A narrow privileged helper beside the proxy

The API does not receive the key. The browser posts to a small sidecar that
shares the proxy's TLS volume and exposes exactly one operation: accept a
validated certificate+key pair, install it, reload, roll back on failure. The
API's role is to authenticate the request and hand off.

**Cost:** another component to build, ship, secure and document, for a
deployment shape that is currently four containers. **Buys:** the API keeps its
"cannot open the key" property.

### C. ACME, and upload only where a key already exists

The bundled Caddy already does ACME. For deployments with a reachable name, the
console never needs a key upload because it never needs a key it did not
generate. For private CAs, keep the mounted-file workflow.

**Cost:** does not answer the request for internal deployments with a private CA
— which is exactly the deployment this came from.

### D. Never move the key at all

The three options above argue about how to carry a private key from a browser to
a disk. The question is worth refusing: **the key does not have to travel.**

1. The console asks for a new keypair. It is generated where it will be used and
   never leaves that volume.
2. The console shows the resulting **CSR** — public material — for the operator
   to take to their CA.
3. The operator pastes back the **signed certificate**. Also public material.
4. It is installed, the listener reloads, the new certificate is proved to be
   served, or the previous one is restored.

At no point does a private key exist in a browser, in the API, on the operator's
laptop, in their clipboard, or in whatever their corporate proxy logs. The
strongest version of the property ADR-0013 protects is not "the key reaches the
API safely" — it is that there is no second copy of the key anywhere.

**This needs no fifth container.** The generate-and-install step is a small
process inside the existing proxy image, and the interface between it and the
API is the filesystem:

| Path | API | Helper | Caddy |
|---|---|---|---|
| `tls/private/` | — | rw | r |
| `tls/inbox/` | w | r | — |
| `tls/outbox/` | r | w | — |
| `tls/live/` | — | rw | r |

The API writes a request and reads a status. It has no mount into
`tls/private/`, no credential for the helper, and no channel to Caddy's admin
API. There is nothing to authenticate between them because there is no RPC —
which is a smaller surface than any design with one.

### Why not B

B was accepted before the renewal frequency was known. At once a year it does
not earn a fifth container: a component that must be built, shipped, patched and
security-reviewed in perpetuity, to be exercised annually.

It is also weaker than D on the thing it was chosen for. In B the key still
exists on the operator's machine and in the browser; B only keeps it out of the
*API*. D keeps it from existing twice at all.

### What D does not do

**It cannot import an existing key and certificate.** A wildcard issued
elsewhere, or a pair handed over by a central PKI team, has a key that by
definition already travelled — and D has no path to accept one.

That case keeps the ADR-0013 mounted-file workflow: put the pair on the host,
restart the proxy. It is the honest answer for it, and it is a documented
one-liner rather than a gap.

If importing turns out to be the common case rather than the exception, this
decision is wrong and B is right. That is the single assumption to check before
building.

## The failure mode that decides the shape

Whatever the transport, one property is non-negotiable: **a bad certificate must
not take the console away.** The operator installing it is using the thing they
are changing. ADR-0013 §4 already says this.

So the apply path must be: validate the pair → stage it → reload the proxy →
prove the new listener answers → keep it, or restore the previous material and
report why. A design that writes the file and reloads hopefully is not
acceptable, because the failure locks out the only person who could fix it.

This is the expensive part of the feature, and it is the same in options A and
B. Anyone estimating this from "it's a file upload" is estimating the wrong
thing.

## Decision

**Option D.** Generate the key where it is used, exchange a CSR, accept only
public material back.

ADR-0013 §2 stands unamended and is, if anything, understated by it. "No private
key is ever sent to the API, stored in Postgres, written to an audit row, held
in an environment variable, or rendered by any `describe()`" remains true — and
so does the stronger statement that no private key is ever sent *anywhere*.

The API's role is to authenticate the request, check `settings:manage`, audit
the certificate's identity — subject, issuer, SANs, fingerprint, validity, never
key bytes — and move two public documents between the operator and a directory.

ACME (option C) remains the right answer wherever the console has a publicly
resolvable name; Caddy already does it and no certificate work reaches this UI at
all. D is for the private-CA deployment, which is the one that prompted this.

## Consequences

**What this costs.** A small process added to the proxy image, and a TLS volume
split into four directories instead of one. Both are permanent maintenance. The
process is privileged in the one way that matters — it can write the material
the console's identity rests on — so it gets the scrutiny that implies, not the
scrutiny its size suggests.

**What it does not change.** Certificates still are not stored in Postgres.
ADR-0013 rejected that and it stays rejected: keys in the database is the outcome
all of this exists to avoid.

**Core, not enterprise.** This is deployment plumbing, not a business
capability. A core deployment that cannot install its own certificate would be
worse than one that never offered the button.

## Open questions

1. **Is importing an existing pair the common case?** D cannot do it. If most
   deployments receive a wildcard from a central PKI team rather than signing a
   CSR of their own, this decision is wrong and B is right. Worth confirming
   before the work starts, not after.
2. What proves "the listener answers" — a TLS handshake from the helper against
   the proxy's own port, checking the served certificate is the one just
   installed? That is the strongest check short of asking the operator's
   browser, and it should be what ships.
3. Where does the CSR's subject and SAN list come from — `CONSOLE_HOSTNAME`, or
   an operator-editable field? Deriving it silently is friendlier and gets it
   wrong for anyone fronting the console under a second name.
