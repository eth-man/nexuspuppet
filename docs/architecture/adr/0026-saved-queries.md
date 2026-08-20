# ADR-0026 — Saved queries, and the first per-user object

- **Status:** Accepted
- **Deciders:** Project owner, architect
- **Related:** [ADR-0004](./0004-puppetdb-read-only-mtls.md), [ADR-0005](./0005-postgres-prisma-local-state.md), [ADR-0018](./0018-custom-roles.md), [ADR-0025](./0025-estate-wide-resource-search.md)

## Context

`saved_queries` has existed since the roles work and has never had a line of code touching it. Issue #243 named it for what it was: *"It was clearly meant to be this feature and was never built. It is currently a dead table."*

Phase 1 of #243 shipped fact filtering; this is phase 2. But the table cannot simply be switched on, because two things changed underneath it since it was designed.

**Filtering runs through PuppetDB, not local state.** #243 planned to filter `ManagedNode` and worried about the missing index. What shipped compiles a typed filter into PQL and asks PuppetDB. So a saved query is *replayed against PuppetDB*, and goes dark during an outage — an ADR-0004 consequence nobody explicitly accepted at the time.

**A second filter shape now exists.** [ADR-0025](./0025-estate-wide-resource-search.md) added `ResourceFilter`, behind its own privileged permission. The dead table's comment promises "a typed NodeFilter", which is no longer the whole story.

And one thing that was always true and never mattered until now: **everything else in this product is global.** Node groups, roles, settings — there is no "mine" anywhere. `isShared` is not a small flag on an existing pattern; it is the first ownership model in the system.

## Decision

**One table, discriminated by kind, private by default, with visibility decided per row by permission.**

### 1. Private by default, and sharing is a deliberate act

A new query is private. Sharing is a tick nobody is required to make.

The alternative — shared unless you say otherwise — decides by omission who can see what somebody is watching. A saved query's *name* often says more than its filter: "sudoers on the payment boxes" is a sentence about where the sensitive machines are.

### 2. One concept, two shapes

A `kind` column selects between `NodeFilter` and `ResourceFilter`; the table holds both.

Two tables would mean duplicate UI, duplicate sharing rules, and a second answer to every question in this ADR. The filter is validated against the schema `kind` selects — **on write and on read**. A row written by an older version, or by hand, must not reach `PqlBuilder` unchecked simply because it came from our own database; `filter` is `Json`, and the database will hold whatever is put in it.

An unrecognised `kind` resolves to the **more restrictive** interpretation, not the more permissive one: a row this version cannot read must not be shown to somebody a later version would have hidden it from.

### 3. A shared query is invisible to anyone who cannot run it

The list is filtered server-side, per row, by the permission the query's kind requires — `inventory:read` for a node query, `resources:read` for a resource one.

Not greyed out. Not disabled. **Absent.**

Because a name is information. Rendering "sudoers on the payment boxes" as an unclickable row tells a viewer that somebody is watching `/etc/sudoers`, and on which machines. `can()` in the UI hides what a user cannot use and is never a security control, so this is enforced where the list is built.

A query's owner always sees their own, regardless. Losing sight of something you saved because a permission changed would look like data loss, and the filter it holds is one you wrote yourself.

You also cannot **save** a query you cannot run — otherwise the list becomes a place to author queries for somebody else to execute.

### 4. Deleting a user drops their private queries and keeps their shared ones

`userId` is nullable with `ON DELETE SET NULL`, and `UsersService.remove` deletes that user's private queries first, inside the same transaction.

By the time a query is shared, the team relies on it. Losing the wallboard filter because the person who wrote it left is friction nobody asked for, and it is exactly the moment when nobody remembers how to rebuild it. A private query has no audience but the account being deleted.

`ownerEmail` is denormalised for the same reason `AuditLog.actorEmail` is: the row outlives the account, and "shared by nobody" names nothing.

Neither half expresses this alone. A cascade deletes too much; `SetNull` alone orphans queries nobody wanted kept.

### 5. Sharing is audited; creating is not

Sharing, unsharing, and deleting a shared query write an `AuditLog` row. Creating a private one does not.

Sharing changes who can see something. Creating a private query changes nothing for anybody else, and a row per save would bury the events that matter under the ones that do not — the same argument [ADR-0025 §6](./0025-estate-wide-resource-search.md) makes for not auditing ordinary browsing.

Unlike ADR-0025's read events, these **are** changes, so they take [ADR-0005](./0005-postgres-prisma-local-state.md) §2's ordinary shape: written in the transaction that carries the change, with real `before` and `after`.

### 6. Names are unique per owner, not globally

Two people may both have "Ubuntu boxes". The list shows the owner beside anything that is not yours.

Global uniqueness means the first person to save "prod web" takes the name from everybody, and the second gets an error about a name they cannot see.

### 7. It stores the filter, not the view

Sort order, column choice and pagination are not saved.

Those are how you *look* at results; the filter is *which* results. Storing all three means every UI change risks invalidating stored rows, and a saved query that reopens on page 4 of a result set that no longer has one is a bug report.

### 8. Applying a saved query writes the controls, not the results

The page's filter state is the source, and the query sent to the API is derived from it. Applying a saved query sets the controls.

Setting the query directly would show results the filter bar disagreed with — a screen stating one thing and displaying another, which is the same class of defect as a comparison that renders half its columns off-screen.

## Consequences

**A saved query is only as available as PuppetDB.** The list is local and always loads; the results are not. During an outage the query is still there and still openable, and shows the existing unreachable state. This is [ADR-0004](./0004-puppetdb-read-only-mtls.md)'s consequence surfacing in a new place, and it is stated here because nothing stated it when filtering moved to PuppetDB.

**Ownership now exists, and will be asked for elsewhere.** Saved dashboards, per-user defaults, notification subscriptions. This ADR decides the pattern: owner plus `users:manage`, private by default, visibility gated on the permission needed to *use* the thing.

**`users:manage` is now an escape hatch for other people's content.** An admin can rename, unshare or delete a shared query they do not own. Without it, a wrong shared query left by somebody who has gone can only be fixed in the database. It is audited.

**The schema change is not backwards compatible in one direction.** `userId` becoming nullable and `ownerEmail` becoming `NOT NULL` cannot be rolled back by checking out the previous release; the migration is forward-only, as all of them are. The table is empty in every known deployment, which makes this cheap today and not later.
