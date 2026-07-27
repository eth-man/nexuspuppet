# ADR-0000 — Record architecture decisions

- **Status:** Accepted
- **Deciders:** Project owner, architect
- **Supersedes:** —

## Context

NexusPuppet has a small number of decisions that are expensive to reverse later: the ENC handoff mechanism, the open-core boundary, and the data ownership split. Without a written record, these get re-litigated by whoever touches the code next, or — worse — silently violated by a plausible-looking pull request.

## Decision

We record architecturally significant decisions as ADRs in `docs/architecture/adr/`, numbered sequentially and never renumbered.

A decision is architecturally significant if reversing it would require changing more than one workspace package, changing the database schema, or changing an external integration contract.

**Format:** Context → Decision → Consequences → Alternatives considered. Short. An ADR nobody reads is worthless.

**Lifecycle:** `Proposed` → `Accepted` → `Superseded by ADR-NNNN`. ADRs are immutable once accepted. To change a decision, write a new ADR that supersedes the old one and update the old one's status line only.

**Authority:** Where an ADR and any other document conflict, the ADR wins. Where two ADRs conflict, the higher number wins.

## Consequences

- Reviewers can reject a PR by citing an ADR rather than by preference.
- New contributors have a decision history rather than folklore.
- Small overhead per significant decision; none for ordinary work.

## Alternatives considered

- **A wiki** — drifts from the code, and is not reviewable in a pull request.
- **Comments in code** — invisible until you already know where to look.
- **Nothing** — the default outcome is that ADR-0003 gets quietly violated by someone adding "just a small HTTP ENC endpoint," which is precisely the failure this project exists to avoid.
