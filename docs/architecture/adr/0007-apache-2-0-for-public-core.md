# ADR-0007 — Apache-2.0 for the public core

- **Status:** Accepted
- **Deciders:** Project owner
- **Related:** [ADR-0002](./0002-open-core-runtime-discovery.md)

## Context

The public repository needs a licence that encourages adoption and contribution while leaving the private enterprise layer commercially viable. The two realistic candidates were a permissive licence (Apache-2.0, MIT) and a strong copyleft one (AGPL-3.0).

## Decision

**Apache-2.0 for the public core repository.** The enterprise layer is separately licensed under a proprietary commercial licence and is not distributed in this repository.

Apache-2.0 over MIT specifically for its **express patent grant** and its **patent-retaliation clause**, which matter for infrastructure software that organisations will run in production, and for the explicit `NOTICE`/attribution mechanics.

## Consequences

- Anyone may use, modify, embed, and commercially redistribute the core, including building a competing product on it. That is the accepted cost of adoption-first licensing.
- Because Apache-2.0 is permissive, the enterprise layer linking against core creates no copyleft obligation. The open-core model works without contortion — this is the licensing counterpart to ADR-0002's technical separation.
- Every source file carries no per-file header requirement, but the repository must ship `LICENSE` and `NOTICE`, and all releases must preserve them.
- **Contributor IP must be secured.** Apache-2.0 §5 states that contributions are licensed inbound under the same terms, which is sufficient for the core. If enterprise code is ever to incorporate community contributions, a CLA or DCO is required — otherwise the project cannot relicense that code commercially. **Adopt DCO sign-off from the first external contribution.** Tracked as an open item.
- Third-party dependencies must remain licence-compatible. A GPL/AGPL dependency in core would create obligations Apache-2.0 cannot satisfy. CI runs a licence check on the dependency tree and fails on copyleft.

## Alternatives considered

- **AGPL-3.0 with a CLA (the classic open-core defence).** Prevents SaaS competitors from closing modifications and pushes commercial users toward the paid licence. Rejected: AGPL is prohibited outright by many corporate policies, which would exclude a large share of the target audience — enterprise infrastructure teams — and this product's value is in being deployed inside those organisations.
- **MIT.** Simpler and equally permissive, but no patent grant. Apache-2.0 is strictly better for this use case at negligible extra complexity.
- **BSL / SSPL / "fair source".** Would deter exactly the contributors and evaluators the open core exists to attract, and they are not OSI-approved. Rejected.
