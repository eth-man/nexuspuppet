# Changelog

Notable changes to NexusPuppet. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

**`scripts/deploy.sh --reset-admin <email>` recovers a lost local password.** An operator lost the only administrator's password, and nothing supported could get them back in: `BOOTSTRAP_ADMIN_*` only seeds an empty users table, and the console's reset needs an administrator who can sign in. The command prompts twice without echo (or reads one line from a non-terminal stdin), applies the console's password rule, and in one transaction sets the password, clears the lockout, reactivates the account, revokes its refresh tokens and writes a `user.password.reset` audit record with actor `cli:deploy.sh@<host>` — forwarded like any other record when audit forwarding is configured. It starts only the database and runs in a one-off container, so it works with the API stopped or crash-looping. The password reaches the container on stdin only, never argv, the environment or a file. Directory accounts are refused (exit 3), an unknown email exits 2. Access tokens already issued stay valid until `ACCESS_TOKEN_TTL`. See DEPLOYMENT.md §5, *Lost the admin password*.

### Fixed

**`scripts/deploy.sh --help` shows every option.** It printed a fixed range of lines that stopped mid-way through `--check` and never reached `--tls` or `--skip-preflight`.

## [1.11.0] — 2026-10-01

**A directory is enabled from the console** ([ADR-0029](docs/architecture/adr/0029-directory-from-the-console.md)). An install upgraded from core showed LDAP and SSO as *Not enabled — set LDAP_URL and restart the API*. Both directories are now configurable and enable-able entirely from **Settings → Directory / Auth**, effective at the next sign-in, with no `.env` edit and no restart. Local accounts are never affected. **No migration.**

### Added

**Both directory providers are always registered.** Each resolves its configuration per sign-in: a row saved in the console, else the `LDAP_*` / `OIDC_*` environment, else none — *dormant*. A dormant directory is not offered on the login page, and its accounts are refused exactly like a wrong password, inside the login timing floor, with one log line saying *LDAP sign-in is not configured*. Accounts can be created for a dormant directory in advance; the create-user dialog labels it *not configured yet* and never defaults to it.

**The LDAP CA certificate can be pasted** as PEM (`caPem`) in the console, so `ldaps://` against an internal CA needs no mounted file. It is public, so it is stored in clear and shown back with each certificate's subject, issuer and expiry. A private key, anything that is not X.509, and a CA beside disabled verification are refused. `LDAP_CA_PATH` is unchanged, and the environment still never takes inline PEM.

**`scripts/deploy.sh` generates `CONFIG_ENCRYPTION_KEY`** when `.env` has none, on first install and on upgrade, by appending one commented line — the one deliberate exception to "an existing `.env` is never touched". Without it the console could not store a bind password or client secret. An existing or empty line is never edited.

**`GET /users/auth-sources`** (`users:manage`) lists every registered sign-in source with whether it is configured.

### Changed

**`GET /auth/mode` lists configured sources only.** On a deployment with no directory it answers exactly as before: `local`.

**Test before save works on a fresh deployment.** The OIDC check now tests the candidate configuration, with its own clients; it used to check the boot configuration, which a fresh deployment does not have.

**Saving directory settings writes the change and its audit record in one transaction**, as discarding already did.

**Without `CONFIG_ENCRYPTION_KEY`, the directory settings say so before anybody types a password**: *Saving a bind password needs CONFIG_ENCRYPTION_KEY. Re-run scripts/deploy.sh, which generates it, or set it in .env and restart.* The API refuses the save with the same words.

### Removed

The *Not enabled* card, the "restart required" notices, and `verifyLdap`'s "Set LDAP_URL and restart once" answer.

### Upgrading

Re-run `scripts/deploy.sh`. On an install with no `CONFIG_ENCRYPTION_KEY` it appends one to `.env` and prints a line saying so; back `.env` up afterwards. A present but malformed `LDAP_*`, `OIDC_*` or `AUDIT_EXPORT_*` still stops the API at boot, as in 1.10.

## [1.10.1] — 2026-10-01

**The support bundle now has everything the API printed.** A bundle downloaded from staging was compared line by line with `docker logs` of the same container: 122 of 124 lines matched. **No migration.**

### Fixed

**Node's own warnings and the stack trace of a crash were missing from the support bundle.** Node writes those straight to stderr, past the logger that feeds the API's local log copy, so the bundle never saw them. The crash trace is the thing support needs most. They are now copied into the log file as `context: "Process"` lines, `warn` for a runtime warning and `fatal` for an uncaught exception or unhandled rejection, with the stack and its origin. Node's behaviour is unchanged: it still prints them, and a crash still exits non-zero. A failed bootstrap, once the log file is open, is recorded there too, so a container restarting in a loop leaves its reason in the bundle. (#269)

**A downloaded support bundle could be committed by accident.** `.gitignore` now covers `nexuspuppet-support-*.tar.gz` and `nexuspuppet-host-support-*.tar.gz`. (#269)

## [1.10.0] — 2026-10-01

**One product, and one file to send to support.** There is no enterprise layer and no edition any more: LDAP/AD, OIDC, custom roles and audit forwarding are part of the API, always present, and inert until configured (ADR-0027, superseding ADR-0002). A new support bundle collects the console's logs, status and non-secret configuration into one archive, with an opt-in for personal data (ADR-0028). **No migration.**

### Added

**Support bundle** ([ADR-0028](docs/architecture/adr/0028-support-bundle.md)). **Settings → General → Support bundle** downloads one `.tar.gz` for the last 1, 6, 24 or 72 hours: the API's own logs from every replica, system status, every operational condition with how long it has been open, propagation, non-secret configuration, queue and migration summaries, and audit actions without actors. `summary.txt` leads with what needs attention — a condition open for six weeks is the first line, not line 90,000. Secrets, identities, client addresses and audit payloads are excluded, and every file is scanned for secret values, private keys, URL credentials, tokens and email addresses before archiving. Needs `settings:manage`; each export is audited. Also `GET /system/support-bundle?hours=N`.

**Opt-in: configuration and personal data.** A per-download tick (`&includePersonalData=true`) adds the audit trail with actors, addresses and before/after values, the user list with session counts, the full classification including parameter values, and saved queries. The file is named `…-with-personal-data.tar.gz`, the manifest says so first, and the export's audit row records the choice. Environment secrets, stored credentials, password hashes, tokens and private keys stay out either way.

**`scripts/support-bundle.sh`** collects what the console cannot see — container logs, Docker state, host facts, the `nexuspuppet-*` timers and the journal — on the console VM or a Puppet server, and embeds the console's archive with `--include` so support gets one file. It never runs `docker compose config` or a full `docker inspect`, filters `.env` through an allow-list, and masks the values of its secrets everywhere.

**The API keeps a bounded copy of its own log** in the new `api-logs` volume (`/var/log/nexuspuppet`): JSON lines, rotated at `LOG_FILE_MAX_BYTES` (20 MiB) keeping `LOG_FILE_KEEP` (5) — at most 120 MiB per replica. Stdout is unchanged and remains the log; ADR-0016 is amended to say so. `LOG_FILE_MAX_BYTES=0` switches the copy off.

### Changed

**`packages/enterprise` moved into `apps/api`.** The directory providers are now `apps/api/src/directory/{ldap,oidc}`, and forwarding is `apps/api/src/audit-forwarding`. They are wired in `app.module.ts` like everything else, and their tests moved with them. `ldapts` is a dependency of `@nexuspuppet/api`. Removed with it: the runtime loader, the capability registry, `CONTRACTS_VERSION`, the descriptor types, `EnterpriseLoadError`, the `CAPABILITIES` constant, the ESLint enterprise boundary and the core no-op audit transport. The interfaces and DI tokens in `@nexuspuppet/contracts` stay, because they keep these testable.

**Role editing and audit forwarding are always available.** The `rbac.custom` and `audit.export` checks are gone. `POST/PATCH/DELETE /roles` and the `/settings/audit/*` writes never answer `501`. The console's roles table is always editable for `settings:manage`, and the Syslog and Webhook cards are always real forms.

**Directory settings cards key on configuration, not capabilities.** Without `LDAP_URL` or `OIDC_ISSUER`, the card reads *Not enabled* and names the variable that enables it. It no longer shows a padlock reading "Enterprise". The deployment card no longer has an Edition row.

**Malformed directory or audit-export configuration still stops the API from booting.** The message now names the integration: `LDAP is configured but its settings are invalid, so the API will not start rather than run without it. …`

**CI's load-bearing job is renamed** from "Core builds without the enterprise layer" to "Build, typecheck, lint, unit tests". It no longer greps for enterprise imports, and it keeps the committed-certificate and private-key checks.

### Fixed

**After an API restart during a PuppetDB outage, the console said PuppetDB "is not answering and never has".** The last successful contact was held only in memory, so a restart erased it. The condition summary, the system status card and the inventory screens' unreachable state now fall back to the newest `ManagedNode.projectedAt` — a contact that really happened — and say *"last successful query …"*. Production showed "never has" for three weeks of a six-week outage. (#263)

**An install that followed DEPLOYMENT.md built an image without LDAP, OIDC, custom roles or audit forwarding.** The API image had an `EDITION` build argument defaulting to `core`, which left `packages/enterprise` out, and `scripts/deploy.sh` never set it. Since 1.9.0 made every feature part of the open-source product, that default meant the documented install path produced the smaller image, and nothing said so — role editing and audit forwarding answered `501` and the directory panels showed as unavailable.

**`NOTICE` said the directory and audit integrations were under a commercial licence and not in this repository.** Both stopped being true in 1.9.0.

### Removed

**The `EDITION` build argument.** Every image now contains the whole product and is installed with `npm ci` against the committed lockfile — the separate `npm install` stage and the `ldapts` reinstall it needed on every rebuild are gone. `ldapts` loses a stale optional-peer entry and is an ordinary dependency only.

**`npm run test:e2e:core`, `npm run test:e2e:enterprise` and `scripts/dev/e2e-edition.sh`**, which ran the browser suite with the layer hidden. There is no smaller product left to test.

**The `NEXUSPUPPET_ENTERPRISE_REPO` / `_REF` block in `.env.example`**, which described a fetch script deleted in 1.9.0.

**`GET /capabilities`.** It was a public endpoint that reported an `edition`, an `enterpriseVersion` and a list of licensed capabilities, and after ADR-0027 it could only have returned a constant. Use `GET /auth/mode` for the sign-in sources a deployment offers.

**`SystemStatus.auditForwarding.available`**, from `GET /system/status`. Forwarding is always available. The remaining fields say whether it is on and whether it can send.

### Upgrading

**`EDITION` is gone; remove it from `.env` at your leisure.** A leftover line is ignored.

**If your `.env` set `EDITION=enterprise`, nothing changes.** You were already building this image.

**If it did not — the default — your next build gains LDAP/AD, OIDC, custom roles and audit forwarding. None of them does anything until it is configured:**

- the LDAP provider is registered only when `LDAP_URL` is set, and OIDC only when `OIDC_ISSUER` is;
- audit forwarding queues and sends nothing until a transport is configured, by `AUDIT_EXPORT_URL` or from Settings → Integrations;
- custom roles become *creatable* by holders of `settings:manage`; the three built-in roles are unchanged and nobody's access moves until someone defines a role.

**Check `.env` before rebuilding a former core image.** `LDAP_*`, `OIDC_*` and `AUDIT_EXPORT_*` were ignored by an image without the layer; they now take effect, and a malformed value stops the API from booting — deliberately, so a deployment that believes it has a directory never silently runs without one:

```bash
grep -E '^(LDAP_|OIDC_|AUDIT_EXPORT_)' .env
```

**Anything that calls `GET /capabilities` now gets `404`.** Monitoring or scripts that probed it to learn the "edition" should stop. There is nothing to learn. A health check belongs on `GET /healthz`.

**Anything that expected `501` from role or forwarding writes now gets the real answer.**

**Consumers of `GET /system/status` lose `auditForwarding.available`.** It was only ever `false` on a core image.

`docker compose up -d` creates the `api-logs` volume, already owned by the API's uid. Nothing to configure. If you replace it with a bind mount, the host directory must be writable by uid 100 (DEPLOYMENT.md, "Support bundles").

## [1.9.0] — 2026-09-07

**NexusPuppet is now fully open source.** Directory authentication (LDAP and Active Directory), single sign-on (OIDC), custom roles and audit forwarding move from a private repository into this one, under Apache-2.0. There is no paid tier, no licence key, and no feature held back. **No migration.**

### Changed

**The enterprise layer ships here.** `packages/enterprise` — LDAP/AD, OIDC and audit forwarding — is part of this repository. It carried its own *"Proprietary and Confidential"* LICENSE and declared `"license": "UNLICENSED"`; both are gone, and the root Apache-2.0 licence governs the whole tree.

**Licensing is removed, not disabled.** `LICENSE_SERVICE`, `ILicenseService` and `LicenseStatus` are deleted from `@nexuspuppet/contracts`, and the enterprise layer no longer filters what it registers by entitlement. An unused entitlement checker is precisely the "documented field that nothing populates" that ADR-0014 was written to end, so it was removed rather than left dormant.

**ADR-0014 is Rejected, never ratified.** What it got right is worth keeping if licensing ever returns: offline verification with no phone-home, and degradation that can never touch classification or the ENC. What it got wrong was timing — the product had no paying users, so the gate cost adoption and protected nothing. The record is left intact rather than deleted.

**ADR-0002 is amended, not superseded.** Core still does not import the enterprise package: it depends on interfaces in `@nexuspuppet/contracts`, and the layer registers implementations at runtime. ESLint still forbids a direct import. That seam is now an internal boundary keeping the auth and audit integrations independently testable, rather than a commercial one.

**One `npm install` builds everything.** `packages/enterprise` is a real workspace member: `ldapts` moves from an optional peer dependency to an ordinary one, its private lockfile is gone, and the root lockfile covers it. This ends the split instruction where a deployment host and a development checkout needed different install commands.

### Removed

**`npm run enterprise:fetch`, `scripts/enterprise.mjs`, `NEXUSPUPPET_ENTERPRISE_REPO` and `NEXUSPUPPET_ENTERPRISE_REF`.** They could not survive the code being in-repo: with `packages/enterprise` tracked, the script's existing-checkout branch would run `git -C packages/enterprise fetch`, and with no nested `.git` that walks up and operates on the NexusPuppet repository itself.

### Upgrading

**If you deploy the core edition, nothing changes.** `EDITION=core` still builds an image without `packages/enterprise`, and CI still proves core builds without it.

**If your pipeline calls `enterprise:fetch`, remove that step.** It no longer exists, and the environment variables it read are gone. Node on the deployment host is no longer required for the enterprise edition — Docker is enough, as it always was for core.

**To switch a deployment from core to enterprise**, no licence and no repository access are needed:

```bash
git fetch --tags && git checkout v1.9.0
sed -i 's/^EDITION=core/EDITION=enterprise/' .env
docker compose build api
docker compose up -d
```

`GET /capabilities` then reports the capabilities the build contains and that are configured — `directory.ldap` only once LDAP is configured, and so on. `edition` reflects whether the optional package is in the image; it has never indicated a licence, and now indicates nothing commercial at all.

**Switching edition and configuring a directory are separate changes.** Flip the edition, confirm the API boots and local login still works, and only then point it at a directory. Local accounts are never displaced by doing so: `AuthProviderResolver` dispatches on each account's `authSource` and the local provider is never overridden (ADR-0015 §3).

## [1.8.0] — 2026-08-18

The console can say what a node **does** get, not only what it should. An estate-wide resource search reads the catalogs PuppetDB already indexes and answers the question that is not a lookup: do these nodes AGREE (ADR-0025). **One migration**, `admin_resources_read`, which widens the built-in ADMIN role — see Upgrading.

### Added

**Estate-wide resource search.** Classification describes intent thoroughly — every class on a node, which group set it, why that group matched. The catalog is the RESULT, and nothing read it: six PuppetDB endpoints were in use and `/resources` was not one of them. So "is `/etc/ssh/sshd_config` the same on all 190 servers" had no answer here.

**Consistency is the headline, not a detail.** Results group by resource and lead with variance — `190 nodes · 2 variants ⚠` — and disagreements sort to the top. A flat list of 190 identical rows hides the three that differ, which is the opposite of what an operator opened the screen to find.

**Variance is established without a single parameter crossing the wire.** PuppetDB's `resource` field is a SHA-1 over type, title *and* parameters, so identical hashes mean byte-identical parameters. The list query uses `extract` to omit `parameters` outright: a value never fetched cannot leak through a rendering bug, a log line or an error page.

**Variance is counted WITHIN an environment, never across it.** A development node and a production node legitimately differ, and counting that as drift would flag a two-environment estate as entirely inconsistent on the first day. ADR-0021 already records where that ends — the channel gets muted, and takes the alert that mattered with it.

**Expanding names the nodes; comparing shows the difference.** Expansion lists which nodes carry which configuration — not a disclosure, a certname is on the Nodes page already. Comparing parameters is a separate, explicit act that fetches one representative per variant and diffs them, with a line diff for multi-line values so a 200-line config file shows the stanza that changed rather than two columns to compare by eye.

**Composes with fact filtering.** "`File[/etc/resolv.conf]` on Ubuntu 22.04 nodes" is one query, reusing the inventory subquery added in 1.7.7.

**Parameter-value filtering.** "Find every node where `sshd_config` permits root login" needs no parameter to be displayed. It is also an oracle — a holder can confirm a secret by guessing without ever seeing it rendered — which is stated plainly in ADR-0025 §5 rather than mitigated by a safe-list of "non-sensitive" parameter names that could never be complete.

**`resources:read`, a new and privileged permission.** Deliberately NOT `inventory:read`. Facts describe a machine; resource parameters are its configuration payload — a `File`'s `content` is the whole file body, and a class parameter may hold a credential.

**Read-only audit events, amending ADR-0005.** Expanding parameters, and any query filtering on a parameter value, write an `AuditLog` row. Ordinary browsing does not — burying the events that matter under thousands that do not is how a trail stops being read. The row is written BEFORE the read, so a crash cannot lose the evidence while keeping the disclosure, and it records the QUESTION rather than the answer: no parameter value is ever written into the audit log.

### Upgrading

**Every existing ADMIN gains the ability to read managed file contents.** The migration grants `resources:read` to the built-in ADMIN role. It is granted because otherwise nobody could hold it — creating a custom role answers 501 without the enterprise layer (ADR-0018) — so leaving it unheld would make the feature unreachable in every core deployment rather than merely restricted. VIEWER and OPERATOR are unaffected. A deployment needing "an admin who manages users but must not read file contents" needs the enterprise layer to express it.

**`AuditLog` consumers must tolerate null `before` and `after`.** Read events have neither. This is visible on the wire, including to syslog and webhook forwarding.

## [1.7.0] — 2026-08-13

The audit trail can name what it describes, and every row it writes while serving one request carries that request's id. **One migration**, `audit_request_correlation`, purely additive.

### Added

**`entityLabel` — what the entity was called at the time.** An audit row outlives the thing it describes. Once a group was deleted its row read `node_group / 6e7969f8-…` and named nothing, because the id could no longer be resolved — the row it pointed at was gone. The label is derived from the `before`/`after` payload already stored rather than supplied by each of the twenty call sites that write audit rows, so it cannot drift between them. A rename is recorded under the new name; a deletion falls back to the old one, which is exactly when it matters most.

**`requestId` — every row written while serving one request shares an id.** Set once at the edge in an `AsyncLocalStorage` store and read once in the sink, so no call site changed. Reconstructing an operation previously meant arithmetic on adjacent timestamps, which is the reasoning ADR-0022 rejected for compile receipts. Note that every operation in the product currently writes exactly one audit row, so this is the guarantee that holds the first time one writes two, rather than something doing work today.

**`x-request-id` on every response.** An operator reporting "it failed at 14:32" can hand over an exact id instead of a timestamp, and it resolves to the row. This is the correlation that pays off immediately.

Both fields are forwarded to a SIEM, which is where somebody most often asks what else happened in an operation and where the answer must not require our database. They are optional on the wire contract: a "send test message" payload belongs to no operation and names no entity, and requiring them would make an honest null impossible to express.

Null is a legitimate value throughout. Bootstrap, the retention sweeper and background workers belong to no request, and inventing ids for them would imply operations a reader could go and look for. Existing rows keep `NULL` for the same reason.

## [1.6.0] — 2026-08-13

Assigning a class stops being an act of memory. NexusPuppet can now read the class list from puppetserver and offer it, with each class's parameters, types and defaults (ADR-0024). Optional, off by default, and it degrades to exactly today's behaviour when unreachable. No migrations.

### Added

**The class list, read from puppetserver (ADR-0024).** `PUPPETSERVER_URL` enables a read-only client against `/puppet/v3/environment_classes`. The class name field suggests what exists; a class whose signature we have gets a real form — required parameters marked, `Enum` types rendered as a select with their own options, defaults shown. Assigning a class was previously two acts of memory: the name, and its parameter names. A typo in either is not a validation message — `node_terminus = exec` has no fallback to `site.pp`, so a class that does not exist fails catalog compilation for every node the group matches.

**This is not the dependency ADR-0003 forbids.** That rule is directional: nothing may make *Puppet* depend on *NexusPuppet* at runtime. This reads *from* puppetserver, out of band, and every part of it degrades to free text when unavailable. Agent runs are unaffected either way — the compile path is still `cat` on a local file.

**It cannot block a write.** No `PUPPETSERVER_URL` is silent and identical to before. A 403 — the usual case, since the endpoint is denied by default even to puppetserver's own certificate — falls back to free text and names the `auth.conf` rule to add. A timeout, a 50x, an unknown class, a parameter the form cannot express: all still assignable, with **Edit as JSON** reachable for every class at all times.

**Defaults are placeholders, never values.** Prefilling a class's default as a real value would send it back as an override — pinning the module's own default into every document the group produces, and freezing it so it stops tracking the module when that default later changes. A blank field means "let the class decide" and produces no key at all.

**Per-environment, and it says so.** The cache is keyed by environment and the picker is scoped to the environment that group will actually use. Showing `production`'s classes to a group pinned to `development` is wrong in the way hardest to notice: every name is real, just not there, and the failure surfaces later as a compile error.

**A Refresh that tells the truth.** An operator who has just deployed code can discard the cache and refetch. If the refetch returns an identical list, the console says so and names the likely cause — with `environment-class-cache-enabled` set, puppetserver serves its own cached classes until r10k flushes its environment cache. Flushing it is a mutation this ADR forbids us, so the honest move is to explain rather than appear broken.

### Changed

**The match strategy is editable after a group is created.** It was a read-only badge, so a group created as `PINNED` could never become rule-based — and the warning told operators to "switch the strategy to ALL_RULES", which the console offered no way to do. The plan contract had drifted the same way and would have previewed such a change against the node set of the strategy being left behind.

**Setting up the ENC is one command.** `scripts/setup-enc.sh` replaces the manual walkthrough: it checks the host, installs the puller and the ENC script, and proves the script serves a node before `--wire` puts it on the catalog compile path. `--remote` runs the whole thing over the operator's own SSH session, so there is nothing to clone on the Puppet server, and it leaves no key behind.

### Fixed

**Warnings about inert configuration name the strategy, not the membership.** "This group matches by pinned node" was read as "there are still pinned nodes" by an operator who had just deleted every pin. They also agree in the singular.

**`apps/web` has unit tests.** It had none; pure frontend logic was reachable only through the browser suite.

> Releases 1.5.2–1.5.13 are recorded in the GitHub releases rather than here.

## [1.4.0] — 2026-08-06

Classification learns to reach a puppetserver on another host (ADR-0019), and the first real ENC round-trip is done: a class assigned from the console reached a live agent's catalog. One migration, `enc_replication_peers`.

### Added

**Replicating the ENC tree (ADR-0019).** NexusPuppet serves the materialized tree over mTLS on its own listener, and a short-lived POSIX `sh` script on a `systemd` timer pulls it. `ETag`/`If-None-Match` makes an unchanged poll a cheap 304, and the whole tree is swapped by a single `rename(2)` of a symlink, so a compile in flight sees the old tree or the new one and never a mixture — stronger than `rsync --delay-updates`, which narrows that window rather than closing it.

**This is not the ENC endpoint ADR-0003 forbids.** The compile path is unchanged: the ENC script still reads a local file, with no process, network or interpreter beyond `/bin/sh` in it. The fetch runs out of band on its own schedule. Proven on real infrastructure — with NexusPuppet unable to serve at all, the sync failed and was recorded, the tree stayed, and a real agent compiled a catalog carrying its console-assigned classification.

**The allowlist is the control, not the certificate.** The endpoint is served with the certificate NexusPuppet already holds for PuppetDB — issued by the Puppet CA and carrying `serverAuth`, so nothing new is issued, distributed or rotated. Because that CA signs every agent in the estate, a valid client certificate proves membership and nothing more; `ENC_REPLICATION_ALLOWED_CERTNAMES` decides who may read how the estate is classified, and an empty list opens no listener at all.

**Every fetch is recorded** against the certname that made it, distinguishing a peer that is current from one that has never received anything. Materialized is not the end of the sentence; replicated is.

**Writing to production as a program (ADR-0020).** A dedicated automation account, resting deactivated with a dead credential and granted one task at a time, so a program's writes stay distinguishable from a person's in the audit trail. The revocation levers do not reach the same things, and the ADR states which is which — including that on the core edition none of them reaches a session already running.

### Changed

**Unavailable features render as a header, not a dead form.** Syslog, webhook, LDAP and OIDC previously drew their complete forms in core with every input disabled. The feature is still named, still explains itself, and still shows the capability token the API's 501 carries — without thirty controls nobody can fill pushing usable settings below the fold.

### Fixed

**The console can be reached by IP.** Browsers send no SNI for an IP-address URL (RFC 6066 permits DNS names only), so the bundled proxy had no site to match and answered TLS alert 80 — which surfaces as a handshake failure and reads like a broken certificate.

**The update check reports the version you are running**, not the newest published release. A deployment ahead of the newest release now says so, rather than displaying an older number where the installed one belongs.

## [1.3.0] — 2026-08-05

The audit trail learns to leave the box, and to stop growing (ADR-0016). No ENC contract changes; one new database expectation — none — the release runs no migrations.

### Added

**Audit forwarding, configured from the console.** Settings → Integrations gains syslog and webhook cards: RFC 5424 over TCP/TLS (UDP opt-in and labelled *unconfirmable delivery* everywhere it appears), test-before-save against the collector, secrets write-only, and one active transport at a time — saving a configuration never switches which transport delivers; activation is its own explicit act. Forwarding requires the `audit.export` capability; core renders the real cards, inert, and the API answers 501 naming the capability. The environment's `AUDIT_EXPORT_URL` remains the bootstrap baseline and stored settings win once written.

**Audit retention, in every edition.** `AUDIT_RETENTION_DAYS` (default 90) bounds the trail by age; `AUDIT_RETENTION_MAX_ROWS` is an opt-in ceiling for the burst case. The sweeper runs jittered and batched, never inside a request, and never age-sweeps a record still queued for delivery — the ceiling alone may, and every undelivered record it drops is counted, logged, and surfaced.

**The forwarding pipeline on the System card.** `GET /system/status` reports availability, the active transport, queue depth, the last delivery outcome, the UDP unconfirmable flag while it is in force, and the retention bounds with what the ceiling has cost. The unlicensed case is a state, not an omission.

**Shipping container logs to syslog.** A compose override example (`docker-compose.syslog.example.yml`) wires Docker's syslog driver with the TCP/TLS/UDP variants and their trade-offs stated; the user guide now draws the line between operational logs (the runtime's job) and the audit trail (the console's).

### Changed

**The sidebar names its links when collapsed and marks the active one** with a pill and a solid left border.

**The default projected-fact set is broader**, and checked against what modern Facter actually emits.

### Fixed

**Dark-theme contrast debt paid** across the console; the visual baseline is empty again.

## [1.2.0] — 2026-08-04

Appearance only. No behaviour, API or ENC contract changes; upgrading changes what the console looks like and nothing else.

### Changed

**A warm canvas, and a technical surface treatment for the light theme.** The background is parchment rather than near-white, overlaid with a faint two-axis grid derived from the line colour so it follows the theme. Cards and tables are translucent over it with a short backdrop blur, so the grid carries underneath as texture rather than stopping dead at each container edge. Light theme only — dark renders exactly as it did.

**Tags and run states are monospaced.** Environments, class names and statuses are set in uppercase mono: they are values the system produced, and they now look like it. Presentation only — the underlying text is unchanged, so anything reading a badge's label still sees the original string.

**Destructive actions are filled rather than tinted.** A delete button was a wash of the failed-run colour, which gave "delete this permanently" the same weight as a row that failed its last run. Critical actions now use a dedicated fill: the same hue in the role of an action, distinguished from the status by treatment.

### Fixed

**Amber run states no longer sit under the contrast floor on the light canvas.** Warming the background lowered its luminance and took the pending state to 4.48:1, below the 4.5 WCAG minimum. It is 4.79:1 on the canvas and 5.40:1 on a card.

**The sticky table header stays opaque** while the table around it is translucent, so scrolling rows do not show through the column labels.

## [1.1.0] — 2026-08-04

### Added

**A light theme, and a theme control.** The console defaults to dark and stays there unless asked otherwise — following the operating system is opt-in and is remembered. Contrast is checked in CI against WCAG thresholds rather than by eye.

**Card and control primitives.** Fields, hints, switches and action bars are shared components now, so a label stays associated with its control and a sub-task cannot drift back into the row holding Save.

**A rebuilt directory settings screen.** Grouped into cards by the decision each one asks you to make, with an empty state instead of a blank form, guidance reachable from the keyboard, and connection testing that reports into its own panel rather than beside Save.

**Deployment metrics.** Version, uptime, and database health, with an update check that runs only when you press it. Nothing contacts the internet unprompted, and being offline is reported as a normal result rather than an error — an air-gapped deployment is not a broken one.

**A self-signed fallback for the console certificate.** A first run with no certificate generates a placeholder that names itself as temporary, so the console serves HTTPS instead of failing to start. It is replaced through the same path as any other certificate.

**Custom roles.** Roles are rows rather than an enum, permissions are described in the console in words, and built-in roles are immutable — duplicate one to make a variant.

### Changed

**Core sees the real directory form, disabled.** It used to be a teaser card. Rendering the actual form, inert, with one quiet line explaining why, shows what the feature is without letting anyone fill in six fields, save, and discover later that nothing ran.

**The directory settings are locked until you ask to change them.** They render read-only with an explicit Edit, and a save states what it is about to change before it changes it.

**One build flag selects the edition.** `EDITION=enterprise` replaces four hand edits to the Dockerfile that had to be made together — making three of them produced an image that built, started, and silently ran core.

### Fixed

**A user's role name and role key could drift apart.** A directory sign-in that changed somebody's role updated the name the console displays but not the key every count and guard reads. The visible symptom was a Roles screen crediting the wrong role with the wrong number of people. The quiet one mattered more: the last-administrator guard counts through that key, so an administrator whose key was stale did not count as an administrator, and the guard was protecting a set that did not include them. Deployments are repaired automatically on upgrade.

**The console reported `0.0.0-dev` regardless of what it was running.** The version came from an environment variable that no build ever set. Images now stamp their own version at build time.

**The enterprise image could not be built from a clean checkout.** It required a lockfile that had been mutated locally, which is not a change that can be committed.

## [1.0.0] — 2026-07-31

First stable release. The console has been installed on real Puppet and OpenVox estates, and the API and ENC contract are now covered by semantic versioning.

### Highlights

**Plan before apply.** Every classification write — rules, classes, parameters, pins, rank, environment — opens a preview instead of writing. It reports how many nodes are affected, groups them by distinct outcome rather than listing them individually, shows the catalog diff per shape, and surfaces any conflict the change would introduce above that diff. On a large estate it samples rather than evaluating every node, and says so with the numbers. The forecast is computed by re-running the real rule evaluator and class merger against an in-memory copy of the classification, so a preview and the write it precedes cannot disagree about what an operation means.

**Estate-wide override report.** Where one node group is overriding another, across the whole fleet, grouped by which override it is and counted by nodes affected. Environment conflicts sort above everything regardless of count, because an environment disagreement decides which branch of a control repository a machine compiles against.

**Asynchronous ENC.** Classification is materialized to YAML on disk and `puppetserver` reads it with a dependency-free `cat`. There is no path by which a NexusPuppet outage can affect a Puppet run.

**User administration that does not need a shell.** Create, promote, deactivate, reactivate, reset a password, or delete an account permanently — with the guards that stop a deployment locking itself out, and an audit trail that survives the deletion of the person who acted.

### Added

- Node inventory, per-node facts, run history and resource-level run reports, read from PuppetDB over mTLS.
- Classification: node groups, fact-based matching rules, class assignment with parameters, top-scope parameters, certname pins, rank-ordered merge with conflict reporting.
- Transactional outbox — every classification change writes its materialization job and its audit row in the same transaction.
- Fact projection with incremental polling, keyset-paginated full reconcile, prune safety rails and deactivation handling.
- Local authentication: JWT sessions, scrypt hashing, account lockout, full audit trail, role-based authorization.
- `GET /system/status` and a dashboard card reporting queue depth, projection staleness and permanently stranded nodes.
- Optional bundled TLS proxy, terminating HTTPS for the console from an operator's own CA, plus a Settings card reporting the certificate's subject, the names it covers and how many days remain ([ADR-0013](docs/architecture/adr/0013-console-tls-private-ca.md)).
- OpenVox support, verified against a live `openvoxdb 8.15.0` operator by operator rather than assumed.
- User administration in the console: password reset with a generated strong password, a detail view reporting lockout state, failed sign-ins and live session count, and permanent deletion behind a typed-email confirmation. The same guards as every other user write — you cannot delete yourself, and you cannot remove the last active administrator.
- Named states for the pages nobody means to visit: a branded 404, an error boundary that keeps the console shell and says plainly that nothing was changed, and a last-resort boundary for a failure in the root layout itself.
- `scripts/qa/fuzz.mjs` — a seeded soak fuzzer that drives the console for a set duration and reports what it broke. Its first 30-minute run found three defects, two of which are fixed in this release.
- Enterprise layer, discovered at runtime and absent from this repository: LDAP/Active Directory, OIDC SSO, and audit export with a transactional delivery outbox.

### Fixed

Every entry here was found by running the product rather than reading it — three by an operator using the console, three by the soak fuzzer.

- **Sessions ended roughly once an hour and sent operators back to the login screen.** The console only exchanged its refresh token when the API answered `TOKEN_EXPIRED`, which the API can only say when it receives an expired token. The browser deletes the access cookie at its expiry, so the next request carried nothing, the API answered a bare 401, and the client gave up — holding a refresh token valid for another thirty days. The client now recovers from any 401. Session length is `REFRESH_TOKEN_TTL` and always was; `ACCESS_TOKEN_TTL` moves 15m → 60m as headroom, not as the fix.
- **Changing your own password signed you out.** The form said "this signs you out of every other session"; the implementation revoked every session including the caller's, so the person changing their password was logged out at their next refresh — up to an access-token lifetime later, with nothing connecting the two events. The caller's own session is now spared. An administrator resetting somebody else's password still ends all of theirs, which is the point of that action.
- **A mistyped class name returned 500.** The plan contract accepted names the write rejects, so `profile:monitoring` reached the ENC renderer and its assertion escaped as "internal server error". Both schemas are now asserted against the same inputs, and the dialog names the field rather than saying "invalid request parameters".
- **A malformed identifier in a URL returned 500.** A stale bookmark or a truncated paste reached Postgres as an invalid UUID. Every `:id` route now validates at the boundary, and a test reads the framework's own route metadata so a route added tomorrow without one fails in CI.
- **A group that no longer exists read as a failure.** A deleted or renamed id rendered the red "Request failed" banner — the same treatment a server error gets — sending operators to look for an outage that was not happening. Absence now reads as absence.
- **The plan grouped node populations without showing what it grouped by.** Four boxes each displaying the same single line, with the thing that made them different left undisplayed. Each population now states what it already has.

### Security

- **PuppetDB is read-only.** Queries are built as a parameterised AST; an interpolated PQL string is not reachable from any caller.
- **The web tier holds no credentials.** No database client, no PuppetDB certificate.
- Console ports bind `127.0.0.1` by default. Nothing in the stack terminates TLS unless the `tls` profile is enabled, so exposing them is a deliberate act.
- **The PuppetDB certificate cannot be restricted to reads, and the documentation now says so.** Earlier guidance advised granting "query access only" in `auth.conf`. Measured against OpenVoxDB 8.15.0: `auth.conf` does not govern `/pdb/*`, `certificate-whitelist` no longer exists, and `POST /pdb/cmd/v1` is accepted from any CA-signed certificate. Any agent certificate in the estate can read and write PuppetDB; only the network can bound it. See [DEPLOYMENT.md §3](DEPLOYMENT.md).

### Known constraints

Recorded rather than discovered — see [ROADMAP.md](ROADMAP.md#known-constraints) for the full list.

- **Not exercised at estate scale.** Correctness is verified against real Puppet and OpenVox estates; throughput is not.
- OIDC login state is in-process, so a load-balanced deployment needs sticky sessions.
- Login rate limiting is per replica. Account lockout is durable and unaffected.
- A `pg` deprecation warning is emitted by Prisma's own relation loading inside interactive transactions. Harmless today; re-check before any upgrade to `pg` 9.

### Deferred, with reasons

- **Scoped RBAC** ([ADR-0011](docs/architecture/adr/0011-scoped-rbac.md)) — designed in full and declined. Scoping by node group turns out not to bound anything, because group membership is fact-based and a scoped operator can rewrite a rule to match the whole estate.
- **GitOps classification mirror** ([ADR-0012](docs/architecture/adr/0012-gitops-classification-mirror.md)) — designed and held. Not rejected; simply not next.

### Notes for operators

The deployment path received the most attention in the run-up to this release, because that is where every defect found by real installs turned out to be — not in the application. CI now installs the product from `DEPLOYMENT.md` on every pull request and asserts that the bootstrap admin can log in, which is the check that would have caught all of them.

Two documentation corrections worth reading if you deployed from an earlier commit: the `auth.conf` guidance above, and the ENC script's failure mode. A non-zero exit from `nexuspuppet-enc.sh` **fails catalog compilation** for that node — earlier text described it as falling back to `site.pp` node definitions, which the `exec` terminus does not do. The behaviour is correct and deliberate; the description was wrong, and it made an outage sound survivable.

[1.0.0]: https://github.com/eth-man/nexuspuppet/releases/tag/v1.0.0
