# ADR-0003 — The ENC generates files; it does not serve requests

- **Status:** Accepted
- **Deciders:** Project owner (decision), architect (options)
- **Related:** [ADR-0005](./0005-postgres-prisma-local-state.md), [ADR-0009](./0009-classification-merge-semantics.md)

## Context

NexusPuppet classifies nodes: it decides which Puppet classes and top-scope parameters apply to each certname. Puppet consumes classification through an **External Node Classifier**, configured on `puppetserver` as a node terminus.

The conventional implementation is `node_terminus = exec` pointing at a script that makes an HTTP call to the classifier, or a Puppet HTTP terminus hitting a classifier API directly. Either way, **`puppetserver` calls the classifier synchronously during every catalog compilation, for every node, on every run.**

At the stated scale — ~1,000 nodes at ~2 runs/day, default 30-minute agent intervals — that is a request every few seconds, permanently, on the critical path of configuration management for the entire estate.

If NexusPuppet is the thing being called, then:

- An `api` container restart during a deploy fails catalog compilation for every node running in that window.
- A Postgres failover, a slow query, or a connection-pool exhaustion becomes an estate-wide Puppet outage.
- A bug in a monitoring console — a product whose worst-case failure should be "the dashboard is down" — escalates to "no machine in the fleet can converge."

This inverts the correct risk relationship. The console is a lower-criticality system than `puppetserver`; it must not be able to take `puppetserver` down.

## Decision

**NexusPuppet materializes classification to YAML files on a shared volume. `puppetserver` reads those files from local disk. There is no runtime call from Puppet to NexusPuppet.**

### Mechanism

1. The `api` container mounts `${ENC_OUTPUT_DIR}` read-write. `puppetserver` mounts the same directory **read-only**.

2. On every classification change, `api` writes the domain change and an `EncMaterializationJob` outbox row **in a single Postgres transaction**.

3. `MaterializerWorker` drains the outbox. For each affected certname it evaluates rules against the cached facts projection, merges groups into an `EncDocument`, renders deterministic YAML, and — only if the content hash differs from the recorded one — writes the file.

4. Writes are atomic: render to `<certname>.yaml.tmp` in the same directory, `fsync`, then `rename()`. POSIX guarantees rename atomicity within a filesystem, so `puppetserver` can never observe a partially-written file.

5. `puppetserver` is configured with `node_terminus = exec` and `external_nodes = /usr/local/bin/nexuspuppet-enc.sh`. That script is dependency-free:

   ```sh
   #!/bin/sh
   # No network. No interpreter beyond sh. No NexusPuppet process involved.
   f="${ENC_DIR}/nodes/$1.yaml"
   [ -f "$f" ] && exec cat "$f"
   exec cat "${ENC_DIR}/default.yaml"
   ```

6. `default.yaml` always exists and is written at bootstrap. An unknown or unmaterialized node therefore gets a defined, safe classification rather than a compilation error.

7. `ReconcilerService` performs a periodic full sweep, recomputing every node and repairing any drift between Postgres and disk. This makes the file tree self-healing: it can be deleted entirely and rebuilt.

## Consequences

### Gained

- **NexusPuppet cannot cause a Puppet outage.** Stop the containers, drop the database, deploy a broken image — agents keep converging against the last materialized state. This is the entire point.
- Catalog compilation gets faster: a local `cat` instead of an HTTP round trip.
- The ENC output is inspectable, diffable, and greppable by operators, with no tooling. `git init` in the output directory is a legitimate operational choice.
- Disaster recovery is trivial: the YAML tree is a complete, portable snapshot of classification.
- Materialization can be tested without a Puppet server — assert on file contents.

### Paid

- **Classification is eventually consistent.** A change is durable at commit but not effective until materialized. Expected sub-second; the UI must show materialization state per node and never imply a change is live before `EncMaterialization` confirms it. Showing "saved" while the file is stale would be a correctness bug, not a cosmetic one.
- **A shared filesystem is now a deployment requirement.** Trivial in Docker Compose on one VM; on Kubernetes it means `ReadWriteMany` or co-scheduling `api` with `puppetserver`. Accepted — the alternative is worse.
- **Multiple `api` replicas need coordination.** Solved with a Postgres advisory lock so exactly one materializer is active.
- **Rule evaluation reads cached facts, not live PuppetDB.** Deliberate: reading live facts would reintroduce a PuppetDB dependency into the classification path. Staleness is bounded by the projection interval and surfaced in the UI.
- **Deleting a node group must actively remove or rewrite affected files.** An orphaned YAML file would keep classifying a node forever. Deletion enqueues materialization for every previously-matched certname; the reconciler is the backstop.

### Binding constraint

**No future change may introduce a synchronous request path from `puppetserver` to NexusPuppet.** Adding an HTTP ENC endpoint "for convenience," "for immediate consistency," or "just for testing" violates this ADR. It requires a superseding ADR with the failure analysis redone — not a pull-request comment.

## Alternatives considered

- **Option B — serve HTTP with a disk fallback cache.** A sidecar keeps last-known-good YAML for `puppetserver` to fall back to. Gets instant consistency and keeps the safety net, but requires two code paths that must agree, and the fallback path is exercised only during incidents — which is exactly when untested code is most dangerous. Rejected.
- **Option C — serve HTTP live, accept the coupling.** Simplest code, worst failure mode. Would demand HA Postgres and multiple API replicas from day one to be defensible, which is disproportionate for this deployment. Rejected by the project owner.
- **Write directly into the Puppet control repo as Hiera data / `site.pp`.** Makes Puppet code the source of truth and gives free version history, but couples the console to git write access and r10k deploy cycles, and makes classification changes minutes-slow. Worth revisiting as an *export* feature; rejected as the primary mechanism.
- **PuppetDB-backed classification via `puppetdb` terminus.** Does not support the rule-based grouping model the product needs. Rejected.
