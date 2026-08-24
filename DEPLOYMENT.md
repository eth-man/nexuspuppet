# Production deployment — fresh on-prem VM

Deploying NexusPuppet onto a clean host and connecting it to a live Puppet
estate. Read [`docs/architecture/README.md`](docs/architecture/README.md) first if
you have not; the constraints below come from the ADRs and are not stylistic.

> **Status.** This has now been installed on real estates — a native OpenVox
> Server 8.15 with OpenVoxDB 8.15 on Ubuntu 24.04, and a containerised Puppet
> stack — and reached a working console with live inventory both times. It is no
> longer untested against real infrastructure, and this banner previously said it
> was; that claim is retired.
>
> **It is still early.** Both installs found defects, and every one of them was
> in the deployment path rather than the application: a missing file in the
> runtime image, environment keys Compose never delivered, certificate ownership,
> documentation describing mechanisms that do not exist. None was found by the
> 488 unit, 294 integration and browser tests, because none of them lives in the
> source tree.
>
> So treat the first deployment as a commissioning exercise rather than a
> rollout, and read
> [First contact with a real estate](#9-first-contact-with-a-real-estate) for what
> to expect to be wrong. Nothing here has been exercised at estate scale.

---

## Quick start

If you have Docker, a PuppetDB, and a client certificate for it, this is the
whole installation:

```bash
./scripts/deploy.sh --puppetdb https://puppetdb.example.com:8081
```

Check first if you would rather know before anything is built:

```bash
./scripts/deploy.sh --check
```

That verifies the certificate is present, readable **by the container's uid**,
valid and not expired; that PuppetDB answers it; and that the port is free. Each
failure names its fix. Two of them are worth the run on their own, because
neither announces itself otherwise: a certificate the container cannot read
starts the console perfectly and shows an **empty estate**, and a certname
missing from PuppetDB's allowlist returns **403**, which reads as a broken
certificate.

The deploy runs the same checks and stops if they fail, so nothing is built
against an environment that cannot work.

It generates the secrets, writes `.env`, builds, migrates and starts, then
prints the console URL and the admin password once. **Re-run it to upgrade** —
same command, keeps your `.env`, rebuilds and re-migrates in the right order.

CI runs that script on every commit, so it is the install path that is actually
tested rather than one described in prose.

### Reachable, and encrypted, in the same command

The console binds loopback by default because port 3000 is plain HTTP — a
certificate elsewhere does not encrypt it, and publishing it puts login
credentials on the network in the clear. To reach it from another machine
without that:

```bash
./scripts/deploy.sh --puppetdb https://puppetdb.example.com:8081 \
                    --tls console.example.com
```

Caddy issues a certificate itself at startup — no ACME, no internet, no files —
serves the console on 443, and leaves 3000 on loopback behind it. Your browser
will warn, because that CA is in nobody's trust store; the traffic is genuinely
encrypted, which is the part `WEB_BIND=0.0.0.0` does not give you.

That name has to resolve to this host from wherever you browse. Replace the
certificate with a publicly trusted one later via §7 — nothing else changes.

**Not for a console the public can reach.** A warning users learn to click
through is worse than no warning; get a real certificate for anything
internet-facing.

You still need one thing the script cannot invent: a **client certificate** for
PuppetDB (§3 — including the allowlist step people miss).

### Classifying nodes takes one more command, on the Puppet server

The above gives you a read-only console. To have NexusPuppet actually classify
nodes, enable the ENC listener in `.env` and re-run `deploy.sh` — it will then
offer to set up your Puppet server over SSH, and print the command either way:

```bash
./scripts/setup-enc.sh --remote you@puppet.example.com \
    --origin https://nexuspuppet.example.com:8443 --wire
```

It ships itself over your SSH session — nothing to clone on that host — checks,
installs the puller and the ENC script, proves the script serves a node, and
only then puts it on the compile path. Drop `--wire` to stop before that last
step. It writes no key and leaves nothing behind. Full walkthrough in §6.

It is a second command on a second host because nothing may make Puppet depend
on NexusPuppet **at runtime** (ADR-0003). An installer you drive from a terminal
is fine; the running console reaching into `puppetserver` is not.

Everything below is the reference: what each decision means and what breaks when
it is wrong. Read it when something does not fit, not to get started.

---

## 0. Before you touch the VM

Collect these. Three of them cannot be generated on the box.

| Item | Where it comes from |
|---|---|
| PuppetDB URL and port | Usually `https://puppetdb.internal:8081` |
| Client certificate, key, and CA | Puppet CA — see [§3](#3-puppetdb-certificates) |
| Postgres password | You choose. Generate it, do not invent it |
| `JWT_SECRET` | `openssl rand -base64 48` |
| Bootstrap admin password | Generate it; it is discarded after first login |
| Enterprise repo URL | Only for the enterprise edition — see [§2](#2-the-enterprise-layer-is-not-a-submodule) |

**Decide up front how the ENC directory reaches puppetserver.** This is the one
architectural decision the deployment cannot defer, and it is covered in
[§6](#6-wiring-puppetserver).

### Host requirements

- Linux with Docker Engine ≥ 24 and the Compose plugin. Neither is present on a
  stock Ubuntu or Debian image; on those, `sudo apt install docker.io
  docker-compose-v2` is enough, and nothing in this guide needs a newer Docker
  than the distribution ships
- 2 vCPU / 4 GB RAM is comfortable for a few thousand nodes; the workload is
  mostly idle between projection ticks
- Disk: Postgres growth is driven by report retention, not node count
- Outbound TCP to PuppetDB on 8081.
- **Nothing here ever connects INTO puppetserver**, and nothing should be
  permitted to (ADR-0003). Catalog compilation must never wait on this host.
- One inbound port is needed *only* if you replicate the ENC tree to a separate
  Puppet server (§6) or collect compile receipts: that server pulls from this one
  on 8443. It is an out-of-band poll on its own timer, not part of a catalog
  compile — stop this host and the Puppet server keeps serving the tree it
  already has. Co-located deployments need no inbound access at all.

### Puppet or OpenVox

Both are supported, and NexusPuppet needs no configuration change to tell them
apart.

> **PuppetDB must have its TLS listener enabled.** Port 8081 exists only once
> PuppetDB has a keystore; a fresh install may be listening on 8080 alone, which
> is plaintext and localhost-only and cannot be used. If `ss -ltn | grep 8081`
> shows nothing, run `puppetdb ssl-setup` and restart it.
>
> **You need a PuppetDB before you start.** The console reads its inventory from
> one; without it the stack comes up healthy and shows nothing, which is hard to
> tell from a broken install. If you do not have one yet,
> [Appendix A](#appendix-a-installing-openvoxdb-natively-on-the-same-host) is the
> short path for OpenVoxDB on the same host.

[OpenVox](https://github.com/openvoxproject) is Vox Pupuli's fork of Puppet —
`openvoxserver`, `openvoxdb` and `openvoxagent` replacing puppetserver, puppetdb
and puppet-agent. `openvoxdb` serves the same `/pdb/query/v4` API, identifies
itself as `PuppetDB`, and keeps `puppetdb-status` as its status service, so
every URL, certificate path and query in this guide applies unchanged.

This was verified rather than assumed: `openvoxdb 8.15.0` was checked against
`PuppetDB 7.10.0` for every AST operator NexusPuppet emits, every node field its
mappers read, the timestamp-or-null typing of `deactivated`/`expired`, and the
ordering and paging the reconciler depends on. Reproduce it with
`scripts/dev/openvox-stack.sh` then `scripts/dev/openvox-compat.sh`.

**If you run `openvoxdb` against your own PostgreSQL, create the `pg_trgm`
extension first.** openvoxdb will not start without it:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

This needs a superuser, so openvoxdb cannot do it itself, and the failure is
easy to misread: it aborts during schema migration, shuts down cleanly, and the
container reports only *unhealthy* — the actual reason sits above a Clojure
stack trace in the logs. The bundled `docker-compose.openvox.yml` handles it via
an init script; a managed or pre-existing database will not.

---

## 1. Get the code

```bash
sudo mkdir -p /opt/nexuspuppet && sudo chown "$USER" /opt/nexuspuppet
git clone <your-fork-or-mirror> /opt/nexuspuppet
cd /opt/nexuspuppet
```

Pin a tag in production rather than tracking `main`.

---

## 2. The enterprise layer is **not** a submodule

This is worth stating plainly because the instruction to "initialise the
submodule" will send you looking for something that deliberately does not exist.

There is **no `.gitmodules`, and there must never be one.** A submodule would
publish the private repository's URL inside the public repository and would
break `npm install` for every external contributor who cannot clone it. CI fails
the build if `.gitmodules` appears (ADR-0002). The private layer is fetched from
an environment variable and discovered at runtime:

```bash
# Core edition — skip this section entirely. This is the normal path.

# Enterprise edition — this section, and only this section, needs Node >= 22.12
# on the host. The core install needs nothing but Docker.
#
# The distribution's `nodejs` package is NOT new enough on Ubuntu 22.04 (it
# ships 12.x), and `enterprise:fetch` fails in ways that do not mention Node.
# Install a current one first:
#   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
#   sudo apt-get install -y nodejs
export NEXUSPUPPET_ENTERPRISE_REPO='git@github.com:yourorg/nexuspuppet-enterprise.git'
export NEXUSPUPPET_ENTERPRISE_REF=v1.0.0      # default: main
npm run enterprise:fetch                       # clones into packages/enterprise/
npm install
npm install ldapts --workspace @nexuspuppet/enterprise   # LDAP deployments only
```

> **`npm install` here is correct, and is the opposite of the rule on a
> development machine.** The root `workspaces` glob is `packages/*`, so on a
> checkout you commit from, installing with the enterprise layer present writes
> its dependencies into the public `package-lock.json` — and the
> `core-isolation` CI job asserts that package does not exist. On a DEPLOYMENT
> host nothing is ever committed, so there is no such hazard. Do not carry this
> instruction back to a dev checkout.

**That last line is needed again after every `npm install` that replaces
`packages/enterprise`** — a fresh clone, a new tag, another `enterprise:fetch`.
It is not a one-off.

`ldapts` is declared as an *optional peer* dependency, so an OIDC-only deployment
does not pull an LDAP client it will never use. The consequence is that
`npm install ldapts --workspace …` adds **no** entry to that package's
`dependencies` — npm treats the install as satisfying the peer — and it survives
in `package-lock.json` alone. Replace the package and the next `npm install`
reconciles the tree, finds nothing requiring an optional peer, and removes it.

The deployment then starts, loads the enterprise layer, reports `directory.ldap`
in `GET /capabilities`, and fails **every** LDAP login with:

```
The `ldapts` package is not installed, so LDAP authentication cannot run.
```

Loud and self-explaining, but after deploy rather than during build.

`npm run enterprise:fetch` with no repository set exits 0 with a notice and does
nothing. That is intended: the public pipeline runs it on every commit to prove
it is safe.

The URL belongs in `.env` or your secret store — never in a committed file. The
fetch script does not echo it, because CI logs get shared.

**Verifying which edition you are running:** `GET /capabilities` lists what this
deployment can do. Enterprise-only routes exist in the core build and return
`501` with a `capability` field, never `404` — the feature exists, this
deployment lacks it.

### Provision your directory accounts BEFORE you set `LDAP_URL` or `OIDC_ISSUER`

**Your local accounts keep working.** A directory provider is contributed
*alongside* core's local provider, never instead of it, and `authSource` on the
account decides which one handles a login ([ADR-0015](docs/architecture/adr/0015-hybrid-authentication.md)).
An attempt by the enterprise layer to override `AUTH_PROVIDER` is refused
outright. So `admin@example.com` signs in after the switch exactly as before.

> **This section used to say the opposite** — that enabling a directory locked
> every local account out with no way back. That was true before ADR-0015 and is
> the behaviour it was written to remove. The paragraph outlived the defect, was
> read as current, and produced at least one production upgrade plan built
> around a lockout that cannot happen. If you read it previously, that is why.

What is still true, and still catches people:

- **There is no auto-provisioning, and the refusal is silent.** A directory user
  with no row in `users` is rejected, and *nothing is logged* — the resolver
  looks the account up before choosing a provider, so a missing account and a
  wrong password are indistinguishable from the outside. This is deliberate
  (ADR-0015 §2: dispatch must not become a user-enumeration oracle), and it is
  the single most common cause of "LDAP is configured correctly and nobody can
  log in".

So the ordering below is about your **directory users** being able to sign in,
not about you being able to. Getting it wrong is an inconvenience you fix from a
console you can still reach.

**Do it in this order:**

```bash
# 1. Sign in as the bootstrap admin and create each directory account.
#    No password: a stored hash would keep the account usable through local auth
#    after the directory revoked access.
curl -s -b jar -X POST http://localhost:3001/users \
  -H 'content-type: application/json' \
  -d '{"email":"you@yourorg.com","displayName":"You","role":"VIEWER","authSource":"ldap"}'

# 2. Only now set LDAP_URL / OIDC_ISSUER in .env and restart.
```

The `role` you set here is a placeholder. Group mapping is authoritative and
overrides it at every login — an account stored as `VIEWER` whose group maps to
`ADMIN` signs in as `ADMIN`.

**If a directory user cannot sign in and you want to fix it from the database**
— you should not need to, since your local admin account still works and the
console is the supported path — the row can be inserted directly. This bypasses
the audit trail and is a recovery action, not a way to provision:

```bash
sudo docker compose exec -T db psql -U nexuspuppet -d nexuspuppet -c "
  INSERT INTO users (id, email, \"displayName\", role, \"isActive\", \"authSource\", \"createdAt\", \"updatedAt\")
  VALUES (gen_random_uuid(), 'you@yourorg.com', 'You', 'VIEWER', true, 'ldap', now(), now())
  ON CONFLICT (email) DO UPDATE SET \"authSource\" = 'ldap', \"isActive\" = true;"
```

**Every local account is already a break-glass administrator**, because the
local provider is supplemented rather than replaced ([ADR-0015](docs/architecture/adr/0015-hybrid-authentication.md) §3).
This paragraph previously said the opposite and pointed at
[ADR-0014](docs/architecture/adr/0014-enterprise-licensing.md) §3 as a future
fix; that need was met by ADR-0015. ADR-0014 §3's `LICENSE_GRACE_LOGIN` remains
relevant to a different case — an expired licence — and not to this one.

---

## 3. PuppetDB certificates

NexusPuppet authenticates to PuppetDB with mTLS and **only ever reads**
(ADR-0004). There is no write surface and none may be added.

### Issuing a client certificate

On the Puppet CA host:

```bash
puppetserver ca generate --certname nexuspuppet.internal
```

> **This command can print an error and still succeed. Judge it by the files.**
>
> `ca generate` creates a key, submits a certificate request, then fetches the
> signed certificate — and it reports the fetch failing even in cases where the
> certificate is issued moments later:
>
> ```
> Error: Signed certificate nexuspuppet.internal could not be found on the CA
> ```
>
> This has been seen on an autosigning CA that went on to print the success
> lines and issue a working certificate, so it is not a reliable signal of
> anything. Read the outcome from disk instead:
>
> | What exists | What it means |
> | --- | --- |
> | All three files below | Done. The error was noise. |
> | Key and public key only | The request was submitted and is **unsigned** |
>
> If it is unsigned — the normal state on a CA that requires a human, and what
> you should expect in production — sign it and run `ca generate` again:
>
> ```bash
> puppetserver ca sign --certname nexuspuppet.internal
> ```

That produces three files you need:

| File | Source path on the CA |
|---|---|
| `client.pem` | `/etc/puppetlabs/puppet/ssl/certs/nexuspuppet.internal.pem` |
| `client.key` | `/etc/puppetlabs/puppet/ssl/private_keys/nexuspuppet.internal.pem` |
| `ca.pem` | `/etc/puppetlabs/puppet/ssl/certs/ca.pem` |

### Three files share one filename — take the right one

`puppetserver ca generate` writes **three** files with the *same name* into three
directories, and only one of them is a certificate:

| Path | Contents | Copy it to |
| --- | --- | --- |
| `ssl/certs/<certname>.pem` | `BEGIN CERTIFICATE` | `client.pem` |
| `ssl/private_keys/<certname>.pem` | `BEGIN RSA PRIVATE KEY` | `client.key` |
| `ssl/public_keys/<certname>.pem` | `BEGIN PUBLIC KEY` | **nothing — never used** |

Taking `<certname>.pem` from `public_keys/` instead of `certs/` is the easiest
mistake in this whole procedure: same filename, adjacent directory, and the file
looks plausible. `./scripts/deploy.sh --check` names it if you do.

Confirm before copying, rather than after:

```bash
head -1 /etc/puppetlabs/puppet/ssl/certs/<certname>.pem   # BEGIN CERTIFICATE
```

### Installing them on the NexusPuppet VM

The container runs as **uid 100** (the image's `app` user), so `root:root`
ownership makes these files unreadable to it — a `0600 root:root` key inside a
`0700 root:root` directory produces `EACCES` and no inventory. Own them by uid:

```bash
# Transfer over SSH/scp first. Never paste key material into a chat window,
# an issue, or a CI variable that logs its value.
sudo install -d -m 0500 -o 100 -g root /etc/nexuspuppet/certs
sudo install -m 0444 -o 100 -g root client.pem ca.pem /etc/nexuspuppet/certs/
sudo install -m 0400 -o 100 -g root client.key /etc/nexuspuppet/certs/
```

> **Set the owner, not the group.** The container's group is gid 101, but on the
> *host* gid 101 is an unrelated system group whose identity varies by distro —
> `syslog` on one Ubuntu installation, `lxd` on another. `chown`ing an
> estate-wide PuppetDB key to it can hand that key to every human member of a
> group you never chose. Owning by uid alone avoids the question entirely.

The key stays unreadable to everyone but that uid. Compose mounts the directory
read-only, and the certificates are never baked into an image.

Confirm the container can actually read them before going further:

```bash
docker compose run --rm --entrypoint sh api -c 'head -c1 /etc/nexuspuppet/certs/client.key >/dev/null && echo readable'
```

### What this certificate can do — and what you cannot stop it doing

**You cannot restrict this certificate to reads.** PuppetDB has no per-certname
authorization for `/pdb/*` at all. Earlier versions of this guide said to grant
"query access only" in `auth.conf`; that was wrong, and an operator who followed
it believed they had read-only access when they did not.

Two mechanisms are commonly suggested. Neither works:

- **`auth.conf` does not apply to `/pdb/*`.** The trapperkeeper authorization
  service is wired only to the metrics endpoints — PuppetDB's own
  `bootstrap.cfg` says so in a comment. The shipped `auth.conf` ends with an
  explicit `deny: "*"` on path `/`, and queries succeed regardless.
- **`certificate-whitelist` is not a `jetty.ini` key.** Adding it there stops the
  service from starting with `{:certificate-whitelist disallowed-key}`, which is
  what an operator hits first, because `jetty.ini` is where the other TLS
  settings live.

  It belongs in **`config.ini`, under `[puppetdb]`** — and there it works. An
  earlier version of this section concluded from the `jetty.ini` failure that the
  mechanism had been removed after PuppetDB 6, and told operators that nothing
  could restrict access. That was wrong, and wrong in the dangerous direction:
  it described a mitigation as unavailable when it is available, effective, and
  two lines long. See "What to do instead" below.

Verified against OpenVoxDB 8.15.0, with the shipped `auth.conf` in place:

| Request | `client-auth = want` | `client-auth = need` |
| --- | --- | --- |
| `GET /pdb/query/v4/nodes`, no client certificate | **200** | TLS rejected |
| `GET /pdb/query/v4/nodes`, any CA-signed certificate | 200 | 200 |
| `POST /pdb/cmd/v1` `replace_facts`, any CA-signed certificate | **200** | **200** |

The command submissions were accepted *and persisted*: a node that does not
exist, carrying a fact that was never reported, appeared in the estate.

So the honest statement, **for a PuppetDB with no certname allowlist
configured**, is: any certificate the Puppet CA has ever signed — including every
agent in your estate — can read all of PuppetDB and write to it. `auth.conf` does
not change that, and NexusPuppet cannot.

A certname allowlist does change it, and configuring one is the first item below.
Verified on the same OpenVoxDB 8.15.0 server as the table above:

| Client certificate | With an allowlist configured |
| --- | --- |
| A certname on the list | 200 |
| Any other CA-signed certificate | **403** |

#### What to do instead

1. **Configure a certname allowlist.** This is the control that actually bounds
   who may talk to PuppetDB, and it is the one this section previously told you
   did not exist. In `/etc/puppetlabs/puppetdb/conf.d/config.ini`:

   ```ini
   [puppetdb]
   certificate-whitelist = /etc/puppetlabs/puppetdb/certificate-whitelist
   ```

   One certname per line in that file — your Puppet server(s), and the certname
   NexusPuppet presents. Restart PuppetDB. Anything else the CA has signed then
   gets a 403 rather than your whole estate.

   The name is the file's, not ours; OpenVoxDB still reads this key. Adding a
   client later means appending a line and restarting — so this is also the step
   to remember when a second NexusPuppet, a replica, or a new Puppet server
   appears and starts getting 403s that look like a certificate problem.
2. **Check `client-auth` in `jetty.ini`.** Some images ship `want`, which
   accepts requests with *no client certificate at all* — the first row above.
   Set `need`, then confirm there is exactly one such line:

   ```bash
   grep -c '^client-auth' /etc/puppetlabs/puppetdb/conf.d/jetty.ini   # must be 1
   ```

   `puppetdb ssl-setup` appends its own `client-auth = want` without checking
   for an existing entry, so running it after you have set `need` silently
   leaves two — and the file no longer says what you think it says.
3. **Restrict `/pdb/*` at the network layer.** A firewall rule or a reverse proxy
   is the only thing that actually bounds who can reach it. Do not publish port
   8081 beyond the hosts that need it, and do not publish the cleartext port 8080
   at all.
4. **Treat the NexusPuppet certificate as a full-access credential** when
   deciding where to store it and who can read the file.

Check your own estate rather than trusting the table above:

```bash
node scripts/dev/puppetdb-auth-probe.mjs
```

It reports whether PuppetDB answers a client presenting *no* certificate — the
first row, and the one worth knowing about tonight. Add `--prove-write` to settle
the write question too; read its header first, because that probe creates a node.

This one needs Node, which §0 does not ask for. Run it from any machine with a
checkout that can reach PuppetDB — it is a network probe, and the answers it
gives do not depend on running it from the NexusPuppet host.

> **Why this matters more for a classifier than for a dashboard.** NexusPuppet
> evaluates rules against facts it reads from PuppetDB. Anyone who can write
> facts can therefore decide what NexusPuppet classifies — inventing a node, or
> changing an existing one's `role`, changes which groups match it. Fact-write
> access is classification-write access, one step removed.
>
> This is also why authorization is decided in `api` *before* a query is built,
> and why the web tier never holds this certificate: the credential is
> estate-wide, so the API is a confused deputy by construction. Do not
> "simplify" by letting the browser talk to PuppetDB.

### Verifying before you deploy

```bash
curl --cert /etc/nexuspuppet/certs/client.pem \
     --key  /etc/nexuspuppet/certs/client.key \
     --cacert /etc/nexuspuppet/certs/ca.pem \
     'https://puppetdb.internal:8081/pdb/query/v4/nodes?limit=1'
```

Do this first. A cert problem discovered here takes a minute; discovered through
a container that will not start, an hour.

Once the image is built (§5), there is a fuller check that isolates each layer —
file permissions, TCP, TLS, authorisation, data, and the application's own
client — and names the one that failed:

```bash
docker compose run --rm api node scripts/test-puppetdb.mjs
```

**Run it from the container, not the host.** §0 asks only for Docker, so a host
that meets the stated requirements has no Node to run it with — and running it
inside means it uses the same uid, network position and certificate mounts as
the real client. A pass on the host and a failure in the container is exactly the
ownership problem described above, and only the containerised run will show it.

---

### Pointing at Active Directory

Four things that look like something else when they are wrong. All measured
against a live Windows Server 2025 DC.

- **Use the hostname, not the IP.** A DC certificate carries
  `SAN: DNS:dc01.example.com` and typically **no IP SAN**, so an `ldaps://<ip>`
  URL fails strict verification — which is the entire point of setting
  `LDAP_CA_PATH`. Give the container a resolver that can answer for the domain.
- **`extra_hosts` is not enough.** With a hosts entry present, `getent hosts`
  resolves inside the container while Node's `dns.lookup()` still returns
  `EAI_AGAIN`. What works is `dns: [<dc-ip>]` on the api service; Docker's
  embedded DNS still resolves compose service names and forwards the rest.
- **Delete `LDAP_SEARCH_FILTER`** if it came from an OpenLDAP example. AD has
  no `inetOrgPerson`, so every login fails while the URL and base DN look
  correct. The `ad` dialect supplies its own filter.
- **`.env` is a fallback, not a merge.** Once anything is saved through the
  console, `provider_settings` holds a row, the database wins, and every
  directory value in `.env` goes inert (ADR-0015 §4). `GET /settings/auth/ldap`
  reports which source is live — check it before editing a file.

### Pointing at Entra ID (OIDC)

**Filter the groups claim on the app registration.** Entra stops sending
`groups` once a user is in roughly 150 groups — 200 for implicit flows — and
refers the relying party to Microsoft Graph instead. NexusPuppet does not follow
that reference, so those users resolve to no groups and are refused.

The failure is upside down: the people in 150+ groups are senior
administrators, so it lands on the account being onboarded while ordinary users
sign in fine. Configure the registration to emit only the groups **assigned to
the application** — which is what the mappings use anyway, and stays under the
limit — or set `OIDC_DEFAULT_ROLE` to admit everyone at a floor role.

The refusal says so explicitly, naming the endpoint it was referred to, so it
does not read as a role-mapping problem.

**There is no auto-provisioning** (ADR-0015 §5): a directory user with no
NexusPuppet account is refused before the directory is ever asked. Create the
account first, with `authSource` set to the directory.

---

## 4. Configure `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Compose passes this entire file to the `api` container, so every key the
annotated template documents reaches the service. A handful must differ inside
the container — the database host, the certificate mount points, the ENC volume
path — and Compose sets those itself; the template marks each one.

Fill in — the annotated template explains every key:

```ini
NODE_ENV=production

POSTGRES_USER=nexuspuppet
POSTGRES_PASSWORD=<generated>
POSTGRES_DB=nexuspuppet
DATABASE_URL=postgresql://nexuspuppet:<generated>@db:5432/nexuspuppet?schema=public

JWT_SECRET=<openssl rand -base64 48>
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=30d

BOOTSTRAP_ADMIN_EMAIL=you@yourorg.com
BOOTSTRAP_ADMIN_PASSWORD=<generated, discarded after first login>

PUPPETDB_URL=https://puppetdb.internal:8081
PUPPETDB_CERT_DIR=/etc/nexuspuppet/certs
PUPPETDB_TIMEOUT_MS=10000
PUPPETDB_PROJECTION_INTERVAL_MS=300000

ENC_OUTPUT_DIR=/srv/nexuspuppet/enc
ENC_DEFAULT_ENVIRONMENT=production
```

Four things that bite:

**`JWT_SECRET` has no default and the API refuses to boot without it.** That is
deliberate — a development fallback secret is exactly the kind of thing that
reaches production. Do not add one.

**`PUPPETDB_PROJECTED_FACTS` is an allow-list, and a rule referencing a fact
outside it can never match.** Full fact blobs are unbounded, so only these are
projected for rule evaluation. Add the custom facts *your* estate reports —
`role`, `profile` and `tier` are what operators typically write rules against,
but only if a module on your nodes actually supplies them:

```ini
PUPPETDB_PROJECTED_FACTS=role,profile,tier,datacenter,location,application,tenant,cluster,trusted,clientcert,fips_enabled,os,kernel,kernelrelease,timezone,system_uptime,networking,processors,memory,virtual,is_virtual,dmi,disks
```

**Add only facts your nodes actually report.** A name nothing reports is not
inert — every rule written against it silently matches nothing, and the group
looks identical to one whose rules legitimately match nothing. `fqdn`, `domain`
and `role` were in this default until they were checked against real estates:
Facter 4 dropped the legacy flat facts, so an OpenVox or Puppet 8 agent reports
31 top-level facts where puppet-agent 7.20 reports 113. Use `networking.fqdn`
and `networking.domain`, which resolve on both.

Two things will tell you: the API logs, once per start, any projected fact that
no node reports; and `npm run test:puppetdb` names them against a sampled node.
The rule editor also warns when a rule references an unprojected path, but only
after you have written the rule.

**`API_INTERNAL_URL` is deliberately not `NEXT_PUBLIC_`.** The browser must never
receive an API address, a database credential, or a certificate. It calls
same-origin `/api/*`, which the web tier relays server-side (ADR-0008).

**`BOOTSTRAP_ADMIN_*` only seeds an empty users table.** Once a user exists it is
ignored. Remove both lines after first login.

---

### Certificate installation from the console (optional)

Setting `CERT_HELPER_SECRET` enables the **Install certificate** form on the
Settings page. Without it the form is not offered — the console reports the
capability rather than presenting a button that can only fail.

```bash
# Shared by the api (which signs installation grants) and the cert-helper
# (which verifies them). Not key material: it authorises an upload.
echo "CERT_HELPER_SECRET=$(openssl rand -base64 48)" >> /opt/nexuspuppet/.env

# The cert-helper WRITES to the TLS directory; every other service only reads.
# It runs as uid 100, so the directory and its contents must be owned by it.
# The proxy keeps its own read-only mount, so this does not widen who can read
# the key — it changes which single account owns it.
sudo chown -R 100:101 /etc/nexuspuppet/tls
```

The helper refuses to start if it cannot write there, naming this command, rather
than failing halfway through an operator's first certificate installation.

**Point `CONSOLE_TLS_CERT_PATH` through `live/`.** The Console certificate card
reads that path directly, so a path naming a fixed file keeps reporting the
certificate that was there when the deployment was set up — an operator installs
a new one, the install confirms, and the card above the form still shows the old
expiry. Mount and name the symlinked copy instead:

```yaml
# docker-compose.override.yml, api service
volumes:
  - /etc/nexuspuppet/tls/live/console.pem:/etc/nexuspuppet/console.pem:ro
```

The api still receives a single public file and never the directory holding the
key (ADR-0013 §2); it is simply the file that moves with each install.

**Order matters on upgrade.** Start `cert-helper` BEFORE reloading the proxy. The
shipped Caddyfile now reads `live/console.pem`, and the helper is what creates
that link by adopting the files already in place. Starting the proxy first points
it at a path that does not exist yet.

```bash
docker compose --profile tls up -d cert-helper   # adopts, creates live/
docker compose --profile tls up -d proxy
```

Adoption copies rather than moves, so `console.pem` and `console.key` stay where
they are and rolling back to the previous release still works.

## 5. Build, migrate, start

```bash
docker compose build
docker compose up -d db
docker compose run --rm api npx prisma migrate deploy    # before starting api
docker compose up -d
docker compose ps
```

**The published ports bind to `127.0.0.1` by default.** Neither service
terminates TLS, so until §7 is done, reaching the console from another machine
would put the login over the wire in cleartext. Use an SSH tunnel while
commissioning:

```bash
ssh -L 3000:127.0.0.1:3000 <vm>      # from your workstation
```

Once a TLS reverse proxy is in front of it, either leave the bind on loopback
and have the proxy reach it there (best, if the proxy runs on the same host), or
set `WEB_BIND=0.0.0.0` in `.env` and restrict access at the firewall.

Run migrations as a separate step rather than on container start. An automatic
migrate-on-boot turns a rollback into a data problem.

Confirm:

```bash
curl -fsS http://localhost:3001/healthz          # {"status":"ok"}
curl -fsS http://localhost:3001/capabilities     # edition and features
docker compose logs api | grep -i 'projection\|puppetdb'
```

### First login

Sign in at `http://localhost:3000` — through the tunnel above, or on the VM
itself — with the bootstrap credentials, then rotate immediately, **in the
console**: *Settings → Change password*.

That goes through `POST /account/password`, which verifies the old password,
writes the audit row, and revokes every other session in one transaction. Choose
the new password in your password manager and let it store the value; nothing on
the host needs a copy.

Then remove `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` from `.env`
and `docker compose up -d api` to pick that up. They only ever seed an empty
users table, but there is no reason to leave a working credential in a file.

> **Not `scripts/dev/rotate-admin-password.mjs`.** Earlier versions of this guide
> pointed here at that script. It needs Node on the host, which §0 does not ask
> for, so on a correctly-provisioned server the documented rotation step could
> not be run at all. It also writes the new password to
> `~/.nexuspuppet/admin-password` — a development convenience, and the wrong
> thing to create on a production host. It remains useful for local development
> and for scripting a rotation from a workstation that has a checkout.

---

## 6. Wiring puppetserver

This is the step where a deployment most often goes wrong, and the failure is
quiet: catalogs compile, nodes just get the default classification.

### Do this first — the short version

On the **NexusPuppet** host, turn the ENC listener on and let the Puppet server
in, then redeploy:

```bash
cat >> .env <<'EOF'
ENC_REPLICATION_ENABLED=true
ENC_REPLICATION_ALLOWED_CERTNAMES=puppet.example.com   # your Puppet server's certname
EOF
./scripts/deploy.sh
```

`deploy.sh` then prints the exact next command, and — if you are at a terminal —
offers to run it for you over SSH. Taking the offer is the whole of the rest of
this section.

If you would rather run it yourself, from **your workstation**, with nothing to
clone on the Puppet server:

```bash
./scripts/setup-enc.sh --remote you@puppet.example.com \
    --origin https://nexuspuppet.example.com:8443 --wire
```

Or **on the Puppet server** directly, from a checkout of this repo:

```bash
cd nexuspuppet/scripts
sudo ./setup-enc.sh --check --origin https://nexuspuppet.example.com:8443   # look before you leap
sudo ./setup-enc.sh --origin https://nexuspuppet.example.com:8443           # install
sudo ./setup-enc.sh --origin https://nexuspuppet.example.com:8443 --wire    # put it on the compile path
```

### What `--remote` does, and what it deliberately does not

It copies the ENC scripts and their systemd units to the Puppet server over
**your own SSH session**, runs the same checks and installation there, and
removes the copy afterwards — successful or not.

It **writes no key, touches no `authorized_keys`, and leaves no channel behind.**
This matters: a standing root credential from the console host to your Puppet
server would mean that compromising the console yields the entire estate. That
is a much worse trade than the convenience is worth, so the SSH access is yours,
interactive, and gone when the command finishes.

**This is not the runtime dependency ADR-0003 forbids.** That rule governs the
running product: the API must never reach into `puppetserver` while a catalog
compiles. `--remote` is an installer, driven by an operator, once. When it is
done the compile path is still `cat` on a local file, with no NexusPuppet
process in it — which is exactly what makes agent runs survive this console
being down.

`--check` verifies the certificates, that the origin will actually serve *this*
certname, and that no other classifier is already installed. The plain run
installs the puller and the ENC script, fetches the tree, and **serves a node as
puppetserver would** — but changes nothing about how catalogs are compiled.
`--wire` is the step that does, and it is separate on purpose: with
`node_terminus = exec` there is no fallback to `site.pp`, so an ENC script that
cannot run fails compilation for every node. Add `--receipts` to have compiles
report back (ADR-0022).

Re-running is safe and is the normal upgrade path — existing settings in
`/etc/default/nexuspuppet-*` are preserved, and `puppet.conf` is not touched
without `--wire`.

**Why there is no single command that does both halves.** Nothing may make
Puppet depend on NexusPuppet at runtime, so there is no channel from the console
into your Puppet server, and there will not be one. The Puppet-server half is
yours to run, on that host.

The rest of this section is the reference: what each piece does, and what to
check when something is wrong. You do not need to read it to get this working.

### The rule that governs everything here

**Nothing may make Puppet depend on NexusPuppet at runtime** (ADR-0003).
NexusPuppet writes YAML to a directory; puppetserver reads it with a
dependency-free `cat`. No HTTP call, no interpreter beyond `/bin/sh`, no
NexusPuppet process involved. If this console is down, agent runs continue
unaffected. Do not "improve"
[`scripts/nexuspuppet-enc.sh`](scripts/nexuspuppet-enc.sh) into an API
client.

### Getting the directory to puppetserver

The compose file defines a named volume, `enc-data`. **That only works if
puppetserver runs on this same Docker host.** It usually does not. Pick one:

| Layout | How the ENC directory travels | Notes |
|---|---|---|
| Same host, **puppetserver in Docker** | The `enc-data` named volume, mounted `:ro` | Simplest. Uncomment the reference block in `docker-compose.yml` |
| Same host, **puppetserver native** | Bind-mount a host path, e.g. `/srv/nexuspuppet/enc`, owned by uid 100 | The named volume does **not** work here — see below. For the full small-deployment walkthrough see [Co-locating on the Puppet server](#co-locating-on-the-puppet-server-small-deployments) |
| Separate puppetserver VM | **Replication** — NexusPuppet serves the tree, a timer on puppetserver pulls it (ADR-0019) | Recommended. See below |
| Separate puppetserver VM | Bind-mount `ENC_OUTPUT_DIR` to a host path exported over **NFS**, mounted read-only on puppetserver | Works, but puts another host's availability into catalog compilation — if this host goes down the mount hangs and every compile blocks, which is the failure ADR-0003 exists to prevent |
| Separate VM, no shared FS | `rsync` the tree on a timer | Adds propagation delay. The directory is self-consistent — files are written atomically via tmp+fsync+rename — but rsync mid-write can still ship a partial *set*. Use `--delay-updates` |

**Why a native puppetserver cannot use the named volume.** Docker keeps volume
data under `/var/lib/docker`, which is mode `0710 root:root`. The `puppet` user
cannot traverse it, so the path is unreachable no matter how the ENC files
themselves are permissioned — they are `0644` in `0755` directories and perfectly
readable, if you could get to them:

```console
$ namei -lx /var/lib/docker/volumes/nexuspuppet_enc-data/_data
drwxr-xr-x root root /
drwxr-xr-x root root var
drwxr-xr-x root root lib
drwx--x--- root root docker
                     volumes - Permission denied
```

Do not fix this by loosening `/var/lib/docker`. Use a bind mount — this repo
ships the override as a template:

```bash
cp docker-compose.native-enc.example.yml docker-compose.override.yml
sudo install -d -m 0755 -o 100 -g root /srv/nexuspuppet/enc
sudo ln -s /srv/nexuspuppet/enc /etc/puppetlabs/nexuspuppet
```

Read it before using it — it needs the PuppetDB hostname edited, and it explains
why `!override` is on the volume list (without it Compose merges the two and you
get the named volume *and* the bind mount on the same target, with no indication
of which won).

Whichever you choose, the mount on puppetserver is **read-only**. The API is the
only writer. A second writer breaks the content-hash change detection that keeps
a no-op from becoming estate-wide file churn.

### Co-locating on the Puppet server (small deployments)

One host, one Puppet server, a handful of nodes: there is often nothing else to
put NexusPuppet on. This works, and it is the layout with the fewest moving
parts — no replication, no second certificate, no propagation delay. What
follows was walked end to end on a 4-vCPU / 6 GB OpenVox 8 host; the numbers are
measured, not estimated.

**It does not weaken ADR-0003.** The compile path is still `cat` on a local
file. Stop every NexusPuppet container and agent runs continue against the tree
already on disk. What co-location *does* add is a resource coupling: the console
now competes with two JVMs for RAM on the box whose availability your whole
estate depends on. That is the trade, and it is why the footprint is measured
below rather than waved at.

**Survey the host first.** The two collisions that matter:

```bash
sudo ss -ltnp | awk '{print $4}' | sort -u   # 8140 and 8081 are Puppet's
free -m; df -h /
```

PuppetDB's own PostgreSQL already holds `127.0.0.1:5432`. NexusPuppet's `db`
container does not publish a port, so the two coexist untouched — but if you
publish it for a debugging session, that is the clash you will hit. `80`, `443`,
`3000`, `3001` and `8443` were free on a stock OpenVox host.

**Reuse the node's own certificate.** This is the step co-location makes
disappear. Section 3 has you issue a client certificate and add it to PuppetDB's
allowlist. On the Puppet server itself, a certificate that PuppetDB already
trusts is sitting on disk — the host's own agent certificate, whose certname is
in `/etc/puppetlabs/puppetdb/certificate-whitelist` because the node reports to
itself:

```bash
sudo install -d -m 0500 -o 100 -g 101 /etc/nexuspuppet/certs
CN=$(sudo /opt/puppetlabs/bin/puppet config print certname)
sudo install -m 0444 -o 100 -g 101 /etc/puppetlabs/puppet/ssl/certs/$CN.pem         /etc/nexuspuppet/certs/client.pem
sudo install -m 0400 -o 100 -g 101 /etc/puppetlabs/puppet/ssl/private_keys/$CN.pem  /etc/nexuspuppet/certs/client.key
sudo install -m 0444 -o 100 -g 101 /etc/puppetlabs/puppet/ssl/certs/ca.pem          /etc/nexuspuppet/certs/ca.pem
```

Copy, do not symlink: the container reads these as uid 100 and `/etc/puppetlabs/puppet/ssl/private_keys` is not traversable by it. Copying also means a `puppet ssl clean` cannot pull the console's credential out from under it.

Read section 3's "What this certificate can do" before you do this. Reusing the
agent certificate gives the console the same estate-wide PuppetDB read the agent
has — which is what any NexusPuppet client certificate grants — but it now
shares an identity with the node, so revoking one revokes the other.

Point `.env` at it by IP, not by name, unless the server certificate carries a
DNS SAN you can resolve **from inside a container**:

```ini
PUPPETDB_URL=https://<puppet-server-ip>:8081
PUPPETDB_CERT_DIR=/etc/nexuspuppet/certs
ENC_REPLICATION_ENABLED=false
API_BIND=127.0.0.1
WEB_BIND=127.0.0.1
```

`ENC_REPLICATION_ENABLED=false` is the point of co-locating: there is nothing to
replicate to, and a Puppet server should advertise Puppet's ports and nothing
else. Keep both binds on loopback and reach the console over an SSH tunnel or
the bundled TLS proxy (section 7) — co-location must not quietly add a public
web listener to a Puppet server.

**Unless you want compile receipts.** Those are uploaded to the ENC listener,
because that is where the client certificate proves which Puppet server is
reporting (ADR-0022 §4). A co-located deployment that wants them runs the
listener bound to loopback, reachable by nothing but itself:

```ini
ENC_REPLICATION_ENABLED=true
ENC_REPLICATION_BIND=127.0.0.1
ENC_REPLICATION_ALLOWED_CERTNAMES=<this host's certname>
```

`ENC_REPLICATION_ENABLED` means **the ENC listener is running** — serving trees,
accepting receipts, or both. What it is exposed to is decided by the bind
address and the allowlist, not by the flag. The name is narrower than the
meaning; see `CONTEXT.md`.

Choose the bind address for what this host serves, not by copying a value. A
host that also serves remote pullers must keep binding publicly; only a host
that serves nobody but itself may bind to loopback.

**Then the ordinary path**, with the ENC bind mount from the previous section
and the schema created *before* first start — the API bootstraps its admin
account on boot and exits if the tables are not there:

```bash
cp docker-compose.native-enc.example.yml docker-compose.override.yml
sudo install -d -m 0755 -o 100 -g root /srv/nexuspuppet/enc
docker compose build
docker compose run --rm api npx prisma migrate deploy   # BEFORE up
docker compose up -d
```

Skip the migrate and the API restart-loops on `The table public.users does not
exist`, which reads like a broken image and is really an empty database.

**Verify as the user that will actually read the tree** — root can read
anything, so testing as root proves nothing:

```bash
sudo -u puppet /usr/local/bin/nexuspuppet-enc.sh $(sudo /opt/puppetlabs/bin/puppet config print certname)
```

Expect YAML and exit 0.

**What it costs.** Measured with three containers idle against a one-node
estate:

| | |
|---|---|
| RSS, all three containers | ~146 MB (api 78, web 40, db 28) |
| Disk, images | ~1.4 GB |
| Disk, build cache after one build | ~2.4 GB — `docker builder prune` reclaims it |

The steady-state memory is small enough to sit beside puppetserver and PuppetDB
on 6 GB. The **build** is the part to watch: it is the heaviest thing that will
ever run on that host, and an OOM there takes puppetserver with it. On a host
with less than ~2 GB free, build the images elsewhere and ship them
(`docker save` / `docker load`) rather than building in place.

Installing Docker rewrites the host firewall rules. Confirm Puppet survived it
before going further — on a Puppet server this is the check people skip:

```bash
systemctl is-active puppetserver puppetdb
```

**Compile receipts** (ADR-0022) work in this layout, with one component to
install that a replicated deployment gets for free.

The tree names itself: the materializer writes `.revision` alongside the
documents, using the same identity the replication endpoint would serve as an
ETag — so a receipt means the same thing whether the tree was materialized
locally or pulled from another instance. The ENC script appends receipt lines as
it serves.

Co-located, nothing writes them until you install the collector. The receipts
directory is what makes the compile path's append succeed, and it is created by
`nexuspuppet-receipts.sh` — which is also what drains it. Without the collector
there is no directory, every append fails silently, and the compile is served
correctly with nothing to show for it.

Install it, and the loopback listener above:

```bash
sudo install -m 0755 scripts/nexuspuppet-receipts.sh /usr/local/bin/
sudo install -m 0644 deploy/systemd/nexuspuppet-receipts.* /etc/systemd/system/
sudo install -m 0644 deploy/systemd/nexuspuppet-receipts.env.example \
  /etc/default/nexuspuppet-receipts
# Co-located: point it at your own listener, by CERTNAME not by IP — the
# name has to match the certificate.
sudo sed -i 's|^#NEXUSPUPPET_RECEIPTS_URL=.*|NEXUSPUPPET_RECEIPTS_URL=https://'"$(sudo /opt/puppetlabs/bin/puppet config print certname)"':8443/enc-receipts|' \
  /etc/default/nexuspuppet-receipts
sudo systemctl enable --now nexuspuppet-receipts.timer
```

One more line is required, and it is the one that is easy to miss:

```bash
CN=$(sudo /opt/puppetlabs/bin/puppet config print certname)
echo "NEXUSPUPPET_RECEIPTS_RESOLVE=${CN}:8443:127.0.0.1" \
  | sudo tee -a /etc/default/nexuspuppet-receipts
```

The URL must name the **certname**, because mTLS verifies the hostname against
the certificate — and that name resolves to this host's LAN address, where the
loopback-bound listener is not. `NEXUSPUPPET_RECEIPTS_RESOLVE` verifies the name
and connects to loopback, which is what `curl --resolve` is for. Without it the
collector reports `curl 7` and keeps the receipts: correct, and it gets you
nowhere.

Do **not** solve this with an `/etc/hosts` entry pointing the Puppet server's
own certname at `127.0.0.1`. It is a global change on a host whose agent
resolves that same name to reach its master.

The collector presents this node's own agent certificate, which the co-located
origin already trusts — no new certificate, and nothing to add to an allowlist
beyond the certname you set in `ENC_REPLICATION_ALLOWED_CERTNAMES` above.

Confirm it end to end:

```bash
sudo systemctl start nexuspuppet-receipts.service
sudo journalctl -u nexuspuppet-receipts -n 5 --no-pager
# handed over N compile receipt(s)
```

### Replicating the tree to a separate puppetserver (ADR-0019)

The NexusPuppet side. The puller is documented with the sync script it ships
with.

**This is not an ENC endpoint.** The compile path is unchanged — the ENC script
still reads a local file, with no process, network, or interpreter beyond
`/bin/sh` in it. What is added is an out-of-band fetch on its own schedule. Stop
NexusPuppet and the last synced tree is still on disk; catalogs still compile.
The test any future change must pass is *can catalog compilation fail because
NexusPuppet is unavailable?* — and the answer must stay no.

In `.env`:

```ini
ENC_REPLICATION_ENABLED=true
ENC_REPLICATION_ALLOWED_CERTNAMES=puppet.corp.local
```

That is the whole configuration. The endpoint is served with the **PuppetDB
client certificate you already mounted** in §3, and verifies pullers against the
**same Puppet CA**. Nothing new is issued, distributed or rotated: a Puppet
agent certificate carries both `serverAuth` and `clientAuth`, so the certificate
NexusPuppet uses to *call* PuppetDB is equally able to *serve* this.

> **The allowlist is the security control, not the certificate.** The Puppet CA
> signs every agent in your estate, so a valid client certificate proves only
> that the caller is one of your nodes. The tree contains how the entire estate
> is classified. Without the allowlist, any node holding an agent certificate
> could read all of it — the same confused-deputy shape as the PuppetDB
> certificate in §3, and it is bounded the same way, by naming who may ask.
>
> An empty list serves nobody, and the API refuses to open the listener at all
> rather than presenting a port that rejects every caller.

Verify from the Puppet server, using its own certificates:

```bash
curl -sv --cert /etc/puppetlabs/puppet/ssl/certs/$(puppet config print certname).pem \
        --key  /etc/puppetlabs/puppet/ssl/private_keys/$(puppet config print certname).pem \
        --cacert /etc/puppetlabs/puppet/ssl/certs/ca.pem \
        https://nexuspuppet.internal:8443/enc-tree.tar -o /tmp/tree.tar
tar -tf /tmp/tree.tar
```

| What you see | What it means |
|---|---|
| `200`, an `ETag`, a readable tar | Working |
| Connection closed during handshake | The client certificate was missing, expired, or signed by a different CA |
| `403` | The chain verified, but this certname is not in `ENC_REPLICATION_ALLOWED_CERTNAMES` |
| `404` | Reached the listener at the wrong path — the tree is at `/enc-tree.tar` |
| Connection refused | `ENC_REPLICATION_ENABLED` is not `true`, or the allowlist is empty so no listener was opened. Check the API log, which says which |

Send the `ETag` back as `If-None-Match` on the next poll and an unchanged tree
answers `304` with no body — which is what most polls will be.

Every fetch is recorded against the certname that made it, so the console can
say whether classification is actually reaching the Puppet server. Materialized
is not the end of the sentence; replicated is.

#### Installing the puller, on the Puppet server

Three files and one `systemctl`. Nothing long-lived runs: a timer starts a
short script, which exits.

```bash
sudo install -m 0755 scripts/nexuspuppet-sync.sh /usr/local/bin/
sudo install -m 0644 deploy/systemd/nexuspuppet-sync.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/nexuspuppet-sync.timer   /etc/systemd/system/
sudo install -m 0644 deploy/systemd/nexuspuppet-sync.env.example /etc/default/nexuspuppet-sync
sudoedit /etc/default/nexuspuppet-sync      # set NEXUSPUPPET_SYNC_URL

sudo systemctl daemon-reload
sudo systemctl start nexuspuppet-sync.service   # run it once, watch it work
sudo systemctl enable --now nexuspuppet-sync.timer
```

It needs `sh`, `curl`, `tar` and GNU `mv -T` — all already on a puppetserver
host. Nothing is installed, and no interpreter is added to a box that is often
tightly controlled.

> **On Puppet Enterprise, change `SupplementaryGroups=puppet` to `pe-puppet`.**
>
> If the unit fails with `status=216/GROUP` and *"Failed to determine
> supplementary groups: No such process"*, that is systemd saying **the named
> group does not exist on this host** — not that a process is missing. On a
> host with no Puppet installed at all, clear the directive with a drop-in
> (`SupplementaryGroups=`); the grant exists only to read the Puppet private
> key.
> The unit drops every capability, including `CAP_DAC_OVERRIDE` — the only
> reason root can normally read a file it does not own. The Puppet server's
> private key is `0640 puppet:puppet`, so the unit joins that group instead of
> being handed a capability that would let it read every file on the host. Get
> the group wrong and it fails with `cannot read …/private_keys/<certname>.pem`.

**If `/etc/puppetlabs/nexuspuppet` is currently a real directory**, the first
run replaces it with a symlink. Move it aside first if you want the old copy:

```bash
sudo mv /etc/puppetlabs/nexuspuppet /etc/puppetlabs/nexuspuppet.pre-sync
```

**What it does.** Fetches, extracts to a staging directory, and swaps a symlink:

```
/etc/puppetlabs/nexuspuppet -> /var/lib/nexuspuppet-sync/trees/<etag>
```

The swap is a single `rename(2)`, so a compile running at that instant sees
either the whole old tree or the whole new one — never a mixture. That is
stronger than `rsync --delay-updates`, which narrows the partial-set window
rather than closing it.

**It fails to stale, never to broken.** Every error path leaves the current
tree exactly where it is and exits non-zero so `systemctl status` shows it:

| Situation | What happens |
|---|---|
| Nothing changed | `304`, exits 0, silent. Most runs |
| NexusPuppet unreachable | Logged, exits 1, **tree untouched** — nodes keep their classification |
| Certificate refused | Exits 1 naming `ENC_REPLICATION_ALLOWED_CERTNAMES` |
| Archive has no `default.yaml` | Refused. Without it every unknown node becomes a failed compile rather than a default classification |
| Tree lost more than half its nodes | Refused, and says so. See below |

> **The shrink guard.** A truncated fetch and a genuinely emptied estate look
> identical from the Puppet server, and installing the wrong one drops every
> node to `default.yaml` — an estate-wide declassification with no single log
> line to explain it. This is the same reasoning that stops
> `NodeProjectionService` pruning on a small PuppetDB response. Raise or
> disable it with `NEXUSPUPPET_SYNC_MAX_SHRINK_PERCENT` only when the estate
> really is shrinking that fast.

#### Compile receipts (ADR-0022)

The sync script writes `.revision` into every tree it installs — the server's
ETag verbatim — and `nexuspuppet-enc.sh` appends one line per compile:

```
<revision> <certname>
```

Those lines are carried back and discarded once accepted, which is what turns
"did this node get my change?" into an equality check on a revision instead of
arithmetic on two hosts' clocks.

**Carried back by `nexuspuppet-receipts.sh`**, on its own timer (ADR-0022 §13).
Receipts are not replication: a NexusPuppet co-located with puppetserver has no
puller, and while the hand-over lived in the sync script that layout could not
collect them at all. One collector now serves both.

`nexuspuppet-sync.sh` still knows how to do it, for one release, so that
upgrading the script without installing the collector does not silently end
collection. It defers to whichever collector stamped `receipts/.collector`
within the last hour, and resumes if that stops — deferring forever to something
that is no longer running is the failure being avoided. You will see this once
per boot in `systemctl status nexuspuppet-sync`:

```
nexuspuppet-sync: compile receipts are being handled by nexuspuppet-receipts.sh;
this script is leaving them alone
```

Install it alongside the sync unit; a replicated host needs no configuration of
its own, because the collector reads `/etc/default/nexuspuppet-sync` for the URL
and certificates:

```bash
sudo install -m 0755 scripts/nexuspuppet-receipts.sh /usr/local/bin/
sudo install -m 0644 deploy/systemd/nexuspuppet-receipts.* /etc/systemd/system/
sudo systemctl enable --now nexuspuppet-receipts.timer
```

**It needs one thing from you: the group puppetserver runs as.** The receipts
directory is created `0770 root:<group>` so the puppetserver user can append and
this script can rotate. It defaults to `puppet`; on Puppet Enterprise set:

```bash
# /etc/default/nexuspuppet-sync
NEXUSPUPPET_SYNC_RECEIPTS_GROUP=pe-puppet
```

Get it wrong and the only symptom is silence — the compile path is forbidden
from complaining, because a catalog must never fail over bookkeeping. So the
sync script says it instead, on every run:

```
nexuspuppet-sync: warning: group 'puppet' does not exist or cannot be assigned
to /var/lib/nexuspuppet-sync/receipts; compile receipts are disabled.
```

**Receipts are droppable, and the script will drop them.** They are capped at
`NEXUSPUPPET_SYNC_MAX_RECEIPTS` (20000) oldest-first, one failed generation is
retained and merged into the next attempt, and a NexusPuppet that answers `404`,
`405` or `501` — one that predates this feature — has them discarded rather than
accumulated. A week-long outage must not become a disk-full incident on a Puppet
server; that is a worse failure than the visibility it was protecting.

Classification and catalogs are not droppable. This is the one of the three
where losing data is the correct trade.

**Rolling back** is one command, because the previous trees are kept:

```bash
ls -1dt /var/lib/nexuspuppet-sync/trees/*/          # newest first
sudo ln -sfn /var/lib/nexuspuppet-sync/trees/<etag> /etc/puppetlabs/nexuspuppet
```

**The timer is not ordered before puppetserver, and puppetserver does not
require it.** That dependency line is the architecture: puppetserver reads the
tree already on disk and must start, and keep compiling, whether or not this
unit has ever run or ever succeeded.

Five minutes, jittered by up to a minute, against an agent run interval of
thirty. A shorter interval optimises a gap nobody can observe — classification
is consumed on the agents' schedule, not this one.

### On the puppetserver host

```bash
sudo install -m 0755 nexuspuppet-enc.sh /usr/local/bin/nexuspuppet-enc.sh
```

```ini
# /etc/puppetlabs/puppet/puppet.conf
[server]
node_terminus  = exec
external_nodes = /usr/local/bin/nexuspuppet-enc.sh
```

> **DO NOT DO THIS ON PUPPET ENTERPRISE.** PE ships its own node classifier —
> `node_terminus = classifier`, backed by the PE console — and that classifier
> is how PE manages *itself*: `pe_repo`, agent configuration, the infrastructure
> node groups it created at install time. Pointing `node_terminus` at this ENC
> replaces it wholesale, and those classes stop being applied to every node
> including PE's own infrastructure.
>
> There is no merge between the two. `node_terminus` names exactly one
> classifier, so this is a swap, not an addition.
>
> Open-source Puppet and OpenVox have **no** built-in classifier — the default is
> `plain`, and classification comes from `site.pp` and hiera, which continue to
> apply alongside an ENC. That is the case this guide is written for. Check
> which you have before touching the setting:
>
> ```bash
> puppet config print node_terminus --section server   # `classifier` means PE
> dpkg -l | grep -c '^ii  pe-'                          # non-zero means PE
> ```

> **`[server]`, not `[master]`.** Puppet 8 and OpenVox 8 renamed the section.
> `[master]` is still honoured as a deprecated alias, so a hand-edit using the
> old name works and gives no hint that it is obsolete — and `puppet config set
> --section master` quietly writes `[server]` anyway, so the file will not match
> what you typed. This guide said `[master]` until an OpenVox 8.15 install was
> walked end to end.

If the directory is not at the default `/etc/puppetlabs/nexuspuppet`, set
`NEXUSPUPPET_ENC_DIR` in puppetserver's environment.

### Verify before restarting puppetserver

```bash
ls /etc/puppetlabs/nexuspuppet/default.yaml          # must exist
/usr/local/bin/nexuspuppet-enc.sh web01.example.com  # must emit valid YAML
```

`default.yaml` is written at bootstrap by the reconciler and is guaranteed to
exist before puppetserver can ask for an unknown node. If it is missing, the
volume is not mounted — fix that before restarting puppetserver.

The script's failure modes are deliberate:

- **Known node** → its YAML
- **Unknown / not yet materialized** → `default.yaml`, a defined safe
  classification rather than a compilation failure
- **Directory missing or empty** → exit non-zero, which **fails catalog
  compilation** for that node

That last one is deliberate, and it is not a soft failure. The `exec` node
terminus has no fallback: a non-zero exit is an error, and Puppet does not fall
back to `site.pp` node definitions. Affected agents stop applying anything until
the directory is reachable again.

That is still the behaviour to want. The alternative — exiting 0 with empty
classification — hands every agent an empty catalog, and an empty catalog does
not mean "change nothing"; with `purge` resources in play it means *remove
things*. A visible outage on some nodes beats a silent one across the estate.
But size the monitoring accordingly: this failure mode stops Puppet runs.

Then restart puppetserver and watch the first agent run end to end.

---

## 7. Put TLS in front of it

The web tier serves plain HTTP on 3000. Something must terminate TLS in front of
it before anyone uses this console in earnest — session cookies are `HttpOnly`
with the refresh token scoped to `/api/auth`, and they need a secure context to
behave correctly in current browsers. Bare HTTP is a functional limitation, not
a missing padlock.

Two supported paths. Both leave `API_BIND` on loopback: the API is reached
through the web tier's server-side relay and should never be published.

### Option A — the bundled proxy (ADR-0013)

For estates that do not already run a reverse proxy. Your Puppet or OpenVox CA
issues the certificate; nothing needs procuring.

```bash
# 1. Issue a certificate for the name people will type in the browser.
sudo puppetserver ca sign --certname console.example.com   # if not autosigned
sudo puppetserver ca generate --certname console.example.com

# 2. Put the pair where the proxy can read it, as console.pem / console.key.
sudo install -d -m 0755 -o 0 -g 0 /etc/nexuspuppet/tls
sudo install -m 0444 -o 0 -g 0 /etc/puppetlabs/puppet/ssl/certs/console.example.com.pem \
  /etc/nexuspuppet/tls/console.pem
sudo install -m 0400 -o 0 -g 0 /etc/puppetlabs/puppet/ssl/private_keys/console.example.com.pem \
  /etc/nexuspuppet/tls/console.key
```

> **`/etc/nexuspuppet/tls/`, not `/etc/nexuspuppet/certs/`.** The second holds
> the PuppetDB client material and is mounted into the **api**. Keeping the TLS
> key out of it is what stops the api from ever being able to read a key it has
> no business reading.

> **`0444` on the certificate is deliberate.** It is a *public* certificate — it
> is sent to every browser that connects, so there is nothing to protect and
> world-readable is correct. It also means the api can read it whatever uid that
> container runs as, which is the ownership trap in §3 removed rather than
> documented. The **key** stays `0400 root:root`: only the proxy mounts it, and
> the proxy runs as root so it can bind 80 and 443.

Then in `.env`:

```ini
CONSOLE_HOSTNAME=console.example.com
CONSOLE_TLS_DIR=/etc/nexuspuppet/tls
```

and start it:

```bash
docker compose --profile tls up -d
```

The proxy publishes 443 and 80 on **all interfaces** — deliberately, because it
is the one service here that terminates TLS. Port 80 only redirects to HTTPS; no
content is served on it. `WEB_BIND` and `API_BIND` stay on loopback.

> **`CONSOLE_HOSTNAME` may be an IP address**, and the certificate then needs an
> IP SAN rather than a DNS one:
>
> ```bash
> openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
>   -keyout console.key -out console.pem -subj "/CN=192.0.2.10" \
>   -addext "subjectAltName=IP:192.0.2.10" \
>   -addext "keyUsage=digitalSignature,keyEncipherment" \
>   -addext "extendedKeyUsage=serverAuth"
> ```
>
> A DNS name is still better — it survives the host moving, and it is what a
> certificate from your own CA will carry. Use an IP only to get going.

Reaching the console **by IP** works because the Caddyfile sets `default_sni`.
Browsers send no SNI for an IP-address URL (RFC 6066 permits DNS names only), so
without that fallback Caddy has no site to match and answers TLS alert 80 — which
surfaces as a handshake failure and reads like a broken certificate. If you see
that against a certificate you have just checked and believe is correct, the
`default_sni` line is what to look at.

> **Browsers will not trust a private CA.** Everyone gets a warning page until
> your CA's certificate is installed on the machines that use the console. This
> is not something NexusPuppet can fix. On a Puppet estate you already have a way
> to put a file on every machine — the CA certificate is at
> `/etc/puppetlabs/puppet/ssl/certs/ca.pem`.

> **The certificate must carry the name people type.** A certificate issued for
> the host's FQDN does not help someone reaching the console by IP, and the
> browser error for that mismatch is not self-explanatory.

The proxy's admin API is **not published to the host**, and must not be: it can
replace the running configuration.

### Option B — your own reverse proxy

If you already run nginx, Caddy, HAProxy or a load balancer, point it at
`127.0.0.1:3000` and leave the `tls` profile off. Nothing about the rest of this
guide changes.

### Either way: let the console tell you when it expires

An expired certificate is an outage, and it is the commonest way TLS breaks.
Point the API at the **public** certificate and *Settings → Console certificate*
reports its subject, the names it covers, whether those include
`CONSOLE_HOSTNAME`, and how many days are left:

```ini
CONSOLE_TLS_CERT_PATH=/etc/nexuspuppet/console.pem
```

with the single file mounted into the api container — in
`docker-compose.override.yml`:

```yaml
services:
  api:
    volumes:
      - /etc/nexuspuppet/tls/console.pem:/etc/nexuspuppet/console.pem:ro
```

That path is `0444`, so this works whatever uid the api container runs as.

**Mount the certificate, never the directory.** The directory holds the private
key, and the API has no reason to be able to read one.

This works whatever terminates TLS. The API reads a file; it never asks a proxy
what it loaded, so replacing the bundled proxy with your own changes nothing
here. Leaving it unset is fine too — the card then says TLS terminates somewhere
it cannot see, which is not an error.

---

## 8. High availability and horizontal scaling

**A single instance is the supported topology today.** More than one is
possible, and most of the system is built for it, but three things are not — and
two of them fail quietly rather than loudly.

### What is already safe behind a load balancer

| | |
|---|---|
| **ENC materialization, reconciliation, fact projection, audit delivery** | Each runs under a PostgreSQL advisory lock, so exactly one replica does the work at a time and the others return immediately. Adding replicas does not duplicate ENC writes or re-send audit records. |
| **Sessions** | Access tokens are stateless JWTs; refresh tokens live in PostgreSQL. Any replica can serve any request, and a revocation takes effect everywhere. |
| **Account lockout** | Counted on the user row, so a locked account is locked on every replica. |

### What is not

**OIDC login state is held in memory.** The PKCE verifier and the nonce for a
login in flight live in the process that began it. Behind a load balancer, a
callback routed to a different replica finds no matching state and the login
fails with *"Login session expired. Start again."* — a user retrying may
succeed, or may bounce between replicas indefinitely.

Until this has an external store, run OIDC either on a single instance or with
**sticky sessions** on the load balancer, keyed so that a browser reaches the
same replica for `/auth/redirect` and `/auth/callback`. LDAP and local
authentication are unaffected: neither has state between requests.

**Login rate limiting is per replica.** `LOGIN_MAX_FAILED_ATTEMPTS` is enforced
in memory, so N replicas permit N times the configured attempts before the limit
bites. Account lockout is durable and still applies, so this widens the window
for online password guessing rather than removing the protection — but if you
run replicas, set the limit accordingly, or rate-limit at the reverse proxy
where the real ceiling belongs.

**The ENC directory must genuinely be shared.** Every replica writes it, and the
content-hash comparison that prevents pointless rewrites assumes one view of the
filesystem. Two replicas with separate local volumes will fight: each sees the
other's absence as work to do. A single NFS or shared block volume, mounted
read-write by NexusPuppet and **read-only** by `puppetserver`, is the arrangement
that works.

### If you only take one thing from this section

Adding replicas is a reasonable thing to want, and most of this system supports
it. But **do it deliberately**: enable sticky sessions if you use OIDC, move rate
limiting to the proxy, and confirm the ENC volume is one volume rather than
several that happen to have the same path.

---

## 9. First contact with a real estate

Honest expectations for the first connection, because this has only ever run
against synthetic fixtures.

**Watch the first projection closely.**

```bash
docker compose logs -f api | grep -i projection
```

The node count in the UI should match `puppet node list` or your PuppetDB node
count. If it is short, the projection is filtering something it should not.

**Where the fixtures are most likely to have lied:** structured fact shapes
(`os.release.full` vs `os.release.major`), report `status` values your estate
actually emits, deactivated/expired node handling, and environments beyond
`production`/`staging`/`development`. These are exactly the places the synthetic
data was constructed from documentation rather than observation — see
[`fixtures/README.md`](fixtures/README.md).

**Do not classify anything on day one.** Let it project and observe read-only for
a full agent run cycle. Confirm the inventory, run history, and reports match
what you know to be true. Only then create a group — and start with one that
matches a single test node.

**The prune guard.** `NodeProjectionService` refuses to remove local nodes when
PuppetDB returns nothing or implausibly few, because a partial fetch looks
exactly like a shrunken estate. Deleting a `ManagedNode` cascades to its
materialization, the reconciler then removes the YAML, and a network blip would
unclassify the fleet. If you see the guard fire in the logs, investigate the
network — do not disable it.

**Classification is eventually consistent, and the UI is honest about it.** A
write returns `202` with a job id and says "materialization queued". It is not
live until `EncMaterialization` confirms it, and it does not reach a node until
that node's next Puppet run. If anything ever reports a classification change as
*applied*, that is a bug.

---

## 10. Backups

Two things carry state:

```bash
# Postgres — the system of record
docker compose exec -T db pg_dump -U nexuspuppet nexuspuppet | gzip > nexuspuppet-$(date +%F).sql.gz

# The ENC tree — derived, but back it up anyway
docker run --rm -v nexuspuppet_enc-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/enc-$(date +%F).tar.gz -C /data .
```

The ENC tree is fully rebuildable from Postgres — the reconciler regenerates
every file and removes orphans. Back it up regardless: restoring it is instant,
whereas a rebuild during an incident is one more moving part.

Also back up `.env` (it holds `JWT_SECRET`) into your secret store. Losing
`JWT_SECRET` invalidates every session; losing the database loses the audit log.

---

## 11. Upgrades

```bash
cd /opt/nexuspuppet
git fetch --tags && git checkout <new-tag>
npm run enterprise:fetch          # enterprise edition only — needs Node on this host
docker compose build
docker compose run --rm api npx prisma migrate deploy
docker compose up -d
```

Migrations run as a discrete step, before the new containers start.

The ENC tree keeps serving the previous classification throughout — agents
converging during the upgrade are unaffected. That is the property the whole
architecture exists to provide.

---

## 12. Letting a program act on Production

Sometimes a script, a CI job or an agent session has to make a real change —
create a group, assign a class, trigger materialization. Do **not** lend it your
admin login: `AuditLog` records `actorUserId` and `actorEmail` in the same
transaction as every change, and one credential shared between a person and a
program makes both columns wrong on every row either of them touches.

Use an **automation account** instead, per [ADR-0020](docs/architecture/adr/0020-automation-account.md).
It rests deactivated with a dead password, and is granted one task at a time.

### One-time setup

Requires `settings:manage` (for the role) and `users:manage` (for the account).

1. Create role `AUTOMATION` with exactly `inventory:read`, `classification:read`,
   `classification:write`, `materialization:trigger`. Never `users:manage`,
   `settings:manage` or `pql:raw` — any of those lets it widen itself.
2. Create user `automation@nexuspuppet.invalid`, display name naming whoever
   drives it, role `AUTOMATION`, `authSource` local.
3. Deactivate it, and reset its password to a discarded random value.
4. Confirm `ACCESS_TOKEN_TTL=15m` in `.env`. It bounds every revocation below.

### Granting, for one task

```bash
# 1. Rotate to a fresh password and store it 0600 — never echo it, never paste
#    it into an issue, a commit or a chat transcript.
umask 077
openssl rand -base64 32 > ~/.nexuspuppet/prod-automation-password

# 2. Set that password on the account, and activate it.
#    Both through the console or the API as an admin.
```

### Revoking, after the task

Reverse it, and understand what each step actually reaches — they are not
equivalent, and the differences are counter-intuitive:

1. **Empty the `AUTOMATION` role's permissions.** The only step that stops a
   session already running, on its next request.
2. **Deactivate the account.** Stops new logins and refreshes. Does **not** stop
   a live access token.
3. **Reset the password** to a discarded random value. Also revokes every
   refresh token.

Do not rely on demoting the account to another role. A user's role is a claim in
the access token, so a demotion changes nothing until the token is refreshed —
up to `ACCESS_TOKEN_TTL`.

Restore the role's permissions at the next grant.

### The failure mode

An account left active. Nothing detects it, and nothing here prevents it. If you
suspect a grant was never revoked, check it directly:

```bash
# active automation accounts, and any live sessions they hold.
# Columns are camelCase and must stay quoted — Prisma maps the table name
# but not the fields.
docker compose exec -T db psql -U nexuspuppet -d nexuspuppet <<'SQL'
select u.email,
       u."isActive",
       count(r.id) filter (
         where r."revokedAt" is null and r."expiresAt" > now()
       ) as live_sessions
from users u
left join refresh_tokens r on r."userId" = u.id
where u.email like 'automation@%'
group by u.email, u."isActive";
SQL
```

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| API exits immediately at boot | `JWT_SECRET` unset. There is no fallback by design |
| "PuppetDB unreachable", last contact shown | Certificate or firewall — not authorization, which PuppetDB does not apply to `/pdb/*` (§3). Reproduce with the `curl` in §3 |
| Inventory empty, no error | First projection has not completed. Check `PUPPETDB_PROJECTION_INTERVAL_MS` and the logs |
| A rule matches nothing | The fact is not in `PUPPETDB_PROJECTED_FACTS`. The rule editor warns about this |
| All nodes get `default.yaml` | The ENC directory is not reaching puppetserver, or is at a different path. Run the script by hand (§6) |
| Change saved, nodes unchanged | Expected until the node's next Puppet run. Check `EncMaterialization` confirmed it |
| Enterprise route returns 501 | Core edition. The feature exists; this deployment lacks it. Not a bug |
| `npm install` fails on `packages/enterprise` | `enterprise:fetch` ran with a repo URL you cannot clone. Unset it for the core edition |

## Security checklist

- [ ] `.env` is `0600`; `/etc/nexuspuppet/certs/client.key` is `0400`, owned by
      uid 100 (§3) — not `0600 root:root`, which the container cannot read
- [ ] `BOOTSTRAP_ADMIN_*` removed after first login, password rotated
- [ ] `~/.nexuspuppet/admin-password` deleted on production hosts
- [ ] `API_BIND` left at `127.0.0.1`; TLS terminated in front of 3000
- [ ] PuppetDB reachable only from hosts that need it — this **cannot** be
      bounded by certificate, so the network is the only control (§3)
- [ ] `client-auth = need` in PuppetDB's `jetty.ini`, not `want`
- [ ] TLS in front of the console (§7) — nothing here terminates it by default,
      and session cookies need a secure context
- [ ] `/etc/nexuspuppet/tls/console.key` is `0400 root:root` and mounted into
      the **proxy only** — never into `api`, which has no use for it
- [ ] ENC directory mounted **read-only** on puppetserver
- [ ] **No inbound network path from puppetserver to NexusPuppet** (ADR-0003)
- [ ] Postgres not published to the network
- [ ] Backups verified by restoring one, not by observing that the job ran
- [ ] `ENC_REPLICATION_ALLOWED_CERTNAMES` names only the puppetserver(s) that
      must replicate — a valid Puppet certificate is not entitlement (§6)
- [ ] No automation account left active, and none holding `users:manage`,
      `settings:manage` or `pql:raw` (§12, ADR-0020)

---

## Appendix A. Installing OpenVoxDB natively, on the same host

NexusPuppet needs a PuppetDB to read. If you already have one, skip this — §3
onwards is all you need. This is for the layout the guide otherwise assumes you
have solved: **OpenVox Server running natively on the host, NexusPuppet in
Docker, no PuppetDB yet.**

None of this is NexusPuppet configuration. It is the inventory backend our
console reads, written down because §3 asks for a `PUPPETDB_URL` and everything
before that point was left as an exercise. Upstream OpenVox documentation is the
authority; this is the short path that has been walked end to end.

> **Do this before §3.** Without a PuppetDB the console starts, is healthy, and
> shows nothing — which looks exactly like a broken install.

### A.1 Packages

**Add the OpenVox repository first.** These packages are not in Ubuntu or Debian,
and without this the install below fails with `Unable to locate package
openvoxdb` — which reads like a typo rather than a missing repository:

```bash
curl -fsSLO https://apt.voxpupuli.org/openvox8-release-ubuntu22.04.deb
sudo dpkg -i openvox8-release-ubuntu22.04.deb
sudo apt update
```

Swap the filename for your distribution — `openvox8-release-ubuntu24.04.deb`,
`openvox8-release-debian12.deb`. All three were confirmed to resolve at the time
of writing; if yours 404s, the index at <https://apt.voxpupuli.org/> is the
authority.

Then:

```bash
sudo apt install postgresql postgresql-contrib openvoxdb openvoxdb-termini
```

If you are also installing the server on this host, `openvox-server` and
`openvox-agent` come from the same repository.

The service names stay `puppetdb` and `puppetserver` under systemd; only the
package names carry the OpenVox prefix. That catches people out when reading
Puppet documentation alongside OpenVox packages.

### A.2 Database

```bash
sudo -u postgres createuser -DRS puppetdb
sudo -u postgres createdb -O puppetdb puppetdb
sudo -u postgres psql -c "ALTER USER puppetdb WITH PASSWORD '<generated>';"
sudo -u postgres psql -d puppetdb -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
sudo -u postgres psql -d puppetdb -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
```

`pg_trgm` needs a superuser, so openvoxdb cannot create it itself, and without it
the service aborts during schema migration and shuts down *cleanly* — the reason
sits above a Clojure stack trace, and the symptom is a service that will not stay
up for no visible cause.

Then `/etc/puppetlabs/puppetdb/conf.d/database.ini`:

```ini
[database]
subname = //localhost:5432/puppetdb
username = puppetdb
password = <generated>
```

### A.3 TLS

```bash
sudo puppetdb ssl-setup -f
```

That reuses the host's existing agent certificates. Afterwards, check what it
left behind:

```bash
grep -c '^client-auth' /etc/puppetlabs/puppetdb/conf.d/jetty.ini   # must be 1
```

`ssl-setup` appends `client-auth = want` without checking for an existing line.
`want` accepts requests presenting **no client certificate at all** — see §3's
table. Set exactly one line reading `client-auth = need`.

While you are in `jetty.ini`, keep the cleartext port on loopback:

```ini
host = 127.0.0.1
port = 8080
```

Nothing needs it remotely, and it is unauthenticated.

### A.4 Point puppetserver at it

`/etc/puppetlabs/puppet/puppetdb.conf`:

```ini
[main]
server_urls = https://<this-host-fqdn>:8081
```

`/etc/puppetlabs/puppet/routes.yaml`:

```yaml
---
master:
  facts:
    terminus: puppetdb
    cache: json
```

and in `puppet.conf` under `[server]`, `storeconfigs = true` plus
`storeconfigs_backend = puppetdb`, with `reports = puppetdb` if you want the
report views populated.

```bash
sudo systemctl enable --now puppetdb
sudo systemctl restart puppetserver
sudo puppet agent --test          # a node to look at
```

### A.5 Then wire NexusPuppet to it

Back to §3, with two things specific to this layout:

- **`PUPPETDB_URL` must use the name on the certificate.** mTLS verifies the
  hostname, so the host's FQDN — not `localhost`, not an IP.
- **The container has to resolve that name.** It is the host, not a Compose
  service, so map it to the Docker gateway. The shipped
  `docker-compose.native-enc.example.yml` does this with `extra_hosts` and also
  handles the ENC bind mount §6 requires for a native puppetserver.

---
