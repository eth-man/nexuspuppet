# ADR-0009 — Classification merge and conflict resolution

- **Status:** Accepted
- **Deciders:** Architect
- **Related:** [ADR-0003](./0003-enc-generate-dont-serve.md)

## Context

A node may match several node groups. Each group can assign classes, class parameters, and top-scope parameters. Groups form a hierarchy. Two groups can assign the same class with different parameters, or the same top-scope parameter with different values.

Puppet's ENC contract accepts exactly one YAML document per node:

```yaml
classes:
  profile::base:
    ntp_servers: [...]
parameters:
  datacenter: dc1
environment: production
```

So NexusPuppet must reduce N matched groups to one document, deterministically. If this reduction is ambiguous, ordering-dependent, or surprising, the product silently misconfigures machines — the most expensive failure mode available to it.

## Decision

### Ordering

Every group has an integer `rank` (default 100) and a stable `id`. Matched groups are sorted by `(rank ASC, id ASC)`. **Higher rank wins**, meaning it is applied later and overwrites. Ties broken by `id` so the result is fully deterministic and never depends on database row order.

Group hierarchy contributes ordering, not inheritance: a child group's effective rank is evaluated after its ancestors, so a child always overrides its parent.

### Merge rules

| Element | Rule |
|---|---|
| **Class inclusion** | Union. A class assigned by any matched group is included. |
| **Class parameters** | Last writer wins, per key, at the top level of the parameter map. |
| **Top-scope parameters** | Last writer wins, per key. |
| **Environment** | Last writer wins. A group with no environment does not clear an earlier one. |
| **Nested values (hash/array parameter values)** | **Replaced wholesale, not deep-merged.** |

### Why no deep merge

Deep-merging hashes is the intuitive choice and the wrong one. It makes the effective value of a parameter a function of every group in the chain, so an operator reading one group cannot know what a node will receive. It also makes *removing* a key from a nested hash impossible without a sentinel value. Hiera exists for layered data merging and does it properly; the ENC's job is classification, not data composition. A parameter value is set by exactly one group, and the UI can name which one.

### Conflict visibility

Silent last-writer-wins is acceptable only if conflicts are visible.

1. `ClassMerger` returns the merged document **and** a `conflicts[]` list: for each overwritten key, the losing group, winning group, and both values.
2. Conflicts are persisted with the materialization and surfaced in the UI — on the node's classification view, and as an estate-wide report grouped by which override it is (winning group, losing group, key) with the number of nodes each affects. `ENVIRONMENT` conflicts sort above everything: they decide which branch of the control repository a machine runs, so a handful of them outranks a parameter override on hundreds of nodes, and ordering by breadth alone would bury exactly the dangerous case.
3. Conflicts are **warnings, not errors**. Overriding a base group is a legitimate, common pattern. Blocking it would be wrong; hiding it would also be wrong.

### Determinism requirements

`ClassMerger` and `EncYamlRenderer` are pure functions. The renderer emits keys in sorted order and arrays in their declared order, so identical input always produces byte-identical output. This is not cosmetic — content-hash comparison is what prevents pointless file writes and spurious `EncMaterialization` churn ([ADR-0003](./0003-enc-generate-dont-serve.md)).

### Safety rails

- A node matching **zero** groups gets `default.yaml`, never an empty or missing file.
- Class names are validated against Puppet's identifier grammar before rendering. An invalid class name is rejected at write time, in the UI, not discovered during catalog compilation.
- Rendered YAML is parsed back and structurally compared before the atomic rename. A document that fails round-trip is never written.

## Consequences

- Classification is explainable: for any node, the UI can show every matched group, in order, and which group set each final value. "Why is this node getting this class?" is answerable in one screen — a primary product requirement.
- Operators expecting Hiera-style deep merge will be surprised once. Documented prominently in the UI at the point of assignment.
- `rank` is an operator-facing concept that must be explained well; a bad default here produces confusing overrides.
- `RuleEvaluator` and `ClassMerger` being pure makes exhaustive table-driven unit tests cheap. Given the blast radius, they carry the highest coverage requirement in the codebase.

## Alternatives considered

- **Deep merge with a `--knockout` sentinel** (Hiera-style). Powerful, and makes effective values unreadable without simulating the whole chain. Rejected as above.
- **First-writer-wins.** Equivalent in power, but inverts the common expectation that a more specific group overrides a general one. Rejected.
- **Hard error on any conflict.** Safest-sounding and unusable in practice: base-plus-override is the normal way to use group hierarchies. Rejected in favour of visible warnings.
- **Explicit per-key priority on assignments.** Maximum control, far more UI complexity, and defers the problem to the operator. Rejected for v1; group `rank` covers the realistic cases.
