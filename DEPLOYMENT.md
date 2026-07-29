# Production deployment — fresh on-prem VM

Deploying NexusPuppet onto a clean host and connecting it to a live Puppet
estate. Read [`docs/architecture/README.md`](docs/architecture/README.md) first if
you have not; the constraints below come from the ADRs and are not stylistic.

> **Status.** Every component has been exercised end to end against synthetic
> fixtures, with 253 unit, 135 integration and 29 browser tests passing. It has
> **never been run against a real PuppetDB or a real puppetserver.** Treat the
> first deployment as a commissioning exercise, not a rollout. The
> [First contact with a real estate](#8-first-contact-with-a-real-estate) section
> lists what to expect to be wrong.

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

- Linux with Docker Engine ≥ 24 and the Compose plugin
- 2 vCPU / 4 GB RAM is comfortable for a few thousand nodes; the workload is
  mostly idle between projection ticks
- Disk: Postgres growth is driven by report retention, not node count
- Outbound TCP to PuppetDB on 8081. **No inbound access from puppetserver is
  required — and none should be permitted** (ADR-0003)

### Puppet or OpenVox

Both are supported, and NexusPuppet needs no configuration change to tell them
apart.

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

# Enterprise edition:
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

That produces three files you need:

| File | Source path on the CA |
|---|---|
| `client.pem` | `/etc/puppetlabs/puppet/ssl/certs/nexuspuppet.internal.pem` |
| `client.key` | `/etc/puppetlabs/puppet/ssl/private_keys/nexuspuppet.internal.pem` |
| `ca.pem` | `/etc/puppetlabs/puppet/ssl/certs/ca.pem` |

### Installing them on the NexusPuppet VM

```bash
sudo install -d -m 0700 -o root -g root /etc/nexuspuppet/certs
# Transfer over SSH/scp. Never paste key material into a chat window,
# an issue, or a CI variable that logs its value.
sudo install -m 0600 client.pem client.key ca.pem /etc/nexuspuppet/certs/
```

The key must be `0600`. Compose mounts the directory read-only, and the
certificates are never baked into an image.

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
   Set `need`.
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
itself — with the bootstrap credentials, then rotate immediately:

```bash
node scripts/dev/rotate-admin-password.mjs
```

It changes the password through `POST /account/password`, which verifies the old
one, writes the audit row, and revokes every other session in one transaction —
and it never prints the password. Then delete `BOOTSTRAP_ADMIN_*` from `.env`.

> The `~/.nexuspuppet/admin-password` file that script writes is a **local
> development convenience.** On a production host, put the password in your
> secret manager and delete the file.

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
| Same host | The `enc-data` named volume, mounted `:ro` | Simplest. Uncomment the reference block in `docker-compose.yml` |
| Separate puppetserver VM | Bind-mount `ENC_OUTPUT_DIR` to a host path exported over **NFS**, mounted read-only on puppetserver | Most common on-prem |
| Separate VM, no shared FS | `rsync` the tree on a timer | Adds propagation delay. The directory is self-consistent — files are written atomically via tmp+fsync+rename — but rsync mid-write can still ship a partial *set*. Use `--delay-updates` |

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
- **Directory missing or empty** → exit non-zero, so puppetserver falls back to
  its own node definitions and logs loudly

That last one matters: a visible error beats silently classifying the entire
estate as empty.

Then restart puppetserver and watch the first agent run end to end.

---

## 7. Put TLS in front of it

The web tier serves plain HTTP on 3000 and is meant to sit behind your reverse
proxy. Terminate TLS there, and **do not expose port 3001** — the API is reached
through the web tier's server-side relay.

Both ports bind to `127.0.0.1` unless you set `API_BIND` / `WEB_BIND`, so a
proxy on the same host needs no change. `API_BIND` should stay on loopback.

Session cookies are `HttpOnly`, with the refresh token scoped to `/api/auth`.
They require a secure context to behave correctly in modern browsers: serve the
console over HTTPS, not bare HTTP on an IP.

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
npm run enterprise:fetch          # enterprise edition only
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

- [ ] `.env` is `0600`; `/etc/nexuspuppet/certs/client.key` is `0600`
- [ ] `BOOTSTRAP_ADMIN_*` removed after first login, password rotated
- [ ] `~/.nexuspuppet/admin-password` deleted on production hosts
- [ ] `API_BIND` left at `127.0.0.1`; TLS terminated in front of 3000
- [ ] PuppetDB reachable only from hosts that need it — this **cannot** be
      bounded by certificate, so the network is the only control (§3)
- [ ] `client-auth = need` in PuppetDB's `jetty.ini`, not `want`
- [ ] ENC directory mounted **read-only** on puppetserver
- [ ] **No inbound network path from puppetserver to NexusPuppet** (ADR-0003)
- [ ] Postgres not published to the network
- [ ] Backups verified by restoring one, not by observing that the job ran
