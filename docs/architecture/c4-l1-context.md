# C4 Level 1 — System Context

```mermaid
graph TB
    ops["Ops Engineer<br/><i>Person</i><br/>Views inventory and run<br/>failures, edits classification"]
    admin["Platform Admin<br/><i>Person</i><br/>Manages users, groups,<br/>enterprise licensing"]

    np["NexusPuppet<br/><i>Software System</i><br/>Puppet estate console:<br/>read-only visibility +<br/>native ENC classification"]

    pdb["PuppetDB<br/><i>External System</i><br/>Facts, catalogs, reports,<br/>node status"]
    psrv["Puppet Server<br/><i>External System</i><br/>Compiles catalogs for agents"]
    idp["Identity Provider<br/><i>External System</i><br/>AD / LDAP / SAML / OIDC<br/><b>enterprise layer only</b>"]
    agents["Puppet Agents<br/><i>External System</i><br/>~1,000 managed nodes"]

    ops -->|"HTTPS"| np
    admin -->|"HTTPS"| np
    np -->|"PQL queries over mTLS<br/><b>read-only</b>"| pdb
    np -.->|"writes classification YAML<br/>to a shared volume"| psrv
    np -.->|"authenticates users<br/><i>optional</i>"| idp
    agents -->|"requests catalog"| psrv
    psrv -->|"reads node YAML from disk<br/><b>no network call to NexusPuppet</b>"| psrv
    psrv -->|"stores facts & reports"| pdb

    classDef person fill:#0b4884,stroke:#073b6f,color:#fff
    classDef system fill:#1168bd,stroke:#0b4884,color:#fff
    classDef external fill:#666,stroke:#444,color:#fff
    class ops,admin person
    class np system
    class pdb,psrv,idp,agents external
```

## Actors

| Actor | Needs |
|---|---|
| **Ops Engineer** | Find why a node's run failed, in under two minutes. See what a node is classified as and why. |
| **Platform Admin** | Manage users and roles, define node groups and matching rules, manage the enterprise licence. |

## External systems

| System | Relationship | Direction | Criticality |
|---|---|---|---|
| **PuppetDB** | PQL over HTTPS with mTLS client cert | NexusPuppet → PuppetDB, read-only | Degrades visibility features only |
| **Puppet Server** | Filesystem handoff — NexusPuppet writes YAML, `puppetserver` reads it via an `exec` node terminus | Indirect, asynchronous, no runtime coupling | **Deliberately zero runtime coupling** ([ADR-0003](./adr/0003-enc-generate-dont-serve.md)) |
| **Identity Provider** | Enterprise layer only; core uses local accounts | NexusPuppet → IdP | Optional, absent in core |

## The relationship that is deliberately absent

There is **no synchronous call from Puppet Server to NexusPuppet**. This is the defining constraint of the system context. A conventional ENC would draw an arrow `psrv → np` on the critical path of every agent run; that arrow does not exist here, and no future change may introduce it without superseding ADR-0003.
