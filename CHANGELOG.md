# Changelog

Notable changes to NexusPuppet. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
