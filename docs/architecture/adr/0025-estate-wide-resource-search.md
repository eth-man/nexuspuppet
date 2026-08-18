# ADR-0025 — Estate-wide resource search

- **Status:** Accepted
- **Deciders:** Project owner, architect
- **Related:** [ADR-0004](./0004-puppetdb-read-only-mtls.md), [ADR-0005](./0005-postgres-prisma-local-state.md), [ADR-0006](./0006-pluggable-auth-and-authz.md)

## Context

The console can say what a node **should** get. It cannot say what a node **does** get.

Classification answers the first question thoroughly — since #141–#143 an operator can see every class on a node, which group set it, why that group matched, and the exact document the node will be served. All of that describes *intent*.

The catalog is the *result*, and nothing in the console has ever read it. PuppetDB indexes every resource in every node's catalog, with all parameters and the manifest file and line that declared it, and NexusPuppet queries six of its endpoints — `/nodes`, `/facts`, `/factsets`, `/reports`, `/events`, `/environments` — but never `/resources`.

So questions an operator asks constantly have no answer here:

- Is `/etc/ssh/sshd_config` managed on all 190 servers, and with the same mode and owner?
- Which nodes still declare `package{'openssl'}`, and at what version?
- Something set this file to `0644` — which manifest did that?

The first is the one that matters most, and it is not a lookup. It is a **consistency** question: not "what is this resource" but "do all these nodes agree about it". Configuration management exists to make an estate uniform; the console has had no way to show whether it succeeded.

## Decision

**A read-only, estate-wide search over PuppetDB's `/resources` endpoint, presented consistency-first, behind its own privileged permission.**

### 1. Read-only, and no write surface may be added

This adds a seventh read endpoint to the PuppetDB client and nothing else. [ADR-0004](./0004-puppetdb-read-only-mtls.md) stands unchanged and unqualified: there is no command surface, and none may be added here either. Queries are built by `PqlBuilder` from a typed, Zod-validated filter. No user input is interpolated into PQL.

The estate-wide mTLS certificate makes the API a confused deputy by construction, exactly as it already was. Authorization happens in `api`, before the query — which is why §3 exists.

### 2. Live, never projected

Results are queried from PuppetDB on every request and never copied into Postgres.

[ADR-0005](./0005-postgres-prisma-local-state.md)'s scope boundary already lists catalogs as *not in Postgres*, and this is that rule applied. The numbers make it obvious: a thousand nodes at several hundred resources each is millions of rows, arriving with a sync problem and a staleness question attached, to duplicate an index PuppetDB already maintains.

The precedent is the node list, which is served live from PuppetDB rather than from `ManagedNode`. The cost is accepted rather than mitigated: when PuppetDB is unreachable this screen shows the explicit unreachable state with last contact time — not an empty table, not a spinner, not a 500.

### 3. `resources:read` is a new permission, and it is privileged

It does **not** share `inventory:read`.

Facts describe a machine: its OS, its addresses, its hardware. Resource parameters are the machine's *configuration payload* — the `content` parameter of a `File` is the entire file body, and a class parameter may hold a credential that was never meant to be read back. Treating those as one permission would mean anyone who can see an IP address can read `/etc/shadow`'s managed content.

`resources:read` is intended for senior operators and auditors. It is not a default grant, and §5 explains why the split is necessary but not sufficient.

### 4. Parameters are never in list results

The list query uses PQL `extract` to select `certname`, `type`, `title`, `file`, `line`, `environment`, `resource` and `exported` — and deliberately omits `parameters`.

Two reasons, and the second is the important one:

- **Size.** A single `File` resource carrying a large `content` is unbounded; a page of them is a browser tab that stops responding. Measured against a live estate, dropping `parameters` from a trivial one-resource query already halves the payload.
- **Disclosure.** A value that is never fetched cannot be leaked by a rendering bug, a log line, an error page, or a screenshot over somebody's shoulder. Parameters cross the wire only when an operator explicitly expands one resource, which is a deliberate act that §6 records.

### 5. Parameter filtering is an oracle, and pretending otherwise would be worse

PuppetDB supports filtering on parameter values directly — `["=", "parameters.mode", "0666"]`. This is exposed, because "find every node where `sshd_config` permits root login" is precisely the question this feature exists to answer, and it requires no parameter to be displayed.

It must be stated plainly that **this grants effective read of parameter values.** A holder of `resources:read` can test `parameters.password = "guess"` repeatedly and confirm a secret without it ever being rendered. Redaction on the display path does not close this and never could.

A safe-list of "non-sensitive" parameter names was considered and rejected. The set of sensitive parameter names across arbitrary Forge and site modules cannot be enumerated, so such a list would be incomplete by construction — and its real harm is that it would invite the belief that the oracle was closed.

The honest position is the one taken here: the oracle is inherent to parameter filtering, it is the reason `resources:read` is a separate and privileged grant, and it is the reason §6 exists.

### 6. Read-only audit events — amending ADR-0005 §2

[ADR-0005](./0005-postgres-prisma-local-state.md) §2 requires every classification write to be one transaction containing the domain change, the `AuditLog` row and the outbox upsert. That rule is about writes and remains binding for them.

This ADR introduces a second, narrower category: an `AuditLog` row for a **read** that discloses configuration payloads.

- **Recorded:** expanding a resource's parameters, and any query that filters on a parameter value.
- **Not recorded:** ordinary browsing — searching by type and title, and viewing the list. That discloses no values, and recording it would bury the events that matter under the ones that do not.

A read event has no domain change and no outbox job, so it does not and cannot take ADR-0005 §2's shape; `before` and `after` are both null. It is written outside a transaction because there is no transaction for it to join.

This exists because §5 makes `resources:read` a grant that can read secrets. A powerful read permission with no trail is a policy with no evidence behind it — "senior operators and auditors only" is unenforceable and unprovable unless somebody can afterwards ask *who looked at what, and when*.

### 7. Consistency is computed from the resource hash, not from parameters

PuppetDB's `resource` field is a SHA-1 of the resource's type, title **and parameters**. Two nodes whose hashes match have byte-identical parameters.

This is what makes §4 and the consistency view compatible rather than opposed. Variance across hundreds of nodes is established by grouping the slim projection by `(type, title)` and counting distinct hashes — without a single parameter crossing the wire.

Results lead with variance, and the odd ones out sort to the top:

```
File[/etc/ssh/sshd_config]      190 nodes    2 variants  ⚠
File[/etc/resolv.conf]          190 nodes    1 variant   ✓
```

A flat row-per-node list was rejected as the default view: 190 identical rows actively hide the three that differ, which is the opposite of what the operator opened the screen to find.

### 8. Variance is counted within an environment, never across

Resources carry an `environment`. A node in `development` and a node in `production` legitimately differ, and counting that as variance would flag the entire estate as inconsistent on the first day it was switched on.

That failure mode is already understood in this codebase. [ADR-0021](./0021-operational-notifications.md)'s lifecycle rules exist because *alert fatigue is not a usability complaint; it is the failure mode that makes an alerting system worse than none, because the channel gets muted and takes the alert that mattered with it.* A consistency screen that cries wolf about environments earns the same fate.

Two nodes in **different** environments differing is not drift. Two nodes in the **same** environment differing is exactly what this feature is hunting.

### 9. Expansion fetches one representative per variant, not one per node

Expanding a resource fetches parameters for a single representative node **per distinct hash**, and shows the variants side by side with differing keys highlighted.

Bounded by variant count — typically one to three — rather than by node count. One query rather than N. And it answers the question actually being asked, *how do these differ*, instead of handing the operator two blobs to diff by eye.

### 10. No unbounded query reaches PuppetDB

Two guards, both required:

- **A `type` floor.** A search with no `type` is refused. This mirrors the existing rule in `listFacts`, where an empty allow-list fetches nothing rather than everything.
- **Count before fetch.** `["extract", [["function", "count"]], …]` is issued first. Above the render threshold the operator is told *"2.1M resources match — narrow the search"*, rather than the browser being handed a result set it cannot draw.

The failure mode being designed out is an operator accidentally asking a production PuppetDB for every resource in the estate, and neither of them surviving it.

## Consequences

**Classification becomes verifiable.** The console can already state intent and can now show the result, which is the gap that made "the node has this class" an assertion nobody could check.

**A new permission must be granted deliberately.** `resources:read` is not implied by any existing role. Existing deployments get nobody holding it until an operator says so — which is correct, and does mean the feature is invisible until then.

**The audit trail gains rows that describe reads.** Anything consuming `AuditLog` — including SIEM forwarding — will see actions with null `before` and `after`. That is a wire-contract-visible change, and consumers that assume every row is a change will need to tolerate it.

**PuppetDB carries the query load.** Estate-wide grouping is real work for it, and §10's guards are the only thing standing between this screen and a bad afternoon. They are load-bearing, not defensive decoration.

**We are relying on the resource hash covering parameters.** This is documented behaviour of the `/resources` endpoint. If it ever ceased to be true, the consistency view would silently report agreement that does not exist — which is the most dangerous way this feature could fail, and therefore belongs in a test that asserts it against a real response rather than a fixture.

**Deliberately out of scope for the first release:** saved resource queries, CSV export, a per-node catalog browser, and any handling of exported resources beyond surfacing the `exported` flag. Each is additive later without rework.
