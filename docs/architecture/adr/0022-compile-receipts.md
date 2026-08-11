# ADR-0022 — Compile receipts

- **Status:** Accepted (2026-08-08)
- **Deciders:** Architect
- **Amended:** 2026-08-10 — §7–§12 specify the receiving end.
- **Amended:** 2026-08-11 — §13–§16 specify collection, and correct the premise that a co-located deployment was merely failing to collect receipts: it was never writing them.
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
{ printf '%s %s\n' "$revision" "$certname" >>"$receipts"; } 2>/dev/null || true
```

**Corrected during implementation (#145): the line carries no timestamp.**
This ADR first specified `<iso8601> <revision> <certname>`, which quietly
required a `date` — a fork on the compile path, per compile, forever. Reading
the revision and appending are both shell builtins, so dropping the timestamp
takes the added cost to zero processes on a path whose entire cost today is one
`cat`. Nothing is lost: the revision is what identifies the classification
(§2), and the server stamps arrival when it receives the line. A receipt's
timestamp was never the answer to any question this feature exists to answer.

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

## Amendment — 2026-08-10: the receiving end

Sections 1–6 specify what happens on the Puppet server. They left the origin's
side as implementation detail, and it was not: it contained six decisions, two
of which are load-bearing enough that getting them wrong is unrecoverable
without shipping a new puller to every Puppet server in the estate.

### 7. A receipt is current state, not history

One row per node, overwritten. Growth is bounded by the size of the estate
rather than by the compile rate, so there is no retention sweeper and no
scheduled deletion to get wrong — a thousand nodes are a thousand rows whether
they compile hourly or half-hourly.

This follows §5's own reasoning to its conclusion. If the newest lines carry the
answer and discarding the tail "loses history nobody queries", then storing that
tail at the far end is storing what nobody queries, at roughly 48,000 rows a day
per thousand nodes.

What is given up, explicitly: "when did this node move to revision X", and the
ability to distinguish a node flapping between two revisions from one sitting
still. If either becomes a question worth answering, it is a new decision with a
new cost, not a quiet schema change.

### 8. A receipt belongs to a node AND the server that served it

The key is (peer certname, node certname). A node can compile against more than
one Puppet server — load-balanced masters, or a co-located instance beside a
replicated one — and those servers can hold different revisions.

Keyed on the node alone, such a node's row flaps between revisions on every
sync, and the console reports whichever landed last with no way to explain the
oscillation. The reporting server's identity is already established from its
client certificate (§4), so recording it costs nothing and turns an
unexplainable flap into the actual diagnosis: this server is behind, that one is
not.

### 9. There is no compile time, only a report time

The receipt line is `<revision> <certname>`. §1 deliberately omits a timestamp —
`date` would be a fork per compile — and the puller uploads in batches, so the
only time the origin can know is when the batch arrived.

**The console must say "reported", never "compiled at".** The gap between the
two is up to one sync interval, and a UI that implies otherwise invents
precision the data does not have, in exactly the incident where somebody is
reasoning about ordering.

### 10. An oversized batch is truncated and acknowledged, never refused

The shipped puller treats 2xx as done, 404/405/501 as "this origin has no
receipts surface, discard", and **everything else as retryable — re-uploading
the identical body forever**.

So refusing an oversized batch with 413, which is what HTTP semantics ask for,
permanently wedges that peer: it re-sends the same too-large body every sync,
its receipts never land, and it says so only in a log nobody is reading. Fixing
it would mean shipping a new puller and waiting for every Puppet server to be
upgraded.

The origin therefore applies §5's rule at its own end — keep the newest lines,
drop the oldest, acknowledge — and logs how many it discarded. This is a
deliberate deviation from HTTP semantics, taken because the client is already in
the field and cannot be assumed to change. Any future status code added to this
route must be checked against that list before it is returned.

### 11. Sweeping distinguishes "never known" from "known and gone"

Receipts have no foreign key to ManagedNode, because a receipt for a node the
console cannot see is the most useful fact available about exactly the node
somebody is debugging.

That makes the obvious sweep — delete receipts whose node is unknown — destroy
the evidence the previous sentence exists to preserve, within one reconcile
interval, silently. An unprojected node is unknown on every pass.

Each receipt therefore records whether its node existed at ingest. Only rows
that once matched and no longer do are debris, and only those are swept, in the
reconciler's existing orphan pass. A receipt that never matched is a finding and
is kept.

### 12. "Current" means current with the origin, and the gap is attributed

The comparison is against the origin's current tree revision — that is the
revision an operator created by saving a change, and "did my change reach this
node" is the question being asked.

Comparing instead against the revision the node's own Puppet server holds would
let a node read as perfectly current while the change made an hour ago had
reached nothing. That server's revision is still needed, but as the *attribution*
rather than the verdict:

| Receipt | Peer holds | Reading |
|---|---|---|
| = origin | — | Current |
| = peer, ≠ origin | ≠ origin | The node is fine; the puller is behind |
| ≠ peer | = origin | The server has it; the agent has not run |
| ≠ both | ≠ origin | Both are behind |

One verdict, with a cause. An operator who is told only "behind" has to go
looking for which half is at fault, during the incident.

### Binding constraints added by this amendment

3. **Never return a status this route has not agreed with the puller.** 2xx
   means "consumed, delete them"; 404, 405 and 501 mean "discard, this origin
   has no receipts surface"; everything else means "retry the identical body
   forever". A status chosen for its HTTP correctness rather than against that
   list is a silent, permanent data-loss bug in a component we do not control.
4. **The console may never present a report time as a compile time.**

### 13. Receipts are collected by their own unit, not by the replication puller

The rotate/cap/retry lifecycle lives in `nexuspuppet-sync.sh` because that is
where it was first needed. It is not replication's work. A NexusPuppet
co-located with puppetserver has no puller, and therefore — today — no receipts
at all.

**Not merely uncollected: never written.** The receipts directory is created by
the sync script's `ensure_receipts_dir`, and the ENC script's append is
deliberately swallowed so that a receipt can never fail a compile (§1). With no
puller, nothing creates the directory, every append fails silently, and the
compile is served correctly. Verified on a co-located host: exit 0, correct
YAML, nothing written, no error anywhere.

So the collector owns **both** halves — creating the directory and draining it.
Splitting them would put the prerequisite in a documentation step whose omission
produces exactly the current behaviour, which is invisible.

One unit, both layouts. §6's atomic rename discipline then exists in one place
rather than being got right twice.

### 14. A co-located origin accepts its own receipts on a loopback listener

The receipts route lives on the ENC listener because that is where the mTLS
identity is established (§4), and that reasoning does not weaken when the peer
happens to be the same machine. A co-located deployment therefore binds the
listener to loopback and allowlists its own certname:

```ini
ENC_REPLICATION_ENABLED=true
ENC_REPLICATION_BIND=127.0.0.1
ENC_REPLICATION_ALLOWED_CERTNAMES=<this host's certname>
```

No new code: the bind address is already configurable and the allowlist already
works. No second ingestion path, no second authentication story, and the peer
identity stays *proven* rather than asserted — the collector presents the
certificate the host already holds.

Rejected: a plaintext route on the console API for localhost only. It would make
`peerCertname` something the caller claims rather than something a certificate
established, which is binding constraint 1 with the reasoning removed.

**`ENC_REPLICATION_ENABLED` accordingly means "the ENC listener is running"**,
not "this deployment replicates". What the listener is exposed to is decided by
the bind address and the allowlist, which is where that decision belongs. The
name is now narrower than the meaning; that is a naming debt paid in the
glossary and the deployment guide rather than by a second flag whose four
combinations nobody would exercise.

The bind address is a per-deployment decision, not a constant. A host that also
serves remote pullers must keep binding publicly; only a host that serves
nobody but itself may bind to loopback.

### 15. The migration keeps collecting throughout

`nexuspuppet-sync.sh` is in the field. It retains its receipt handling, skips it
when the collector unit is present, and says once that receipts have moved. Two
drainers never race for the same file, and no operator's collection stops
because they upgraded a script without installing a unit.

The old path is removed a release later, once the collector is the documented
default. A clean break would be one implementation sooner, at the cost of
silently ending collection for anyone who upgraded and read no release note —
and silence is this feature's characteristic failure. It is the wrong thing to
economise on.

### 16. A receipt names a peer; it does not create one

A replication peer is something that fetches the tree. A co-located instance
fetches nothing, so it must not appear in the console's peer list — it would
render as a peer that has never fetched and never will, which is
indistinguishable from a broken puller and is precisely what that view exists to
surface.

`CompileReceipt.peerCertname` therefore references a certname without requiring
an `EncReplicationPeer` row to exist.

This also settles what §12's verdict means co-located. That table uses the
peer's last fetched revision to separate "the puller is behind" from "the agent
has not run". With no puller, the tree is materialized in place and those two
revisions are identical by construction: the node is current, or its agent has
not run. Two states rather than four, because one of the failure modes cannot
occur — a simplification, not a degradation.

### Still open after this amendment

Nothing. The co-located gap that this amendment originally left open is
specified by §13–§16 — and the investigation corrected its premise: receipts
were not accumulating uncollected, they were never being written.
