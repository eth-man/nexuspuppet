# ADR-0022 — Compile receipts

- **Status:** Accepted (2026-08-08)
- **Deciders:** Architect
- **Related:** [ADR-0019](./0019-enc-tree-replication.md) (extends; amends its read-only claim), [ADR-0003](./0003-enc-generate-dont-serve.md), [ADR-0004](./0004-puppetdb-read-only-mtls.md)

## Context

The console can say a classification change was **materialized**, and since
[ADR-0019 §6](./0019-enc-tree-replication.md) it can say a Puppet server
**fetched** the tree. It cannot say which classification a given node actually
**compiled with**.

That gap is the difference between a demo and an incident tool. "Did this node
get my change?" is asked at exactly the moment nobody will accept an inference,
and today the only available answer is arithmetic on two clocks: the tree
changed at T1, the node reported at T2, T2 > T1, therefore probably yes.

The catalog is no help. PuppetDB holds `catalog_uuid`, `transaction_uuid`,
`code_id`, `environment`, `hash` and `producer_timestamp` — and **nothing the
ENC set**. ENC `parameters` become top-scope variables; they are not facts, not
resources, and never reach PuppetDB on their own. Verified against a live
OpenVoxDB rather than assumed.

So every option costs something, and the cheapest sufficient one should win.

## Decision

**Record what was SERVED, at the moment it was served, and carry it back on the
channel that already exists.**

Rejected: assigning every node a NexusPuppet class so the classification id
lands in the catalog. It is genuinely definitive, and it puts our bookkeeping
inside every customer's catalog and requires a module in every environment. For
a product whose entire pitch is staying out of the Puppet runtime, that is the
wrong trade — and it would change every catalog in the estate to answer a
question about a few of them.

### 1. The ENC script writes the receipt, and may never fail a compile

`nexuspuppet-enc.sh` appends one line immediately after deciding what to serve.
Every failure path — read-only filesystem, full disk, missing revision file,
permissions — drops the receipt and lets the compile proceed:

```sh
printf '%s %s %s\n' "$ts" "$revision" "$certname" >> "$receipts" 2>/dev/null || true
```

This is [ADR-0003](./0003-enc-generate-dont-serve.md) applied to the one
script that must never acquire a dependency. A catalog must not fail because
bookkeeping did, and the asymmetry is not close: losing a receipt costs
visibility, losing a catalog costs convergence.

### 2. The version recorded is the tree revision, not a per-node hash

The sync script writes `.revision` into each tree it installs — the ETag it
already holds — and the ENC script reads that.

**This is what makes the result proof rather than inference.** A revision
identifies the tree exactly, so matching a receipt against a classification
version is an *equality check*: this node compiled from revision X, the current
tree is revision Y, X ≠ Y, therefore it is behind. No clocks, no windows, no
assumption about ordering between two hosts whose time may not agree.

It is also the cheap option. Hashing per compile would spawn a process on a
path that today does one `cat`; reading a small, page-cached file does not.

### 3. Receipts travel back on the existing puller's poll

The sync script hands them over on its next run. NexusPuppet never reaches into
the Puppet server — that would need a listener there, and a listener on a
puppetserver is exactly the thing this architecture spends its effort avoiding.

### 4. The replication listener accepts a write, and ADR-0019 is amended

[ADR-0019](./0019-enc-tree-replication.md) says of the endpoint: *"Read-only,
and it must stay so."* This ADR changes that, and does so explicitly rather
than by widening it quietly — a constraint eroded without a record is worse
than one that was never written.

The receipts route lives on the **same listener**, with the same mTLS and the
same certname allowlist. A second listener would mean a second port, a second
TLS configuration and a second thing to firewall, for the same peer presenting
the same certificate. What justifies reusing it is that the identity needed to
attribute a receipt — the certname from the verified client certificate — is
already established there, and is the only identity that could be trusted.

ADR-0019's two binding constraints survive unchanged: nothing here computes
classification on demand, and nothing moves replication onto the read path.

### 5. Growth is bounded, and dropping is stated

One line per compile per node. A thousand nodes at half-hourly runs is roughly
48,000 lines a day.

The **compile path only ever appends** — capping there would mean rewriting a
file that concurrent compiles are writing to. The cap is applied by the sync
script at rotation: it uploads at most the most recent N lines and reports how
many it discarded.

**Oldest is dropped first**, deliberately. What matters is the latest revision
per certname, so the newest lines carry the current state; discarding the tail
loses history nobody queries. Dropping the newest would discard exactly the
answer the feature exists to give.

Receipts are droppable. Catalogs are not, and audit records are not — this is
the one of the three where losing data is the correct trade, and saying so here
stops somebody later "fixing" it into an unbounded queue on a Puppet server.

### 6. The handoff is atomic

Read-upload-truncate loses whatever in-flight compiles append between the read
and the truncate. The file is **renamed**, then the renamed copy is uploaded:
appends continue into a fresh file while the old one is in transit.

A failed upload must neither lose the rotated file nor accumulate rotations
forever. One generation is retained and merged into the next attempt; beyond
that, oldest-first per §5. An outage that lasts a week must not become a
disk-full incident on the Puppet server, which would be a worse failure than
the visibility it was protecting.

### Binding constraints

1. **The receipts route may only accept receipts, and only about the caller.**
   The certname is taken from the verified client certificate, never from the
   body. A puller may report for itself and nothing else. Any other write —
   anything that could change classification — belongs to the console's API,
   behind its authorization, not on a listener whose credential is an estate
   certificate.
2. **Writing a receipt may never fail a compile, and receiving one may never
   fail a fetch.** The ordering is: catalogs, then trees, then bookkeeping. Each
   layer degrades to the one below rather than taking it down.

## Consequences

### Gained

- "Which classification did this node compile with?" becomes an equality check
  on a revision, answerable during an incident without trusting two clocks.
- No Puppet code, no module in any environment, no change to any catalog.
- No new port, no new credential, no new trust relationship.

### Paid

- **It proves what was SERVED, not what was applied.** A compile that failed
  afterwards is already loud in PuppetDB, and correlating the two is possible
  later — but this ADR does not do it, and the console must not imply it does.
- A write surface on a listener that had none, and the standing risk that
  somebody adds a second write to it because the first one is already there.
  Constraint 1 exists to be quoted at that moment.
- Receipts can be lost — on a full disk, in a long outage, past the cap. The
  consequence is a node that looks stale until its next compile, which is at
  most one agent interval away.
- Another file on the Puppet server whose growth an operator has to trust.

## Alternatives considered

**A class in every catalog.** Definitive, and it puts our bookkeeping in every
customer's catalog and requires a module everywhere. Rejected in the Decision.

**Reading it from reports rather than catalogs.** Proves the agent *applied*
it, which is strictly more — and needs the same class in every catalog to
produce the event. Same objection, later in the pipeline.

**A custom fact.** The node has no access to the ENC document; only the Puppet
server does. There is nothing for a fact to read.

**Accepting time-based inference.** Cheapest, and it fails precisely when it is
needed: during an incident, on two hosts whose clocks may disagree, where "the
node reported after the tree changed" is not the same statement as "the node
compiled from the new tree."
