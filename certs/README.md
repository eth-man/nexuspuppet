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

That can print `Error: Signed certificate nexuspuppet could not be found on the
CA` and still succeed — it has been seen doing exactly that on an autosigning
CA. Judge it by the files, not the message: all three means done; key and public
key only means the request is submitted but unsigned, so run `puppetserver ca
sign --certname nexuspuppet` and try again.

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

## Authorisation — there isn't any

This file used to say to grant the certname "query access only" in
`auth.conf`. **That is not possible, and following it gives a false sense of
safety.** PuppetDB has no per-certname authorization for `/pdb/*`: `auth.conf`
governs only the metrics endpoints, and `certificate-whitelist` was removed
after PuppetDB 6. Verified against OpenVoxDB 8.15.0 — see `DEPLOYMENT.md` §3 for
the measurements.

Any certificate signed by the Puppet CA can read all of PuppetDB **and write to
it**, including every agent certificate in the estate. Bound it at the network
layer or not at all.

NexusPuppet itself never writes to PuppetDB and has no code that could
(ADR-0004) — but that is our restraint, not a permission boundary. Treat this
key as a full-access estate credential.

To see what your own certificate can do:
`node scripts/dev/puppetdb-auth-probe.mjs`

That the credential is estate-wide is why authorization is decided in `api`
*before* a query is built, and why the web tier never holds this material.

## These are for local commissioning

In production these are mounted into the container from a path outside the
repository — see `DEPLOYMENT.md` §3.

> **If you point Compose at this directory** (`PUPPETDB_CERT_DIR=./certs`, the
> default), note that the api container runs as **uid 100**. A `0600` key owned
> by your own user is unreadable to it, and the console will report only
> "PuppetDB unreachable" — the API log says which file and why. Either own the
> files by uid 100 as §3 describes, or keep this directory for host-side checks
> like `npm run test:puppetdb` and mount a properly-owned path into the
> container. This directory exists so you can prove the
connection works from a development machine first.
