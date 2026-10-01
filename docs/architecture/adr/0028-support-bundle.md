# ADR-0028 — The support bundle, and the API's own log history

- **Status:** Accepted
- **Deciders:** Project owner, architect
- **Related:** [ADR-0013](./0013-console-tls-private-ca.md), [ADR-0016](./0016-settings-store-and-audit-forwarding.md), [ADR-0021](./0021-operational-notifications.md)

## Context

The owner's requirement, in full: *"if someone has an issue in the product we need to have full log export for last 24 hours or something, export as archive so he can send it for support."*

Today nothing can produce that. The API logs to stdout through Nest's `ConsoleLogger` — coloured text, locale timestamps — and keeps nothing. Getting the last day out means somebody with a shell on the host running `docker compose logs api`, `journalctl -u nexuspuppet-receipts` and half a dozen other commands [DEPLOYMENT.md](../../../DEPLOYMENT.md) mentions in passing, then deciding for themselves what in the output is a secret.

**The incident that makes this concrete.** On 2026-09-30 it emerged that production had been blind to PuppetDB for six weeks: the Puppet server VM was powered off. The only traces were a WARN every 30 seconds in `docker logs` and one open `puppetdb.unreachable` condition. Nothing was hidden; nothing was obvious either. A support bundle that merely *contains* those facts has not solved the problem. It has to lead with them.

Two constraints shape everything below:

- **The API must never hold the Docker socket.** [ADR-0013](./0013-console-tls-private-ca.md) §1 rejected it for a certificate reload, because the socket is root on the host. Reading `docker logs` from inside the API is the same trade for a smaller feature.
- **Log shipping is the runtime's job.** [ADR-0016](./0016-settings-store-and-audit-forwarding.md) says so explicitly: operational logs stay on stdout, and getting them to a collector is Docker's syslog driver, not application code.

## Decision

**Two halves, one archive.** The console exports what the API can legitimately see; a host script collects what it cannot, and folds the console's archive in so support receives one file.

### 1. The API keeps a bounded copy of its own log

A `ConsoleLogger` subclass writes every printed line to stdout exactly as before **and** to `${LOG_DIR}/api-<hostname>.log`, one JSON object per line: `{ts, level, context, message, pid, host}`, ISO-8601 UTC, colour stripped.

**A subclass, not a wrapper,** so the live log-level mechanism (#160) keeps working unchanged: Nest reaches `printMessages` only for an enabled level, so the file records what stdout records. Raise the level to `debug`, reproduce, download — and the detail is there.

**Bounded by size, not by age.** Rotation at `LOG_FILE_MAX_BYTES` (20 MiB) keeping `LOG_FILE_KEEP` generations (5): at most 120 MiB per replica. Age-based retention would need a sweeper and still has no ceiling during a log storm; a byte bound holds whatever the API does. The cost is that a busy API at `debug` may hold less than 72 hours, which the manifest reports (§3).

**Synchronous writes.** Stdout in a container is a pipe, which Node writes synchronously on Linux — each log line already costs one blocking `write(2)`. A second one of the same size to a local file is the same order of cost. A buffered writer would lose its buffer on a crash, and the lines just before a crash are the ones a support bundle exists to carry.

**It never throws.** A missing or unwritable directory, a full disk: the copy disables itself, says so **once** on stderr, and the next bundle's manifest says why it has no API logs. A diagnostic side channel that could take the API down would be worse than none.

**One file per replica, in a shared volume.** Each replica writes its own file named by hostname, so a bundle exported from any replica includes all of them. Under Compose the hostname is the container id, so every redeploy starts new files; at start-up the API removes other hosts' files that nobody has written for longer than the widest window plus a day. It never removes its own, and a replica whose file is removed underneath it notices on its first write after at most a minute, and reopens.

### 2. `GET /system/support-bundle?hours=N`

`settings:manage`, `hours` 1–72 (default 24), Zod-validated. The response is `application/gzip` — **never** `Content-Encoding: gzip`, which the web relay's `fetch` would silently decode — with `Content-Disposition: attachment` and `no-store`.

The archive is USTAR, from the writer replication already uses, gzipped with Node's zlib. **No new dependency.** The writer gained an optional `mtime` and a chunk generator so the archive streams into gzip; replication's output is byte-identical, pinned by fixed hashes in its tests, because its ETag is the hash of those bytes.

**Assembled before the first byte is sent,** so a failure is an ordinary error response rather than a truncated archive behind a 200.

**Degrades, never refuses.** Each section is collected separately and a failing one becomes a file saying why. The bundle is needed most when something is broken, and a database outage is one of the things that breaks.

**Audited first, through `AUDIT_SINK`**, so it is forwarded like any other record — and the bundle contains its own export row, a cheap end-to-end proof the audit path works. If the audit write itself fails (the database is down), the export proceeds and says so in the bundle and in a WARN line naming the user id. Refusing the one tool that diagnoses the outage because the outage prevents a row is the wrong way round; the caller's authority does not depend on the database.

A GET that writes an audit row is unusual. The row records a **read**, the same kind [ADR-0025](./0025-estate-wide-resource-search.md) §6 audits for resource parameters, and a download is a navigation: the console uses a plain `<a download>`, as the node CSV export does.

### 3. The bundle leads with what needs attention

`summary.txt` and `manifest.json`'s `attention` list open conditions first, critical before warning, **with how long each has been open**: *OPEN CRITICAL condition "puppetdb.unreachable" since 2026-08-19 (42 days)*. Then conditions resolved within the window, a stale node cache, failed materialization jobs, a backed-up audit queue, and every gap in the logs.

**Log coverage is stated, not implied.** For each replica: the earliest and latest line on disk and in the window, and whether history reaches the window's start. After a cap or a rotation at `debug`, "24 hours" may not have been 24 hours, and a reader must not have to infer that from the first timestamp.

Logs are capped at 100 MiB across all replicas, dropping the **globally oldest** lines first and stopping at the first line that does not fit — a hole in the middle of the history would be worse than a clean starting point.

### 4. Secrets: an allow-list first, a redaction pass second

**Every collector reads an allow-list.** Queries name their columns, so a future column is invisible until somebody decides it belongs. Environment variables are shown only if classified as configuration; secrets and identities appear as `set`/`unset`; anything unclassified is listed by name with its value withheld. A test fails when `envSchema` gains a variable nobody classified.

- `ProviderSetting.secrets` is **never selected and never decrypted**. The bundle says whether a sealed blob exists and which field names the kind can hold — reading the actual names would mean decrypting.
- Audit rows carry `createdAt`, `action`, `entityType`, `entityId` and `requestId`. **Not** actor id or email, client IP, user agent, `before`/`after` (which can hold classification parameter values, and parameter values can be credentials), or `entityLabel` (a person's email for a user change, a free-text name for a saved query). A `User` entity's id is withheld too.
- Users are counted per role, never listed.

**Then every text file is redacted.** Literal values of every secret environment variable (≥ 6 characters, as-is and JSON-escaped, longest first), PEM private keys, `scheme://userinfo@`, JWTs and email addresses become `[REDACTED:<rule or name>]`, and the manifest counts each. This is a pure, unit-tested function; it is the second line of defence for what an allow-list cannot see — a secret that reached a log line.

### 5. The host script collects what the API must not see

`scripts/support-bundle.sh`, run by an administrator on the console VM or on a Puppet server with only the timers: `docker compose ps` and `logs` per service, a summary of `docker info`, `docker system df`, host facts, the `nexuspuppet-*` timers and their journal, `docker.service`'s journal, and `git describe`. `--include` embeds the console's archive untouched.

It **never** runs `docker compose config` or a full `docker inspect`: both print the environment with every secret expanded. `.env` goes through the same allow-list idea, and the literal values of its secrets are masked in every collected file, with the same structural rules as the API's pass. A service on the syslog driver gets a note saying where its logs went, not an empty file that reads as "it was quiet".

### 6. Opt-in: configuration and personal data

Sometimes the problem *is* the configuration or a person's account — a group that classifies the wrong nodes, an operator locked out, a change nobody can attribute. So the operator may **tick** "Include configuration and personal data", per download: `GET /system/support-bundle?hours=N&includePersonalData=true`. Same permission.

**The default does not move.** Unticked is the bundle described above. The tick is not remembered between visits, and the parameter accepts exactly `true` or `false` — a query string is text, and a loose boolean parse reads `"false"` as true, which is the one direction a privacy switch must never fail in.

**What the tick adds, and nothing else:**

- `audit/audit-log.jsonl` with actor id and email, client IP, user agent, entity label, and `before`/`after`.
- `personal/users.json`: email, display name, role, source, active state, last login, failed attempts and lockout, created/updated — and a **count** of live sessions per user. Never the password hash; nothing from `refresh_tokens` but that count.
- `config/classification.json`: every group with its rules, pins, classes and parameter values **in full**. Parameters can hold secrets, and the console says so next to the tick.
- `config/saved-queries.json`: owner email, name, kind, filter, sharing.

These are collected by their own explicit-column queries; the tick widens the allow-list, it does not replace it.

**Never included, ticked or not** — the invariant, stated in every manifest as `neverIncluded`:

- secret environment values (reported as set/unset, and their literals redacted wherever they appear — including inside a class parameter);
- stored provider secrets: the sealed column is never selected, never decrypted;
- password hashes, refresh tokens or their hashes, access tokens;
- private keys.

**The redaction pass still runs over every file.** The single change is that the email rule stands down, and an identity-only environment variable (`BOOTSTRAP_ADMIN_EMAIL`) stops being a redaction literal: masking addresses would defeat what was asked for. No option exists to switch off a secret rule.

**It cannot be mistaken for the safe variant.** The filename gains `-with-personal-data`; `manifest.json` puts `includesPersonalData` directly after `format`, followed by the list of what was added; `summary.txt` opens with a warning. The export's audit row records the choice in `after.includePersonalData` and its label, so "who exported the user list, and when" is answerable from the trail — and forwarded to the SIEM with everything else.

### Binding constraints

- The API gains **no** access to the Docker socket, the journal or the host filesystem beyond its own log directory.
- The log copy is **never** the primary sink and is **never** shipped anywhere by the application. [ADR-0016](./0016-settings-store-and-audit-forwarding.md)'s boundary stands.
- A bundle **never** contains a secret value, a stored provider secret, a password hash, a token or a private key — with or without the opt-in (§6).
- Without the opt-in, a bundle never contains a user's identity, a client address, a user agent, an audit payload or the classification's parameter values.
- New collectors must select columns explicitly, in both variants.

## Consequences

**Gained.** One button and one command produce everything support needs, redacted, with the incident at the top. A dead Puppet server for six weeks now reads as the first line of the first file.

**Paid.**

- Up to 120 MiB of disk per API replica, and a second `write(2)` per log line.
- A new named volume, `api-logs`. The image creates `/var/log/nexuspuppet` owned by uid 100 so a fresh named volume inherits it; a **bind mount** does not, and must be created writable by uid 100.
- The allow-lists must be maintained. The environment one is enforced by a test; the column lists are enforced by review.
- Assembly holds the window's logs in memory — at most the on-disk files of every replica — for the duration of one request.

**Not bought.**

- **Not log shipping, and not a log viewer.** Nothing reads the file except the bundle.
- **Not tamper-evidence.** The copy is as trustworthy as the process writing it.
- **Not complete for other log drivers.** Under the syslog driver the host script cannot read container logs; the API's own history is unaffected because it does not depend on the driver.
- **Not the web or proxy logs.** Those are container stdout; the host script collects them.

## Alternatives considered

**Give the API read access to `docker logs`.** Through the socket it is root on the host (ADR-0013); through a socket proxy it is a new privileged component to operate for a diagnostic feature. Rejected.

**Tee stdout to a file with a sidecar or the runtime's `local` driver.** Keeps the application out of it, but the API still could not read another container's volume without new mounts, and every deployment that already uses the syslog driver would lose the history. The in-process copy works under any driver.

**Ship logs to the database.** Puts diagnostic volume on the one component that must stay healthy, and makes the bundle useless in exactly the outage where the database is the problem.

**Deny-list redaction only.** A deny-list fails open: the next secret added is exported the day it is added. The redaction pass is kept, as a second line behind allow-lists, never instead of them.

**Personal data always, or never.** Always makes the default file unsafe to attach to a ticket, which is where most support bundles go. Never leaves support blind exactly when the fault is an account or a group. A per-download opt-in, marked in the filename and audited, serves both without letting one pass for the other.

**Build the archive with a tar library.** A dependency for a few hundred bytes of header arithmetic the repository already has and tests against the system `tar`.
