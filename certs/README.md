# PuppetDB mTLS certificates

Put the three files here. `.gitignore` uses `certs/*` with an exception for this
README, so an ordinary `git add` or `git add -A` cannot pick up key material.

`git add -f` **can** still force one in — that is what the flag is for. CI
therefore refuses any commit containing a private key or a certificate under
`certs/`, which is the check that does not depend on anyone remembering.

```
certs/
├── ca.pem       the Puppet CA certificate
├── client.pem   this application's certificate, signed by that CA
└── client.key   its private key
```

## Where each file comes from

On the Puppet CA host, after issuing a certificate for NexusPuppet:

| File here | Source path on the Puppet server |
|---|---|
| `ca.pem` | `/etc/puppetlabs/puppet/ssl/certs/ca.pem` |
| `client.pem` | `/etc/puppetlabs/puppet/ssl/certs/<certname>.pem` |
| `client.key` | `/etc/puppetlabs/puppet/ssl/private_keys/<certname>.pem` |

Issue one with:

```bash
puppetserver ca generate --certname nexuspuppet
```

## Permissions

```bash
chmod 0600 certs/client.key
chmod 0644 certs/ca.pem certs/client.pem
```

The key must not be group- or world-readable. `scripts/test-puppetdb.mjs`
checks this and refuses to run otherwise.

## Transferring them

Copy them over SSH. **Never paste key material into a chat window, an issue, a
pull request, or a CI variable that logs its value** — treat anything that lands
in one of those as compromised and reissue.

## Authorisation

A certificate is not enough: PuppetDB must also be told the certname may query
it, in `/etc/puppetlabs/puppetdb/conf.d/auth.conf`. Grant **query access only** —
NexusPuppet never writes to PuppetDB and has no code that could (ADR-0004).

Note that this certificate is estate-wide. PuppetDB has no per-user
authorization, so the API is a confused deputy by construction: it can see every
node. That is why authorization is decided in `api` *before* a query is built,
and why the web tier never holds this material.

## These are for local commissioning

In production these are mounted into the container from a path outside the
repository — see `DEPLOYMENT.md` §3. This directory exists so you can prove the
connection works from a development machine first.
