# NexusPuppet

A Puppet estate console: read-only PuppetDB visibility plus a native ENC that
classifies nodes. This glossary pins the project's terms; `docs/architecture/`
holds the decisions.

## Language

### Environments

**Staging**:
The environment that tracks `main` — where merged work is verified against
realistic infrastructure (enterprise edition, synthetic fixtures giving way to
real services as they are commissioned) before any release is cut.
_Avoid_: test server, dev environment, preprod

**Production**:
The environment that runs tagged releases only, connected to real Puppet
infrastructure. A release reaches it only after verification on Staging.
_Avoid_: live, prod server

### Accounts

**Automation account**:
A user record that a program authenticates as, rather than a person. It rests
deactivated and holds no working credential; it is granted for one task and
revoked afterwards. It is not a machine credential — the product has none — so
it carries a password like any local account.
_Avoid_: service account, bot user, agent account (an **agent** is a Puppet
agent, never a program acting on the console)

### Classification delivery

**ENC tree**:
The directory of YAML documents NexusPuppet materializes and puppetserver reads
— `default.yaml`, `nodes/<certname>.yaml`, and the `.revision` naming it. One
writer only. It travels to a Puppet server either by being materialized there
(co-located) or by being pulled from an origin (replication); the tree itself is
identical either way.
_Avoid_: ENC directory, classification output, the YAML folder

**Tree revision**:
The identity of an ENC tree's contents — the SHA-256 of the packed documents,
served as the replication ETag and written into `.revision`. It is a content
hash, so it is **not ordered**: two revisions can be compared for equality and
nothing else. Identical documents always produce the identical revision.
_Avoid_: version, generation, etag (the ETag is one *use* of the revision, not
another name for it)

**ENC listener**:
The mTLS-authenticated listener an origin runs so Puppet servers can fetch the
ENC tree (ADR-0019) and hand back compile receipts (ADR-0022 §4). Governed by
`ENC_REPLICATION_ENABLED`, whose name is narrower than its meaning: enabling it
starts the listener, and the bind address plus the certname allowlist decide who
may reach it. A co-located deployment runs it bound to loopback and replicates
nothing.
_Avoid_: the replication endpoint, the replication port (it carries receipts
too, which do not replicate anything)

**Compile receipt**:
A record that a node was served a particular tree revision, written by the ENC
script as it serves and carried back to the origin out of band (ADR-0022). It
proves what was **served**, never what the agent applied — and it carries no
compile time, only the time the origin received it.
_Avoid_: compile log, catalog record, "when the node last compiled"

### Reporting

**Saved query**:
A filter somebody kept and named, replayed against PuppetDB when opened
(ADR-0026). It stores which results, never how they are displayed — sort order,
columns and pagination are not part of it. Private unless deliberately shared.
_Avoid_: report (implies an output — a document, a schedule, an export — that a
saved query does not produce), saved filter, saved search, view

**Shared query**:
A saved query its owner has made visible to others. Visible only to people who
hold the permission needed to RUN it, because a name discloses what its author
is watching. It outlives its owner's account; a private one does not.
_Avoid_: public query, team query, global query (nothing about it is global —
`isShared` is per row, and every other object in the product genuinely is
global)

**Owner**:
The account a saved query belongs to. The first ownership relationship in the
product — node groups, roles and settings are all global — so "mine" and
"shared" mean something here and nowhere else.
_Avoid_: creator, author (both survive deletion in a way ownership does not:
after the account goes, a shared query has an `ownerEmail` and no owner)

### Certnames

Two different identities share the word `certname`, and they appear in the same
request. Always qualify which one is meant.

**Node certname**:
The certname of a managed node — the machine being classified. It names a
`nodes/<certname>.yaml` document and appears in the *body* of a compile receipt.
It is untrusted input wherever it becomes a filesystem path.
_Avoid_: hostname, fqdn, node name

**Peer certname**:
The certname of a **Puppet server** that pulls the ENC tree, taken from its
verified client certificate and never from a request body or header. It
identifies the replication peer and attributes every receipt that peer submits.
_Avoid_: client certname, puller name, and above all a bare "certname" in any
context where a node certname is also in play
