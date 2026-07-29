# ADR-0011 — Scoped RBAC: bounding writes by environment

- **Status:** Deferred — design accepted, implementation postponed
- **Deciders:** Architect
- **Related:** [ADR-0002](./0002-open-core-runtime-discovery.md), [ADR-0006](./0006-auth-local-jwt-modular-sso.md), [ADR-0009](./0009-classification-merge-semantics.md)

## Outcome

**Not being built.** The design below is sound and the analysis stands; the
cost is not justified by present demand.

Three reasons, in order of weight:

1. **The effect check is expensive to build and to maintain.** Every
   classification write would have to compute the set of nodes it affects and
   test it against the writer's scope, inside the transaction, on the write path
   of the product's most important feature. That is a security-critical check in
   the place where a regression is most expensive.

2. **The future-node loophole cannot be closed at write time.** A scoped
   operator writes a rule that matches only their environments today; a node
   appearing tomorrow in another environment inherits their classes. No
   write-time check can prevent it, because the estate changes afterwards. A
   scoping feature that is *nearly* a boundary invites more trust than it earns.

3. **Nobody is asking for it.** Flat RBAC is correct for a single operations
   team, which is every deployment today. The *Do nothing* alternative below was
   a genuine option and it is the one taken.

Kept as a record rather than deleted, because the requirement will return. When
it does, the two findings worth re-reading first are **why scoping by node group
does not work** and **why the check must be on the effect rather than the
request** — both are counter-intuitive, both were discovered by reading the code
rather than by reasoning about the feature, and both would otherwise be
rediscovered the expensive way.

Reopening this should start with the four *Open questions for review*, and in
particular with whether read scoping is needed — if it is, decision 3 below is
the wrong starting point and the design should be redone rather than extended.

## Context

Today's authorization is flat and estate-wide. An `OPERATOR` may change the classification of every node; a `VIEWER` may read everything. That is correct for a small team and wrong for an organisation where a database team should not be able to alter the web tier's configuration.

The obvious shape is "scope a user to some node groups". Some of that already exists in the codebase:

| | |
|---|---|
| `AuthenticatedPrincipal.scopedGroupIds` / `scopedEnvironments` | declared, carried in the JWT as `sgi` / `sev` |
| `AuthorizationTarget { groupId, environment, certname }` | declared |
| `withinScope()` in core's `RbacPolicy` | implemented |
| `targetFrom(request)` in `AuthGuard` | implemented |

**Nothing populates the scope fields, so none of it has ever run.** That is the sixth declared-but-unexercised seam found in this project, and — unlike the others — parts of it are not merely inert but unsound. Building on it unchanged would ship a security control that does not control anything.

This ADR exists because the intuitive design is wrong in a way that is easy to miss.

### Why "scope a user to a node group" does not work

A scoped operator who may edit group X can, today, change what X *matches*:

```
PUT /node-groups/X/rules   { factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }
```

Group membership is **fact-based**, so that single write makes X match every Linux node in the estate — and every class X assigns now applies to all of them. The same is available through pins:

```
POST /node-groups/X/pins   { certname: 'prod-db-01' }
```

**Bounding which group you may edit is not the same as bounding which machines you may change.** A group is an authoring surface, not a boundary. An operator scoped to one group has, in effect, estate-wide write access one request away, and the audit log would show a perfectly ordinary rule change.

### Three further defects in the existing scaffolding

**It fails open.** `withinScope` returns `true` when the target is `undefined`, and `targetFrom` returns `undefined` for any route without `:id`, `:certname` or `?environment`. `POST /node-groups` names no group, so a scoped principal may create groups freely. Any future route that happens not to carry one of those parameters is unscoped by accident rather than by decision.

**The environment is caller-asserted.** `targetFrom` reads it from the request's own query string. A scoped user simply omits `?environment` and the check does not apply. A security boundary may not take its input from the party it constrains.

**`certname` is never checked.** `withinScope` inspects `groupId` and `environment` only, so the one field that identifies an actual machine is ignored.

## Decision

### 1. A scope is a set of environments, not groups

`production`, `staging`, `development` are properties of **nodes**, reported by Puppet and projected from PuppetDB. A user is scoped to environments; groups remain estate-wide objects that anyone with `classification:write` may author.

Environments are the natural boundary because they already partition the estate, operators already think in them, and — critically — a node's environment is not something a scoped user can edit. Group membership is.

### 2. Writes are checked against their EFFECT, not against the request

This is the load-bearing decision.

A classification write is permitted only when **every node it would affect** is in the writer's environments. The check runs inside `ClassificationService`, in the same transaction as the change, because that is the only place where the affected set is known — and it is already computed there, for the transactional outbox ([ADR-0005](./0005-postgres-prisma-local-state.md)).

```
affected(change)  ⊆  nodes in principal.scopedEnvironments      → allow
otherwise                                                        → 403
```

Checking the effect rather than the request closes the rule-authorship escape completely. A scoped operator may write any rule they like; if the resulting node set reaches outside their environments, the write is refused. They cannot escalate by being clever about *how* they express the change, because the check does not look at the expression.

The affected set is the **union of before and after**. A change that removes nodes from a group affects those nodes too, and a check on the post-image alone would let a scoped user detach production nodes from a group they should not touch.

### 3. Reads stay global

Any authenticated user may read the whole estate: inventory, facts, reports, classification.

This is a deliberate simplification and it is the part of this ADR most likely to be revisited. See *Consequences*.

### 4. The guard fails closed for writes

`withinScope` currently returns `true` for an absent target. For write permissions that inverts: **a scoped principal performing a write with no determinable scope is refused.** A route that forgets to identify its target becomes a 403, not a silent bypass. Reads keep the permissive behaviour, because reads are global by decision 3.

### 5. Enforcement stays in core

`withinScope` already lives in core's `RbacPolicy` rather than in the enterprise layer, and the effect check will too. A deployment that loads an enterprise auth provider but keeps the core policy must not silently ignore every restriction. Core enforces; enterprise only decides *what* a principal's scope is.

Core continues to populate no scopes, so a core-only deployment behaves exactly as it does now.

### 6. An unscoped principal is unrestricted

`scopedEnvironments` absent or empty means estate-wide, as today. Scoping is opt-in, applied by a directory that knows about it.

## Consequences

### What this buys

A scoped operator cannot change the configuration of a machine outside their environments, by any route: rules, pins, classes, parameters, rank, deletion. The guarantee is about *machines*, which is what an organisation actually cares about.

### What it costs

**Reads are not restricted, and that is a real exposure.** Facts carry hostnames, IP addresses, installed packages and versions; reports carry error messages that sometimes contain paths, connection strings, or the contents of a failed template. Anyone who can log in can see all of it for the whole estate. For a single organisation with a shared operations team that is usually acceptable; for a service provider hosting several customers it is not, and this ADR would need superseding before that use case is supported.

**A rule change by a scoped operator is heavily constrained.** Rule edits trigger a full reconcile ([ADR-0009](./0009-classification-merge-semantics.md)) because they can pull in nodes that did not match before. Computing "which nodes would this rule affect" requires evaluating the proposed rule against the projection, which is affordable but not free, and a rule that matches anything outside the scope is refused outright. Scoped operators will find rule authoring more restrictive than class assignment. That is the correct trade — rules are exactly the escalation path — but it will generate support questions.

**Future nodes are not covered.** A scoped operator writes a rule matching `os.family = Debian`; every Debian node today is in `staging`, so the write is allowed. Tomorrow a Debian node appears in `production` and inherits their classes. **No check at write time can prevent this**, because the estate changes afterwards. Mitigations exist — refuse scoped users any rule not itself constrained to their environments, or re-check at materialization — and both add complexity this ADR deliberately defers. It must be stated plainly rather than discovered.

**Empty-affecting writes are permitted.** Creating a group that matches nothing, or renaming one, affects no nodes and is allowed for any scoped user. Groups are estate-wide objects under this design, so two teams can collide on naming and rank. Acceptable, and the audit log names who did what.

### Performance

The check needs the affected node set before committing. `ClassificationService` already computes it for the outbox, so for class, parameter and pin changes the cost is a set membership test. Rule changes are the exception: they currently short-circuit to `full-reconcile` without enumerating nodes, and a scoped writer would force that enumeration. Bounded by the estate size and already keyset-paginated, but it is new work on the write path and should be measured before this is called done.

## Alternatives considered

**Scope by node group.** The intuitive design, and unsound: a group's membership is editable by whoever can edit the group, so the boundary can be moved from inside. Rejected — and the reasoning is worth keeping, because this is the design most people propose first.

**Scope by group, with rules and pins forbidden for scoped users.** Sound, and much simpler to implement: it removes the escape hatch rather than checking the effect. Rejected because it leaves scoped operators unable to do the main thing operators do. It remains a reasonable fallback if the effect check proves too costly.

**Scope reads as well as writes.** Coherent, and necessary for multi-tenancy. Rejected for this iteration on the explicit instruction to minimise friction, and because restricting reads touches every list endpoint, every count, and the dashboard — a much larger change with much more regression surface than the write path alone.

**Per-node ACLs.** Maximum precision, and unmanageable: an estate of thousands of nodes acquires thousands of ACL decisions, which in practice become one ACL applied to everything.

**Do nothing.** Genuinely viable. Flat RBAC is correct for a single operations team, which is most deployments today, and this ADR adds a security-critical check to the write path of the product's most important feature. If no user is asking for scoping, the right answer is to keep this document as a record of how it *would* be done and revisit when someone asks.

## Open questions for review

1. **Is the effect check worth its complexity**, or is "scope by group, no rule or pin edits" enough for the users actually asking?
2. **Should a scoped operator be able to create groups at all?** Under this design they can, and the group is then estate-wide.
3. **What happens to a node whose environment changes** out from under a scoped operator's group? Nothing today — the group keeps applying. Correct, or surprising?
4. **Does anyone need read scoping soon?** If multi-tenancy is on the horizon, decision 3 is the wrong starting point and this should be designed for it now rather than superseded later.
