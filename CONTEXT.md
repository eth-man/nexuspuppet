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
