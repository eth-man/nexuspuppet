# ADR-0021 — Operational notifications

- **Status:** Accepted (2026-08-07)
- **Deciders:** Architect
- **Related:** [ADR-0016](./0016-settings-store-and-audit-forwarding.md) (audit forwarding — the boundary this ADR must not cross), [ADR-0002](./0002-open-core-runtime-discovery.md), [ADR-0019](./0019-enc-tree-replication.md)

## Context

The product detects several conditions that mean it is not doing its job, and
tells nobody. `SystemStatusService` computes them — stranded materialization
jobs, a replication peer that has never fetched, PuppetDB unreachable, a
projection prune refused — but only when the console asks. Nothing is
evaluated on a schedule, so every one of these is visible exactly when somebody
happens to look, and invisible at 3am.

The worst of them are silent by construction. A stopped sync timer on the
Puppet server leaves the console reporting a change as materialized — true, and
useless, because it never left the building. That is precisely the failure
[ADR-0019 §6](./0019-enc-tree-replication.md) added a status surface for, and a
status surface only helps somebody already looking at it.

Notifications belong in the **core** edition. An open-core product whose
open half cannot tell you it is broken is not a usable product; it is a demo.

## Decision

**Operational conditions, evaluated on a schedule, delivered to one global
destination per channel.**

### 1. Operational alerts only — never audit records

A notification is about the **deployment's health**. It is never about *who did
what*.

This is the whole reason notifications can live in core while audit forwarding
requires `audit.export`. Without the line, the first reasonable feature request
— "notify me when a group changes" — turns notifications into audit forwarding
that skipped the capability, and the open-core boundary stops looking principled
and starts looking arbitrary. Arbitrary is worse: an operator can work with a
line they disagree with, but not with one they cannot predict.

The test a reader can apply without asking us: **does the message name a
person or an action they took?** If yes, it is the audit trail, and it goes
through the audit transports.

### 2. Conditions, not events

A notification has a lifecycle. It **opens**, it persists while true, and it
**resolves**.

Every signal the product has is a *state* — `materialization.failed = 3`,
`peer.behind = true` — not an occurrence. An evaluator that fired an event per
tick would send the same alert every few minutes until somebody fixed it, and
the reliable consequence of that is a muted channel. Alert fatigue is not a
usability complaint; it is the failure mode that makes an alerting system worse
than none, because it silences the one alert that mattered along with the rest.

**Three consecutive failing evaluations to open. One passing evaluation to
resolve.** Slow to alarm, quick to clear, deliberately asymmetric: a transient
network blip or a slow database must not page anybody, and an operator who has
just fixed something should be told immediately rather than left wondering.

### 3. Discrete signals are self-resolving conditions

A few signals happen once and never "recover" — *retention dropped 12
undelivered audit records*. They are modelled as conditions that resolve as
soon as they have been observed, rather than as a second mechanism.

One mechanism with a slightly odd case beats two mechanisms with a clean case
each. The second would need its own storage, its own delivery, and its own
deduplication, and would exist for three of the seven conditions.

### 4. Three channels, all core

- **Console panel** — the open conditions, always available, no configuration.
- **Webhook** — one POST on open and on resolve. Reaches Slack, PagerDuty,
  Alertmanager, or anything that accepts a POST, and works in an air-gapped
  estate because the target is internal.
- **SMTP** — plain-text mail through a standard relay.

The console alone was considered and rejected: being told when you are **not
looking** is the entire value, and a panel you must visit is a nicer status
page. We already have a status page.

SMTP was nearly cut for being a large surface — queuing, bounces, templates —
and kept because it is a genuine must-have in traditional estates where
standing up a webhook consumer is real friction. Kept deliberately basic: plain
text, standard relay auth, no templating engine. `nodemailer` has zero
dependencies and needs no build toolchain, which is the same constraint that
put scrypt in [ADR-0006](./0006-auth-local-jwt-modular-sso.md).

### 5. One global destination per channel

One webhook URL, one recipient list. Not per user.

Estates already solve routing, with distribution lists, on-call rotations and
alert routers that are better at it than we will be and are already trusted at
3am. Sending to one address the estate routes is more reliable than
reimplementing that.

Per-user subscriptions were rejected for the **bystander effect**: everybody
assumes somebody else is subscribed, and the one person who was muted it in
March. Nobody discovers this until the outage. The console panel is where
personal preference belongs, because ignoring a panel harms only the person
ignoring it.

Severity-based routing — critical to mail, warnings to the console — is the
natural next step and is deliberately **not** built now. With seven conditions
it is configuration surface without a payoff, and it is far easier to add later
than per-user subscriptions would be to remove once people depend on them.

### 6. The catalogue, and what stays out of it

| Condition | Detects |
|---|---|
| Classification is not reaching disk | Stranded materialization jobs, which are not retried |
| A Puppet server is behind, or has never fetched | A dead sync timer — silent everywhere else |
| PuppetDB unreachable | Inventory going stale; rules evaluating against stale facts |
| Projection refused to prune | The implausibly-small-response guard fired |
| Audit delivery failing | Records queueing. Present only where `audit.export` is |
| Audit records dropped undelivered | Retention destroying evidence. Self-resolving |
| Console certificate expiring | The classic outage nobody saw coming |

**Excluded, and this is the load-bearing half:**

- **Per-node run failures.** The tempting one, and wrong. PuppetDB already
  knows, the estate already monitors it, and a configuration console alerting
  on agent runs is reimplementing monitoring badly — while generating the
  highest-volume, lowest-signal traffic in the system. One flapping node would
  poison the channel for every condition above it.
- **Login failures and lockouts.** Security-relevant, and the audit trail's
  job. Routing them here would also skate along the §1 boundary.
- **Anything already in `AuditLog`.** Where §1 gets tested in practice.

### 7. Delivery reuses the outbox shape

The condition change and its delivery job are written in **one transaction**,
and a worker delivers in batches — the same shape
[ADR-0016](./0016-settings-store-and-audit-forwarding.md) uses for audit
delivery. A collector outage queues rather than loses.

A second delivery mechanism alongside the first would be the mistake: two
retry policies, two backlogs, two things to reason about during the incident
that produced both.

### Binding constraints

1. **A notification must never carry audit content.** Not a person, not an
   action, not a record from `AuditLog`. The moment one does, this feature is
   `audit.export` without the capability.
2. **Notification delivery must never block or fail the work that produced the
   condition.** Materialization, replication and projection continue whether or
   not anybody can be told about them — the same ordering ADR-0019 applies to
   replication bookkeeping.

## Consequences

### Gained

- The product can say it is broken without being watched.
- A dead sync timer becomes visible, which was the one failure ADR-0019's
  status surface could describe but not announce.
- One delivery mechanism, already proven here.

### Paid

- An evaluator on a timer, and condition state to store.
- **The open-threshold is coupled to a number configured on another host.**
  Three evaluations at five minutes is a fifteen-minute floor, comfortably
  longer than a five-minute sync timer plus its jitter. An operator who sets
  that timer to hourly gets a permanent alert, and NexusPuppet cannot see the
  puller's interval to warn them. This must be documented where the timer is
  configured, not only here.
- "Only page me for materialization failures" is not possible, and will be
  asked for. The honest answer is that their alert router does that — true, and
  irritating to somebody who does not run one.
- SMTP is a surface we now own: a relay that starts refusing mail becomes our
  support burden, whatever the cause.

## Alternatives considered

**Events instead of conditions.** Trivial to build and produces a channel
people mute. Rejected in §2.

**Per-user subscriptions.** What people ask for; the bystander effect is why
not. Rejected in §5.

**Console-only.** No egress, no configuration, nothing to break — and it does
not deliver the point of the feature. Rejected in §4.

**Reusing the audit transports.** They already speak syslog and webhook, so
carrying alerts over them looks like reuse. Rejected: those transports exist
under `audit.export`, and routing core notifications through an
enterprise-gated component either breaks core or perforates the capability.
Separate paths keep §1 enforceable at the transport rather than by convention.
