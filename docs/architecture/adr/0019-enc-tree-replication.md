# ADR-0019 — Replicating the ENC tree to puppetserver

- **Status:** Accepted (2026-08-05)
- **Deciders:** Architect
- **Related:** [ADR-0003](./0003-enc-generate-dont-serve.md) (extends; does not supersede), [ADR-0002](./0002-open-core-runtime-discovery.md), [ADR-0004](./0004-puppetdb-read-only-mtls.md)

## Context

[ADR-0003](./0003-enc-generate-dont-serve.md) settled how classification reaches `puppetserver`: NexusPuppet writes YAML files, and a dependency-free `exec` script reads them. It did not settle **how those files reach a `puppetserver` on a different host**, because at the time nothing had been deployed.

`DEPLOYMENT.md` §6 offers NFS or `rsync` as site choices and calls this "the one architectural decision the deployment cannot defer". The first real deployment shows why leaving it to the site is not enough:

- NexusPuppet runs in Docker on one VM; `puppetserver` runs on another.
- The ENC tree lives in a Docker named volume under `/var/lib/docker`, mode `0710 root:root`. The `puppet` user cannot traverse that path even on the same host — and it is on the wrong host regardless.

So classification is computed correctly, written correctly, and **nothing can read it**. The feature is deployed and inert.

Both documented options cost something real. NFS puts another host's availability into catalog compilation — if the NexusPuppet host goes down, the mount hangs and every compile blocks, which is the precise failure ADR-0003 exists to prevent. `rsync` on a timer preserves the guarantee but pushes DIY plumbing onto every operator, and `--delay-updates` is a footgun for whoever omits it: files are written atomically, but a sync interrupted mid-run can still deliver a partial *set*.

## Decision

**The ENC tree is replicated out-of-band, pulled by the Puppet server.** NexusPuppet serves a read-only replication endpoint; a short-lived POSIX `sh` script on a `systemd` timer fetches the tree and swaps it into place atomically.

### 1. This is not the endpoint ADR-0003 forbids

ADR-0003's binding constraint is worth quoting, because this decision adds an HTTP endpoint that serves classification and a reader will otherwise conclude it was ignored:

> No future change may introduce a **synchronous request path** from `puppetserver` to NexusPuppet. Adding an HTTP ENC endpoint "for convenience," "for immediate consistency," or "just for testing" violates this ADR.

[ADR-0000](./0000-record-architecture-decisions.md) names the same thing as the canonical failure this project's ADRs exist to prevent — *"someone adding 'just a small HTTP ENC endpoint'"*. So the distinction has to be stated precisely rather than asserted:

- **The compile path is unchanged.** `node_terminus = exec` runs a POSIX `sh` script that reads a local file. No process, no network, no interpreter beyond `/bin/sh`.
- **The fetch is not in that path.** It runs on a timer, on its own schedule, whether or not any agent is compiling anything.
- **The property survives.** Stop, break or delete NexusPuppet and the last synced tree is still on disk; catalogs still compile.

The test that distinguishes them, and the one any future change must pass: **can catalog compilation fail because NexusPuppet is unavailable?** Under ADR-0003 the answer is no. Under this ADR it is still no. Under an ENC endpoint — or under NFS — it becomes yes.

### 2. Pull, not push

The sidecar polls. It does not hold a connection waiting to be told.

A push is only correct once it also answers what happens to an event fired while the client was disconnected: sequence numbers, reconnect reconciliation, staleness detection. That is cache invalidation, and its failure mode is silent — a node keeps an old classification with nothing to reveal it. A poll is self-correcting by construction: every tick reconciles against the source, which [ADR-0003 §7](./0003-enc-generate-dont-serve.md) already guarantees is authoritative and self-healing.

Push would also optimise an invisible gap. Agents check in on their own interval — half an hour by default — so seconds of replication delay are dominated by the schedule of the thing consuming it.

### 3. A timer, not a daemon

Nothing long-lived runs. A `systemd` timer starts a short script, which exits.

This is the same reasoning as §1 applied to the local host. A daemon answering queries — over a Unix socket or anything else — would put a **live process on a read path that currently has none**: compilation would then fail if it were dead, hung, OOM-killed or mid-upgrade. Files on disk have no liveness requirement. Keeping the moving part on the **write** side means its failure mode is *stale*; moving it to the read side would make its failure mode *outage*.

It also adds no runtime to `puppetserver`. `sh`, `curl` and `tar` are already present on a host that is often tightly controlled and is otherwise a JVM appliance.

### 4. Whole-tree atomicity, by symlink swap

ADR-0003 §4 guarantees per-file atomicity via `tmp` + `fsync` + `rename`. Replication needs more than that: a consumer must never observe a partially-applied **set**, where some nodes have new classification and others still have old.

The script extracts to a staging directory and swaps a symlink. That is atomic for the whole tree, and strictly stronger than `rsync --delay-updates`, which reduces the window rather than closing it.

### 5. mTLS via the Puppet CA, allowlisted by certname

The tree contains the whole estate's classification. It must not be readable by anything holding an agent certificate.

`puppetserver` already holds a certificate signed by the Puppet CA, and NexusPuppet already holds that CA's certificate in order to verify PuppetDB ([ADR-0004](./0004-puppetdb-read-only-mtls.md)). The trust relationship therefore already exists: **no new secret is created, distributed, rotated or leaked**, and revocation runs through the CA the estate already operates.

Access is restricted to named certnames, mirroring the certificate allowlist PuppetDB itself enforces — a model the operator already runs and already understands.

### 6. The server records each fetch, and the console shows it

NexusPuppet serves the endpoint, so it observes every successful pull at no cost. That record is surfaced in the console.

Without it, this design has one silent failure: a stopped timer means the console reports a change as materialized — true, and useless, because it has not left the building. Every machine keeps its old classification and nothing says so. **Materialized is not the end of the sentence; replicated is.**

### Amended by ADR-0022

This ADR described the replication endpoint as read-only. [ADR-0022](./0022-compile-receipts.md) adds a **receipts route to the same listener**, so that is no longer true — recorded here rather than left for a reader to discover the contradiction in the code.

The two binding constraints below are unaffected: receipts compute no classification, and nothing about them touches the read path. ADR-0022 adds a third in the same spirit — that route accepts receipts and nothing else, attributed to the caller's own verified certname.

### Binding constraints

Two, in ADR-0003's spirit and for its reasons:

1. **The replication endpoint must never compute classification on demand.** It serves what the materializer already wrote. Computing per request would recreate the synchronous coupling one plausible refactor later, and it would do so behind an endpoint that already exists and looks harmless.
2. **Nothing may move replication onto the read path.** The `exec` script reads a local file and nothing else. A cache, a socket, a "fast path" that calls the syncer — each reintroduces a liveness requirement where there is none.

## Consequences

### Gained

- The guarantee holds end to end on a real deployment: NexusPuppet can be stopped or deleted and agents keep converging.
- The operator runs `systemctl enable --now` once and never thinks about transport again — no NFS export, no `rsync` flags, no cron.
- Set-level atomicity, which neither documented option provided.
- No new runtime, no new secret, and no new listening port on `puppetserver`.

### Paid

- Classification reaches machines with a poll-interval delay. Consistent with the product's existing grain: a classification write already answers `202` with a job id rather than claiming to be live.
- A new read-only API surface, with its own authentication and allowlist to maintain.
- A second component to install on the Puppet server, and to document.
- Staleness becomes a state that **must** be surfaced. Without §6 this ADR would make the console capable of an honest-looking lie.

## Alternatives considered

**NFS export.** One copy of the truth and no delay. Rejected: catalog compilation would depend on an NFS server on the NexusPuppet host, so that host going down hangs the mount and blocks every compile — the failure ADR-0003 exists to prevent. It also requires packages on both ends that this estate does not have.

**`rsync` on a timer, permanently.** Works, and preserves the guarantee — it is what the first round-trip will use. Rejected as the *permanent* answer because it leaves every operator hand-rolling transport, and `--delay-updates` narrows the partial-set window without closing it.

**An event-driven sidecar answering over a Unix domain socket.** Proposed during design and rejected. It puts a live process on a read path that has none, converting a stale-file failure into a compilation outage. Its latency argument also inverts on inspection: the ENC contract is "print YAML on stdout", so `puppetserver` parses YAML either way, and a socket round-trip plus a local database lookup is more work than reading a page-cached file — while the whole cost is noise against catalog compilation. It would also cost `cat`: today any administrator can read a node's classification with no NexusPuppet knowledge, diff it, or put the tree in Git.

**Foreman's model** — an `exec` script that calls an HTTP API and caches the response to disk. It reaches the same conclusion from the other direction, and its cache is an admission that letting the classifier's availability gate compilation is dangerous. Rejected because it makes the network call the normal path and the cache the exception; this ADR keeps local files as the only path.

**Puppet Enterprise's model** — a classifier service queried through a terminus. Safe for PE because the classifier is co-located with the master. NexusPuppet is deliberately not co-located, and requiring it to be would make deployment topology part of the architecture.
