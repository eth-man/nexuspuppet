# ADR-0012 — GitOps mode: classification mirrored to Git

- **Status:** Proposed
- **Deciders:** Architect
- **Related:** [ADR-0002](./0002-open-core-runtime-discovery.md), [ADR-0003](./0003-enc-generate-dont-serve.md), [ADR-0005](./0005-postgres-prisma-local-state.md), [ADR-0009](./0009-classification-merge-semantics.md)

## Context

Puppet *code* lives in a control repository. It is reviewed in pull requests, promoted between environments, and every line has an author and a date. Puppet *classification* — which machines get that code — lives in a database, edited through a web form, with no diff, no review and no blame.

Half the configuration of an estate is engineered and half is clicked. Every tool in this space has that schism, and none treats it as a problem: Puppet Enterprise's console, Foreman and Puppetboard all keep classification in a database with no git representation at all.

NexusPuppet is unusually placed to close it. The defining decision of this product is that it **generates files** rather than serving requests ([ADR-0003](./0003-enc-generate-dont-serve.md)), and the transactional outbox that carries a classification change to those files ([ADR-0005](./0005-postgres-prisma-local-state.md)) has already been reused once, for audit delivery. Writing to a git repository is the same shape a third time.

## Decision

### 1. Mirror the classification SOURCE, not the ENC output

One file per node group — rules, classes, parameters, pins, rank, environment:

```
classification/
  base-linux.yaml
  web-tier.yaml
```

**Not the ENC documents.** Those are derived, and they churn with facts: a node changing environment rewrites its file, so the history would fill with thousands of commits describing nothing a human did. Serialising the source means every commit corresponds to a decision someone made, which is the only thing that makes `git log` readable and `git blame` worth running.

### 2. The database remains the source of truth; git is a replica

Changes are made in NexusPuppet and mirrored outward. Git is not read back.

This is the smaller half of "GitOps" and it is deliberate — see *Alternatives*.

### 3. Sync goes through the outbox, never the write path

A push is network I/O and cannot happen inside the transaction that made the change, for exactly the reasons audit delivery could not: a slow or unreachable remote would hold a pooled connection and its locks open, and a rollback would leave a commit describing a change that never happened.

So the sync job is enqueued in the same transaction as the change and drained by a worker with a lease, backoff and single-flight — the machinery already built for audit delivery.

**A git outage must never fail a classification write.** The queue is the buffer, and the surface for it already exists: `GET /system/status` and its dashboard card report queue depth and stranded work as first-class concepts.

### 4. Authorship comes from the audit record

The audit log already holds the actor's email and display name. Those become the **commit author**; NexusPuppet is the committer. The action and entity become the subject line:

```
classification: assign profile::nginx::tuning to web-tier

Actor:   Alice Ng <alice@example.com>
Affects: 47 nodes
```

`git blame` then answers "who put this class here, and why" — a question the audit log can answer, far less accessibly.

### 5. Divergence stops and asks, rather than guessing

If someone pushes to the repository directly, our push is rejected non-fast-forward. The worker fetches, rebases its commits on top, and retries a bounded number of times. If that fails it **stops and surfaces the conflict**.

Neither side is forced. Silently discarding a human's commit, or silently discarding ours, would both make the artifact untrustworthy — and an audit trail nobody trusts is worse than none, because it is still cited.

### 6. Rollback is part of the first increment

"Restore this group to commit `abc123`" is nearly free once a serialised form exists: read the file at that revision, apply it as a normal classification write, with a plan ([ADR-0011 is deferred, but plan-before-apply is not](./0011-scoped-rbac.md)) shown first like any other change.

This is the feature an operator will actually reach for at 2am, and it is the strongest single argument for the whole ADR.

## Consequences

### What this buys

Blame, diff, rollback, disaster recovery, and a history reviewable after the fact by people who never log into the console. It also makes the classification database reconstructible from a repository, which is a materially better disaster story than a database backup.

### What it costs

**Class parameters can contain secrets, and this creates a disclosure path that does not exist today.** A parameter holding a licence key or a connection string currently sits in Postgres behind authentication; mirrored, it sits in a repository that is often readable by more people than can reach the console. This must be answered in the design rather than discovered afterwards — redaction, an explicit allow-list of parameters to mirror, or at minimum a loud warning at configuration time. It is the single largest risk here.

**Repository credentials become deployment state.** A deploy key or token, handled the way the audit transport's credentials are: a path to a file, never inline in an environment variable, and never rendered by any `describe()`.

**Group renames churn the tree.** Naming files by group name is readable and makes a rename look like a delete plus an add; naming them by id is stable and unreadable. Neither is obviously right (see *Open questions*).

**Bootstrapping is a special case.** The first sync must commit the entire existing classification set as one commit, authored by nobody in particular, and that commit will be large.

### What it does NOT buy

**It is not review-before-merge.** Nobody approves a pull request before the change reaches machines — the change has already happened, and git records it. Calling this "GitOps" without that caveat would oversell it.

## Alternatives considered

**Git as the source of truth, with the UI opening pull requests.** The full cultural win: classification proposed, reviewed, approved, then applied by a reconciler. Rejected for this iteration, and the reasoning has changed recently in a way worth recording.

Plan-before-apply already delivers much of what people actually want from a classification pull request: see the blast radius, the resulting documents and any new conflict *before* the change lands. That was the strongest argument for inverting the write path, and shipping it has substantially weakened it. What remains uniquely PR-shaped is *approval by a second person*, which is a real requirement for some organisations and not one anybody has asked this project for yet.

It is also a much larger change: it inverts the write path, needs conflict resolution between the repository and the database, needs the UI to become a proposal tool rather than an editor, and introduces a loop hazard where our own commit triggers a sync that triggers a commit.

**Mirror the ENC output as well as the source.** Attractive for disaster recovery — the files are what puppetserver reads. Rejected because the churn destroys the history's value, and because the ENC directory is already reconstructible from the classification set by a full reconcile.

**Write to git synchronously on each change.** Simpler, and wrong for the same reason synchronous audit delivery was: it makes a remote's availability a dependency of a local write.

**Do nothing.** Genuinely viable. The audit log already records who changed what and when, `GET /system/status` reports whether the estate is converging, and plan-before-apply covers the review gap. Git adds blame, rollback and an artifact reviewable outside the console — real value, but not a gap anybody is currently blocked by. If the next thing this project needs is estate-scale validation or a second audit transport, those are defensible choices over this.

## Open questions

1. **Core or enterprise?** Audit export went enterprise, and this could follow that precedent. The argument for **core** is strategic: this is the feature that would make an engineer choose NexusPuppet over Puppet Enterprise's console on principle rather than on price, and putting it behind a licence undercuts the adoption story open core depends on ([ADR-0002](./0002-open-core-runtime-discovery.md)). Worth deciding deliberately rather than by defaulting to the LDAP precedent.
2. **File naming.** By group name (readable, renames churn) or by id (stable, opaque)? A hybrid — `<name>-<short-id>.yaml` — is readable and stable but ugly, and still renames.
3. **What happens to secrets?** Redaction, an allow-list, or a warning. This gates the whole ADR.
4. **Does the mirror include disabled groups?** They classify nothing but are part of the configuration, and omitting them would make the repository an incomplete restore source.
5. **One commit per change, or batched?** Per change gives precise blame; a busy estate produces a noisy history. Batching by drain cycle is cheaper and loses attribution granularity.
