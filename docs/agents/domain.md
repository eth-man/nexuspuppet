# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root (may not exist yet — see below).
- **`docs/architecture/adr/`** — read ADRs that touch the area you're about to work in. This repo keeps its ADRs here (not `docs/adr/`), alongside `docs/architecture/README.md`.

If `CONTEXT.md` doesn't exist, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates it lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
/
├── CONTEXT.md                         ← created lazily by /domain-modeling
├── docs/architecture/
│   ├── README.md                      ← read before structural changes (per CLAUDE.md)
│   └── adr/
│       ├── 0000-record-architecture-decisions.md
│       └── ...
├── apps/
└── packages/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

ADRs in this repo are **binding**: where an ADR and any other document conflict, the ADR wins (per `CLAUDE.md`). If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0004 (read-only PuppetDB surface) — but worth reopening because…_

Changing what an ADR mandates requires a superseding ADR, not a PR comment.
