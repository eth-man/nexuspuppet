# @nexuspuppet/tls-grant

A signed, short-lived, single-use authorisation to install a console
certificate (ADR-0017).

**Why this is not in `@nexuspuppet/contracts`.** Contracts is imported by
`apps/web` and must stay browser-safe: it carries no `@types/node` and nothing
in it may reach for a Node builtin. This uses `node:crypto`, so putting it there
breaks the contracts build and — worse, if it had built — would pull Node crypto
into the browser bundle.

**Why it is not simply duplicated.** The api mints and the cert-helper verifies.
Two implementations of one wire format disagree eventually, and the failure mode
is every certificate installation being rejected with no obvious cause.
