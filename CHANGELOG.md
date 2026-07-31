# Changelog

Notable changes to NexusPuppet. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
