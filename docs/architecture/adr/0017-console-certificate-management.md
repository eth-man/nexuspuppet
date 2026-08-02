# ADR-0017 — Installing a console certificate from the console

- **Status:** Proposed — needs a decision on the key boundary before any code
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

So this ADR cannot be written as an extension. Either ADR-0013 §2 is superseded
deliberately, with the cost stated, or the requirement is met some other way.
**That decision is not mine to make, which is why this is Proposed and not
Accepted.**

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

## Recommendation

**B, if this is worth building properly; C plus better documentation, if it is
not.**

A is the cheapest to write and the one I would most regret. It trades a rare and
genuinely useful security property for a convenience, and it does so
invisibly — nothing in the UI would tell an operator that the console's key is
now reachable from the web tier.

## Open questions

1. Is a console certificate installed often enough to justify B? On a private CA
   with a 5-year certificate — as on the current test estate, expiring 2031 —
   the answer may be no, and the honest fix is a better documented one-line
   host command.
2. Does the certificate need to be in Postgres for multi-replica deployments?
   ADR-0013 rejected this. It stays rejected: keys in the database is the
   outcome all of this exists to avoid.
3. Should this be enterprise-only? It is deployment plumbing rather than a
   business capability, which argues for core.
