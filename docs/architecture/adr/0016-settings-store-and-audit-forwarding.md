# ADR-0016 — A settings store operators can use, and an audit table that stays bounded

- **Status:** Proposed
- **Deciders:** Architect
- **Related:** [ADR-0002](./0002-open-core-runtime-discovery.md), [ADR-0005](./0005-postgres-prisma-local-state.md), [ADR-0006](./0006-auth-local-jwt-modular-sso.md), [ADR-0014](./0014-enterprise-licensing.md), [ADR-0015](./0015-hybrid-authentication.md)

## Context

Every enterprise capability is configured by environment variable, which means every change is an SSH session, a file edit and a restart. That is defensible for a secret at first boot and rigid for everything after it — an operator correcting an LDAP search base should not need shell access to the host.

Three requirements arrive together and share one mechanism:

1. **LDAP configured from the console**, viewable, editable and testable without a restart.
2. **Syslog forwarding of audit records**, configured the same way, alongside the existing webhook transport.
3. **A bound on the audit table**, so a long-lived deployment cannot fill its disk.

They share a store, a precedence rule, an encryption key and a settings surface, so they are designed together rather than three times.

[ADR-0015 §4](./0015-hybrid-authentication.md) already settled the precedence question for authentication. This generalises it and answers what was deferred.

## Decision

### 1. One settings table, one row per configuration

`provider_settings`, keyed by a `kind` — `auth.ldap`, `audit.syslog`, `audit.webhook` — holding a JSON payload plus encrypted secret fields.

**Per configuration, never per field.** A deployment reads its LDAP settings entirely from the environment or entirely from the database. Merging the two produces a state no operator can reproduce from either source, and a bug report nobody can act on.

### 2. Environment is the bootstrap baseline; the database wins once written

Unchanged from [ADR-0015 §4](./0015-hybrid-authentication.md), now applied to every kind.

**`SETTINGS_SOURCE=env` forces the environment and ignores stored rows.** Without it a configuration saved through the UI that does not work leaves an operator unable to authenticate *and* unable to override, because the database wins. It requires host access, which the operator running the product has by definition.

**Core reads the baseline from the provider, not from the environment.** For `auth.ldap` the variables are parsed by the enterprise layer, which core may not import ([ADR-0002](./0002-open-core-runtime-discovery.md)). So `IAuthProvider.currentConfiguration()` reports what the running provider was built from, and core uses that as the baseline. The alternative — teaching core to parse `LDAP_*` itself — puts the same variables in two parsers and guarantees they disagree eventually.

The report is validated against the settings schema and discarded if it fails, and core strips known secret fields regardless of what the provider returns; the settings view is rendered in a browser. A provider that does not implement the method, which is every provider written before it existed, simply has no baseline and opens an empty form.

### 3. `CONFIG_ENCRYPTION_KEY`, distinct from `JWT_SECRET`

One key, one purpose. Rotating a signing secret must not decide whether stored credentials remain readable, and a key compromised in one role must not surrender the other.

It encrypts the LDAP bind password, the webhook token, and any syslog TLS client key. Those fields are **write-only across the API**: a read returns whether a secret is set, never its value, and the UI renders an empty field with a "replace" affordance rather than a masked round-trip that leaks length.

The API refuses to start with stored secrets it cannot decrypt, rather than silently falling back to the environment — a deployment that believes it is talking to a directory must not quietly talk to a different one.

### 4. Reconfiguration is live; **registration** still needs a restart

The distinction that makes this feasible:

- **What a provider points at** — URL, search base, credentials, role mappings — is read through the settings store and can change while the process runs.
- **Which providers exist at all** is fixed at boot, because capability registration builds the DI graph ([ADR-0002](./0002-open-core-runtime-discovery.md)).

So editing LDAP settings takes effect on the next login. **Turning LDAP on for the first time still requires a restart**, because there was no provider to reconfigure. The UI must say so plainly rather than appear to have succeeded.

A **Test** action validates a candidate configuration without saving it: bind, search for one user, report what came back. Configuring a directory by trial and error against the login screen is how people lock themselves out.

### 5. Syslog: TCP by default, TLS supported, UDP opt-in and loud

RFC 5424. `audit.syslog` joins `audit.webhook` as a transport under the existing `IAuditTransport` contract, whose documentation already anticipated it.

**UDP cannot confirm delivery, and the outbox is built on confirmation.** A delivery job is cleared when a transport reports success; over UDP, success means the kernel accepted a datagram — not that the collector received it, and certainly not that it indexed it. A product that already refuses to start rather than send audit records over plain HTTP off-localhost should not quietly call that delivered.

Therefore:

- **TCP is the default. TLS is supported and recommended.**
- **UDP is opt-in**, marked in the UI as *unconfirmable delivery*, in those terms.
- **A UDP send clears its job but is recorded as unconfirmed**, so `GET /system/status` can report that this deployment cannot prove its audit records arrived. The retention sweeper is unaffected: records age out on the same schedule either way, because retention is about disk and not about delivery.

### 6. Bounded by a retention policy, not by purge-on-delivery

**`AUDIT_RETENTION_DAYS`, default 90, plus `AUDIT_RETENTION_MAX_ROWS` as a ceiling.** A sweeper deletes what falls outside either bound.

The problem being solved is unbounded growth on a host that has to keep running — not the existence of local records. An earlier draft of this ADR purged each record the moment a transport confirmed it. That bounds growth too, and costs more than it needs to:

- The collector silently becomes the **only** system of record. A misconfigured SIEM that accepts and discards leaves nothing anywhere.
- There is nothing left to build a local audit view on, so the absence of one becomes permanent by construction.
- Core, which forwards nowhere, would be bounded by nothing at all — and a core deployment fills a disk exactly as readily as an enterprise one.

Retention bounds growth in every edition, keeps the trail, and leaves forwarding to do the job forwarding is for. **The schema already assumed this**: `AuditDeliveryJob` cascades from `AuditLog` and says so — *"if audit retention removes the record, an undelivered job for it is meaningless. Forwarding is best-effort against a retention window."*

**Retention is core, not enterprise.** Unbounded growth is not a licensed problem.

#### Two bounds, because one is not enough

Age alone does not bound a burst. A classification change across a large estate writes a great many records in a moment, all comfortably inside a 90-day window. `AUDIT_RETENTION_MAX_ROWS` is the backstop that keeps a single afternoon from filling a disk; age is what keeps the table from creeping.

#### Deleting must not become the bloat it prevents

In PostgreSQL a `DELETE` does not reclaim space — it writes dead tuples that autovacuum reclaims later. One enormous delete produces exactly the bloat and I/O spike this section exists to avoid, and can hold a transaction open long enough to block vacuum across the database.

So the sweeper:

- **Deletes in bounded batches** with a ceiling per pass, and stops rather than catching up in one go.
- **Uses `@@index([createdAt])`**, which already exists, so a sweep is a range scan rather than a sequential one.
- **Runs on a schedule with jitter**, not on every write.
- **Never runs inside a request.**

Time-based partitioning with `DROP PARTITION` reclaims space without vacuum churn and is the answer at a scale this product has not yet been measured at ([ROADMAP](../../../ROADMAP.md) records that estate-scale validation is outstanding). It is a schema change with migration consequences; batched deletes first, partitioning when there is a measurement that justifies it.

#### An undelivered record is not deleted by age

This is the interaction that matters. A record still queued for a collector must not be swept away because it aged out while the collector was down — that turns an outage into silent data loss, which is the failure the outbox exists to prevent.

- **Age-based sweeping skips rows with a pending delivery job**, however old.
- **The row ceiling does not skip them**, because something has to bound the case where a collector is down for a month. It deletes oldest-first and **logs how many undelivered records it dropped**, and `GET /system/status` surfaces the count.

A pending queue growing past its ceiling is an operational alarm, not a silent condition.

## Consequences

### What this buys

- Operators configure LDAP and syslog from the console, with a test that does not require locking themselves out to discover a typo.
- Audit records reach a SIEM, and the local trail stays intact for security review and for a future audit view.
- **The database is bounded in every edition**, by age and by row count, without anybody having to turn security off to achieve it.

### What it costs

- A second source of truth for configuration. §2's precedence rule and its escape hatch exist to bound that, and both need tests.
- Encrypted-at-rest fields, and a key to manage, back up and eventually rotate.
- A sweeper is a background job that deletes data. It needs to be conservative, batched, observable, and covered by tests that assert what it does **not** delete.

### What it does NOT buy

- **Not multi-destination.** One syslog target, as with one webhook.
- **Not a local audit viewer.** The records are kept and indexed, so one can be built; this ADR does not build it.
- **Not tamper-evidence.** Neither signed records nor a hash chain. A retained local trail plus a forwarded copy is two places to compare, which is weaker than integrity proof and better than one.
- **Not unbounded history.** Anything older than the window is gone. A deployment with a statutory retention requirement must forward to something that keeps it.

## Alternatives considered

**Purge each record once a transport confirms it.** Drafted, and dropped. It bounds growth only where forwarding is configured — so core, which forwards nowhere, stays unbounded — and it makes the collector the sole system of record, leaving nothing behind if that collector accepts and discards. It also forecloses a local audit view by construction.

**A complete off-switch for audit recording.** Drafted, and dropped once the underlying motivation turned out to be disk growth rather than a wish to stop auditing. Retention solves that without building a control whose entire purpose is to stop recording who did what — and, unlike an off-switch, it keeps working when nobody remembers to set it.

**Time-based partitioning from the start.** `DROP PARTITION` reclaims space without vacuum churn and is the better mechanism at scale. Deferred rather than rejected: it is a schema change with migration consequences, and this product has no estate-scale measurement yet to size it against.

**Keep configuration in the environment; add a read-only settings view.** No second source of truth, no encryption key, no precedence rule. Rejected: it does not meet the requirement, and a read-only view of a file the operator must still edit by hand is worse than no view.

## Open questions

1. **What confirms a webhook delivery?** Any 2xx, or a specific status? A collector answering `202 Accepted` has taken responsibility; one answering `200` may be a proxy in front of it. Less destructive than it was — a wrong answer now clears a delivery job rather than deleting the record — but it still decides whether a record is silently never retried.

2. **What are the right defaults?** 90 days and a row ceiling of what? The ceiling has to be chosen against a realistic burst: a classification change across a large estate writes one record per affected group operation, not per node, but that has not been measured. A default that trips on a normal Tuesday is worse than no ceiling.

3. **Where does `CONFIG_ENCRYPTION_KEY` live in the container deployment?** The convention here is mounted files for key material ([ADR-0013](./0013-console-tls-private-ca.md) §2), which argues for a file — but the API needs it before it can read anything.

4. **Should the sweeper refuse to run when forwarding is configured but has never succeeded?** Deleting on schedule while every delivery fails is technically correct and probably not what the operator wants on day one of a broken SIEM integration. An alarm plus a grace period may be better than a rule.

5. **Does a syslog transport need its own rate limiting?** RFC 5424 over TCP applies backpressure; a slow collector could stall the delivery worker and, through it, the queue.
