# ADR-0016 — A settings store operators can use, and audit records that leave

- **Status:** Proposed
- **Deciders:** Architect
- **Related:** [ADR-0002](./0002-open-core-runtime-discovery.md), [ADR-0005](./0005-postgres-prisma-local-state.md), [ADR-0006](./0006-auth-local-jwt-modular-sso.md), [ADR-0014](./0014-enterprise-licensing.md), [ADR-0015](./0015-hybrid-authentication.md)

## Context

Every enterprise capability is configured by environment variable, which means every change is an SSH session, a file edit and a restart. That is defensible for a secret at first boot and rigid for everything after it — an operator correcting an LDAP search base should not need shell access to the host.

Three requirements arrive together and share one mechanism:

1. **LDAP configured from the console**, viewable, editable and testable without a restart.
2. **Syslog forwarding of audit records**, configured the same way, alongside the existing webhook transport.
3. **An audit off-switch**, and a Postgres audit table that behaves as a queue rather than an archive.

They share a store, a precedence rule, an encryption key and a settings surface, so they are designed together rather than three times.

[ADR-0015 §4](./0015-hybrid-authentication.md) already settled the precedence question for authentication. This generalises it and answers what was deferred.

## Decision

### 1. One settings table, one row per configuration

`provider_settings`, keyed by a `kind` — `auth.ldap`, `audit.syslog`, `audit.webhook` — holding a JSON payload plus encrypted secret fields.

**Per configuration, never per field.** A deployment reads its LDAP settings entirely from the environment or entirely from the database. Merging the two produces a state no operator can reproduce from either source, and a bug report nobody can act on.

### 2. Environment is the bootstrap baseline; the database wins once written

Unchanged from [ADR-0015 §4](./0015-hybrid-authentication.md), now applied to every kind.

**`SETTINGS_SOURCE=env` forces the environment and ignores stored rows.** Without it a configuration saved through the UI that does not work leaves an operator unable to authenticate *and* unable to override, because the database wins. It requires host access, which the operator running the product has by definition.

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

**UDP cannot confirm delivery, and that changes what a "successful" send means.** The outbox deletes a record once a transport reports success. Over UDP, success means the kernel accepted the datagram — not that the collector received it, and certainly not that it indexed it. Silently deleting security records on that basis is not acceptable in a product that already refuses to start rather than send audit records over plain HTTP off-localhost.

Therefore:

- **TCP is the default. TLS is supported and recommended.**
- **UDP is opt-in**, marked in the UI as *unconfirmable delivery*, in those terms.
- **A UDP transport reports best-effort semantics, and the outbox honours them**: records sent over UDP are **not** purged on send (§6). Best-effort delivery must not imply best-effort retention.

### 6. Postgres is a queue for forwarded records, not an archive

**Confirmed delivery purges the record.** Once a transport confirms — a TCP/TLS syslog write acknowledged, or a webhook returning success — the `audit_logs` row and its delivery job are removed in one transaction.

The reasoning is the operator's: nothing in the console displays audit records today, so retaining them indefinitely is unbounded growth for data nobody reads locally. The external collector is the system of record.

Four things this must not become:

- **Core does not purge.** Core forwards nowhere — `NoopAuditTransport` reports `configured: false` — so there is no confirmation and nothing is deleted. **In the core edition Postgres remains the durable audit trail**, exactly as today. Purging is a consequence of successful forwarding, never of time passing.
- **Unconfirmable sends do not purge.** See §5. UDP retains.
- **A failing transport retains.** The outbox already backs off and retries; records accumulate until delivery succeeds, which is the point of the pattern.
- **What survives user deletion changes meaning.** `AuditLog.actor` is `onDelete: SetNull` and the deletion path copies the email into the record precisely so history stays legible ([#52](https://github.com/eth-man/nexuspuppet/pull/52)). With forwarding enabled that history now lives in the collector. **The claim "the audit trail survives" becomes a claim about the SIEM**, and the documentation must say so rather than leave an operator believing Postgres still holds it.

**TCP confirms transmission, not durable receipt.** The socket accepting bytes does not mean the collector persisted them. This is an accepted, stated limitation of forwarding-as-retention, not something the design can solve — and it is the strongest argument for TLS with a collector that acknowledges at the application layer where one is available.

### 7. Audit recording can be switched off entirely

`audit.enabled`, false disables recording. Not just forwarding — no rows written.

This was chosen deliberately over the narrower "stop forwarding, keep recording", for deployments that do not require an audit trail and do not want the writes or the I/O. **The concern was raised and the trade accepted**; it is recorded here so it is not rediscovered as an accident.

The design makes the state legible rather than silent:

- **Disabling is itself audited.** A final record is written, in the same transaction that flips the setting, before recording stops. An off-switch whose use leaves no trace is the one thing an audit trail exists to catch. Re-enabling is audited on the way back in.
- **The console says so.** A persistent indicator for anyone holding `settings:manage` — not a toast that is dismissed and forgotten.
- **`GET /system/status` reports it**, so a monitoring system can alert on an estate whose auditing was turned off.
- **It is an enterprise setting**, gated on a licensed capability. Core has no switch and always records.

**One implementation hazard, recorded because it is easy to get wrong.** Classification writes place the outbox row and the audit row in a single transaction, and that invariant is load-bearing. Disabling audit must remove the audit write from that transaction without changing when the outbox row is committed. It must not become a conditional that skips the transaction, or a path where a classification change is materialised without its job.

## Consequences

### What this buys

- Operators configure LDAP and syslog from the console, with a test that does not require locking themselves out to discover a typo.
- Audit records reach a SIEM, and Postgres stops growing without bound for data nobody reads locally.
- Deployments that do not need auditing stop paying for it.

### What it costs

- A second source of truth for configuration. §2's precedence rule and its escape hatch exist to bound that, and both need tests.
- Encrypted-at-rest fields and a key to manage, back up and eventually rotate.
- **Retention becomes a property of a system we do not control.** If the collector is misconfigured, records are confirmed and purged into nothing. That is inherent to the choice, and it is why §6 lists what must not purge.

### What it does NOT buy

- **Not multi-destination.** One syslog target, as with one webhook. Fan-out to several collectors is a larger change.
- **Not a local audit viewer.** The absence of one is the premise of §6; building one would reopen the retention question.
- **Not tamper-evidence.** Neither signed records nor a hash chain. Purge-on-delivery makes the collector the system of record, so integrity guarantees belong there.

## Alternatives considered

**Time-based retention instead of purge-on-delivery.** Keep N days locally regardless of forwarding. Simpler, and keeps a local copy — but it retains for deployments that forward everything and would rather not, which is the stated problem.

**Keep configuration in the environment; add a read-only settings view.** No second source of truth, no encryption key, no precedence rule. Rejected: it does not meet the requirement, and a read-only view of a file the operator must edit by hand is a worse experience than no view.

**Forwarding toggle only, no recording off-switch.** Safer, and my initial recommendation. Rejected by the architect for deployments that do not require auditing at all; §7 records the reasoning and the mitigations.

## Open questions

1. **What confirms a webhook delivery?** Any 2xx, or a specific status? A collector answering `202 Accepted` has taken responsibility; one answering `200` may merely have a proxy in front of it. Purging on the wrong signal deletes records that never arrived.

2. **Does purge-on-delivery apply retroactively when forwarding is first enabled?** A deployment that ran for a year in core has a large table. Forwarding it all to a SIEM on the first poll is a surprise; leaving it forever is the bloat this addresses. Probably a bounded backfill with an explicit operator action, but it needs deciding.

3. **Where does `CONFIG_ENCRYPTION_KEY` live in the container deployment?** The convention here is mounted files for key material ([ADR-0013](./0013-console-tls-private-ca.md) §2), which argues for a file rather than an environment variable — but the API needs it before it can read anything.

4. **What happens to queued records when the audit off-switch is thrown?** Undelivered rows exist and describe real events. Draining them before recording stops is the honest answer; discarding them is not, and neither is leaving them queued forever against a transport nobody will reconfigure.

5. **Does a syslog transport need its own rate limiting?** A classification change across a large estate can produce a burst. RFC 5424 over TCP will apply backpressure; a slow collector could then stall the delivery worker and, through it, the queue.
