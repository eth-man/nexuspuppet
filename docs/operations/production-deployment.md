# Production deployment — fresh on-prem VM

Deploying NexusPuppet onto a clean host and connecting it to a live Puppet
estate. Read [`docs/architecture/README.md`](../architecture/README.md) first if
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

### Authorising it in PuppetDB

Grant the certname read access in PuppetDB's `auth.conf`. Give it query access
only — no `/pdb/cmd`.

> **This certificate is estate-wide.** PuppetDB has no per-user authorization,
> so the API is a confused deputy by construction: it can see every node. This
> is why authorization is decided in `api` *before* the query is built, and why
> the web tier never holds this certificate. Do not "simplify" by letting the
> browser talk to PuppetDB.

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
projected for rule evaluation. Add your estate's own custom facts — `role`,
`profile`, `tier` and the like are what operators actually write rules against:

```ini
PUPPETDB_PROJECTED_FACTS=os,networking,processors,memory,virtual,is_virtual,fqdn,domain,kernel,role,profile,tier
```

The UI warns when a rule names an unprojected path, but only after you have
written it. Getting this list right up front saves a confusing afternoon.

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

Run migrations as a separate step rather than on container start. An automatic
migrate-on-boot turns a rollback into a data problem.

Confirm:

```bash
curl -fsS http://localhost:3001/healthz          # {"status":"ok"}
curl -fsS http://localhost:3001/capabilities     # edition and features
docker compose logs api | grep -i 'projection\|puppetdb'
```

### First login

Sign in at `http://<vm>:3000` with the bootstrap credentials, then rotate
immediately:

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
[`scripts/nexuspuppet-enc.sh`](../../scripts/nexuspuppet-enc.sh) into an API
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

Session cookies are `HttpOnly`, with the refresh token scoped to `/api/auth`.
They require a secure context to behave correctly in modern browsers: serve the
console over HTTPS, not bare HTTP on an IP.

---

## 8. First contact with a real estate

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
[`fixtures/README.md`](../../fixtures/README.md).

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

## 9. Backups

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

## 10. Upgrades

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
| "PuppetDB unreachable", last contact shown | Certificate, `auth.conf` authorization, or firewall. Reproduce with the `curl` in §3 |
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
- [ ] Port 3001 not exposed beyond the host; TLS terminated in front of 3000
- [ ] PuppetDB certificate authorised for **query only**, no `/pdb/cmd`
- [ ] ENC directory mounted **read-only** on puppetserver
- [ ] **No inbound network path from puppetserver to NexusPuppet** (ADR-0003)
- [ ] Postgres not published to the network
- [ ] Backups verified by restoring one, not by observing that the job ran
