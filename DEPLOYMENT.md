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
- Outbound TCP to PuppetDB on 8081. **No inbound access from puppetserver is
  required — and none should be permitted** (ADR-0003)

### Puppet or OpenVox

Both are supported, and NexusPuppet needs no configuration change to tell them
apart.

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
export NEXUSPUPPET_ENTERPRISE_REPO='git@github.com:yourorg/nexuspuppet-enterprise.git'
export NEXUSPUPPET_ENTERPRISE_REF=v1.0.0      # default: main
npm run enterprise:fetch                       # clones into packages/enterprise/
npm install
```

`npm run enterprise:fetch` with no repository set exits 0 with a notice and does
nothing. That is intended: the public pipeline runs it on every commit to prove
it is safe.

The URL belongs in `.env` or your secret store — never in a committed file. The
fetch script does not echo it, because CI logs get shared.

**Verifying which edition you are running:** `GET /capabilities` lists what this
deployment can do. Enterprise-only routes exist in the core build and return
`501` with a `capability` field, never `404` — the feature exists, this
deployment lacks it.

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
- **`certificate-whitelist` no longer exists.** It was removed after PuppetDB 6.
  In OpenVoxDB 8 it is not a valid `jetty.ini` key: the string appears nowhere in
  the shipped jar, and adding it stops the service from starting with
  `{:certificate-whitelist disallowed-key}`.

Verified against OpenVoxDB 8.15.0, with the shipped `auth.conf` in place:

| Request | `client-auth = want` | `client-auth = need` |
| --- | --- | --- |
| `GET /pdb/query/v4/nodes`, no client certificate | **200** | TLS rejected |
| `GET /pdb/query/v4/nodes`, any CA-signed certificate | 200 | 200 |
| `POST /pdb/cmd/v1` `replace_facts`, any CA-signed certificate | **200** | **200** |

The command submissions were accepted *and persisted*: a node that does not
exist, carrying a fact that was never reported, appeared in the estate.

So the honest statement is: **any certificate the Puppet CA has ever signed —
including every agent in your estate — can read all of PuppetDB and write to
it.** That is a property of PuppetDB, not of NexusPuppet, and it is not something
this project can fix.

#### What to do instead

1. **Check `client-auth` in `jetty.ini`.** Some images ship `want`, which
   accepts requests with *no client certificate at all* — the first row above.
   Set `need`, then confirm there is exactly one such line:

   ```bash
   grep -c '^client-auth' /etc/puppetlabs/puppetdb/conf.d/jetty.ini   # must be 1
   ```

   `puppetdb ssl-setup` appends its own `client-auth = want` without checking
   for an existing entry, so running it after you have set `need` silently
   leaves two — and the file no longer says what you think it says.
2. **Restrict `/pdb/*` at the network layer.** A firewall rule or a reverse proxy
   is the only thing that actually bounds who can reach it. Do not publish port
   8081 beyond the hosts that need it, and do not publish the cleartext port 8080
   at all.
3. **Treat the NexusPuppet certificate as a full-access credential** when
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
PUPPETDB_PROJECTED_FACTS=os,networking,processors,memory,virtual,is_virtual,kernel,profile,tier
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
| Same host, **puppetserver native** | Bind-mount a host path, e.g. `/srv/nexuspuppet/enc`, owned by uid 100 | The named volume does **not** work here — see below |
| Separate puppetserver VM | Bind-mount `ENC_OUTPUT_DIR` to a host path exported over **NFS**, mounted read-only on puppetserver | Most common on-prem |
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

### On the puppetserver host

```bash
sudo install -m 0755 nexuspuppet-enc.sh /usr/local/bin/nexuspuppet-enc.sh
```

```ini
# /etc/puppetlabs/puppet/puppet.conf
[master]
node_terminus  = exec
external_nodes = /usr/local/bin/nexuspuppet-enc.sh
```

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

```bash
sudo apt install postgresql postgresql-contrib openvoxdb openvoxdb-termini
```

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
