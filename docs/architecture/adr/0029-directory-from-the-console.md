# ADR-0029 — A directory is enabled from the console

- **Status:** Accepted
- **Deciders:** Project owner, architect
- **Related:** [ADR-0015](./0015-hybrid-authentication.md), [ADR-0016](./0016-settings-store-and-audit-forwarding.md), [ADR-0023](./0023-several-authentication-sources.md), [ADR-0027](./0027-one-product.md)

> **Amended 2026-10-05 ([ADR-0030](./0030-ldap-connection-fields.md)).** The
> decisions here stand. What changed is the LDAP form §7 describes: the
> *Server URL* field is replaced by **Server name or IP**, **Port** and
> **Protocol** (LDAPS | STARTTLS — STARTTLS is new, unencrypted LDAP can no
> longer be saved), the *Directory type* select is gone because the type is
> detected from the server's RootDSE, and **Bind type** (Regular | Simple |
> Anonymous) decides which credentials are asked for. Read "URL" below as
> "server, port and protocol". Configurations saved under this ADR are read
> unchanged.

## Context

An operator upgraded an old core install to 1.10.1. Settings → Directory / Auth showed LDAP and SSO as *NOT ENABLED — Set LDAP_URL and restart the API*. To them the product "still behaves like core": every feature is in the image (ADR-0027), and the one they came for could only be switched on by editing `.env` on the host and restarting.

That was by design, and the design said so. ADR-0016 §4 drew the line: *what a provider points at* is read through the settings store and reloads live, but *which providers exist at all* is fixed at boot, so "turning LDAP on for the first time still requires a restart". ADR-0027 §5 kept that rule and left the obvious follow-up open: register both providers always, and let an operator enable a directory from the console. It changes what "validated at boot" means and removes the restart-required path, so it deserved its own decision. This is it.

The restart was the smaller half of the problem. Two more things stood between that operator and a working directory:

- **No `CONFIG_ENCRYPTION_KEY`.** The settings store encrypts a bind password or client secret with it, and refuses to save one without it (ADR-0016 §3). `scripts/deploy.sh` never generated one. Staging and at least one real deployment had none, so the console could not store a bind password at all — and the error said a configuration "holds a secret" without saying which, or what to run.
- **No way to trust an internal CA.** On-premises directories are almost always signed by a private CA. The only way to give the API one was `LDAP_CA_PATH`, a mounted file — host access again. Without it, `ldaps://` fails verification, and the one switch the console *did* offer was turning verification off.

## Decision

**LDAP and OIDC are configurable and enable-able entirely from the console, effective at the next sign-in, with no `.env` edit and no restart. Local accounts are never affected.**

### 1. Both directory providers are always registered

`LdapAuthProvider` and `OidcAuthProvider` are registered on every deployment, after `LocalAuthProvider` in `AUTH_PROVIDERS`. Registration no longer depends on configuration.

A provider's effective configuration is resolved per sign-in, in the precedence ADR-0016 §2 already set:

| Stored row (database) | Environment (`LDAP_*`, `OIDC_*`) | Effective |
|---|---|---|
| present | — | the stored row |
| absent | set | the environment baseline |
| absent | unset | none: **dormant** |

`SETTINGS_SOURCE=env` still forces the environment and ignores stored rows.

### 2. A dormant provider is invisible from outside, and refused like a wrong password

`IAuthProvider` gains an optional `isConfigured?(): Promise<boolean>`. Absent means configured, so the local provider and every test double need nothing. The resolver asks it per request, because a save or a discard changes the answer while the process runs.

A dormant provider:

- **is not offered on the login page.** `descriptors()`, and so `GET /auth/mode`, omit it. A button for an identity provider nobody configured is a dead end, and on a deployment that never wanted SSO it would be a feature announcing itself to strangers.
- **is not the redirect provider.** `GET /auth/redirect` answers as it would on a deployment without one.
- **refuses its accounts with the same answer as a wrong password**, inside the resolver's timing floor (ADR-0015 §2). A dormant directory answers without any network round trip — the fastest refusal there is, and so the most tempting oracle. The floor covers it like every other path, and a unit test fails on timing if it ever stops.
- **ends its sessions at the next refresh**, as a deregistered provider always has (ADR-0015 §3, resolved question 3).
- **logs why.** One WARN naming the reason — *LDAP sign-in is not configured* — once per change of state, not once per attempt. Only an account that exists with that source reaches this branch, so a stranger cannot drive it.

`sources()` still lists every *registered* source, so an administrator may create accounts with `authSource: ldap` or `oidc` **before** enabling the directory. The create-user dialog reads a new authenticated endpoint, `GET /users/auth-sources` (`users:manage`), which lists every registered source with a `configured` flag. A dormant source is offered and labelled *not configured yet*, and is never the default: ADR-0023 §4's "one directory → default to it" counts configured directories only, because defaulting to one that cannot sign anybody in is the wrong guess every time.

A provider whose `isConfigured()` throws despite the contract is treated as configured. It then answers the login itself and fails loudly there, which is better than quietly vanishing from the login page.

### 3. Changes are live; there is no restart-required path

Saving from the console takes effect at the next sign-in, including the **first** save on a deployment that never set `LDAP_URL`. `liveReload` is always true for both directories. The "restart is required" log lines, the console's restart notices and the *Not enabled — set LDAP_URL* card are removed.

**Test before save works with no boot configuration.** The LDAP provider already built a client per candidate. The OIDC provider used to ignore its candidate and check the boot configuration, which on a fresh deployment does not exist; it now builds discovery and key-set clients for the candidate.

**Discarding returns a provider to its baseline.** `DELETE /settings/auth/{ldap,oidc}` removes the row, and the provider falls back to the environment — or, with none, goes dormant: its accounts are refused at the next sign-in and its sessions end at the next refresh.

**Local accounts are never affected.** They do not go through a directory provider at all (ADR-0015). `app.wiring.spec.ts` pins `LocalAuthProvider` first in `AUTH_PROVIDERS` on every configuration, including the new "nothing configured" case.

### 4. What "validated at boot" means now

Unchanged where it can be: `config/integrations.ts` still reads `LDAP_*`, `OIDC_*` and `AUDIT_EXPORT_*` once, and a value that is **present but malformed** still throws `IntegrationConfigError` and stops the API. A deployment that believes its environment configures a directory must still never quietly run without one.

What it no longer means is "the set of directories is decided at boot". A stored row is validated when it is saved and parsed again at each sign-in. A stored row that no longer parses — a downgrade, a hand edit — refuses directory logins with `PROVIDER_ERROR` and a log line naming the fields. It is not treated as dormant: the directory is configured, just broken, and an operator should hear about it rather than watch it disappear.

### 5. The LDAP CA certificate can be pasted

The stored LDAP configuration accepts `caPem`: the PEM text of one or more `CERTIFICATE` blocks.

- **It is public, so it is ordinary configuration.** A CA certificate is what every client is handed. It is stored in clear and returned by a read, like the syslog collector's `caCert`. It is not a secret field.
- **Validated on save.** The contract's schema refuses a `PRIVATE KEY` block with a message that says so, and requires a `CERTIFICATE` block. The API then parses each block as X.509 with `node:crypto`, refuses any other PEM type by name, and refuses a CA beside disabled verification, where it would be silently ignored — the same rule `LDAP_CA_PATH` has at boot.
- **Precedence.** The directory client uses `caPem` when present, else `caPath`. A stored row with neither inherits the environment's `caPath`, as before.
- **The environment is unchanged.** `LDAP_CA_PATH` still names a mounted file, and `ldapConfigFromEnv` never reads PEM text. Certificate material in an environment variable ends up in `docker inspect` and crash reports; a database row does not.
- **Shown back.** The settings view parses the stored bundle with the same summariser as the console certificate card (ADR-0017), and the form lists each certificate's subject, issuer and expiry, so an operator can see they pasted the CA they meant.

### 6. `deploy.sh` generates `CONFIG_ENCRYPTION_KEY`

When `.env` has no `CONFIG_ENCRYPTION_KEY` line, `scripts/deploy.sh` appends one — `openssl rand -base64 32`, with a comment saying where it came from — on first install **and on upgrade**, and prints a line saying it did.

This is **the one deliberate exception** to "an existing `.env` is never touched", and the exception is narrow:

- A line with a value is never modified, moved or removed.
- A line that is present but empty is left alone and reported. Editing it would break the rule; appending a second would leave two.
- Nothing else is appended, ever.

**Why it is safe when touching anything else is not.** The rule exists because regenerating a secret invalidates what it protects: a new `JWT_SECRET` signs everybody out, a new `POSTGRES_PASSWORD` locks the API out of its database. With no `CONFIG_ENCRYPTION_KEY`, no stored secret can exist — the store refuses to save one — so a new key cannot make anything unreadable. Without it, the console cannot store a bind password or a client secret, and enabling a directory from the console fails at the first credential.

`scripts/test/deploy-config-key.sh` lifts the function out of `deploy.sh` and pins each rule under `dash`, without Docker. The install-smoke CI job asserts the generated key reaches the API container.

When the API has no key, the directory settings say so **before** anybody types a password, in the same words the API refuses with: *Saving a bind password needs CONFIG_ENCRYPTION_KEY. Re-run scripts/deploy.sh, which generates it, or set it in .env and restart.* The settings view reports `secretsStorable` for that purpose. A directory that searches anonymously still saves without a key.

### 7. The console

The *Not enabled* card is gone. Each directory is a named region on Settings → Directory / Auth, with a badge saying where its configuration comes from: **Not configured**, **From the environment** or **Saved in the console**. With nothing configured the region is an empty state with one button, which opens the form unlocked. Otherwise it is the form, locked at rest, as ADR-0016 requires.

Regions, not just headings, because both directories are now always on the page and their cards share titles — each has *Role mappings* and *Edit settings*. Without a named boundary a screen reader user hears two identical headings, and so does a test. Four LDAP form tests failed in exactly this way whenever OIDC was also configured. They are now scoped to their region.

The badge is configuration provenance, not a Puppet state, so it does not go through `lib/status.ts`. DNs, URLs and PEM are monospace. Hiding a control is presentation only: every settings route still requires `settings:manage` in the API.

### 8. Audit

Saving and discarding directory settings were already audited. Saving now commits **the change and its audit record in one transaction**, as discarding already did. What prevented it before was the `after` payload, built by reading the row back outside the transaction. It is now built from the submitted configuration without its secrets, which is exactly what the store keeps in clear.

## Consequences

- **An upgraded install can enable a directory with no shell access.** The `.env` edit and the restart are gone from the directory path. The environment still works as a baseline, and `SETTINGS_SOURCE=env` is still the escape hatch.
- **`GET /auth/mode` changes meaning slightly.** It lists *configured* sources, not registered ones. On a deployment with no directory it answers exactly as before: `local` only.
- **One new authenticated endpoint**, `GET /users/auth-sources`, and two new fields on the directory settings views: `secretsStorable` on both, and `caCertificates` on LDAP.
- **Resolver methods that depend on configuration are async:** `descriptors()`, `redirectProvider()`, `describableProvider()` and `credentialProviders()`. `sources()` stays synchronous, because it is about registration.
- **Every deployment logs `Authentication sources: ldap, local, oidc` at boot**, configured or not. That line is about registration. Whether a source can sign anybody in is on the settings screen, and in `GET /auth/mode`.
- **`deploy.sh` now changes `.env` once** on an install without a key. The change is one appended line, and the operator is told. It should be backed up with the rest of `.env`.
- **ADR-0016 §4 and ADR-0027 §5 are amended** to point here.

## Alternatives considered

- **Keep registration at boot, and restart the API from the console after the first save.** Rejected. It gives the console a way to restart the process, which means the Docker socket or a supervisor hook, and ADR-0013 already refused the socket for less. It also keeps a window where a saved configuration is not in force, which is the confusion this ADR removes.
- **Register only once something is stored, by rebuilding the DI graph at runtime.** Rejected. Nest does not support adding providers to a running module, and the resolver's provider set would become mutable state for no gain over a provider that knows it is dormant.
- **Offer dormant directories on the login page, and let them fail.** Rejected. It is a dead button for every user, and it advertises an unconfigured feature to unauthenticated visitors.
- **Accept inline PEM in the environment too (`LDAP_CA_PEM`).** Rejected, for the reason `caPath` exists: certificate material in an environment variable leaks into `docker inspect`, process listings and crash reports. The console path stores it in a database row, where it belongs.
- **Have `deploy.sh` fill in an empty `CONFIG_ENCRYPTION_KEY=` line.** Rejected. It is an edit of an existing line, which is the thing the rule forbids, and an empty line may be somebody's deliberate placeholder. The script reports it instead.
- **Generate the key inside the API at first boot and store it in the database.** Rejected. The key would sit beside the ciphertext it protects, which is what ADR-0015 resolved question 2 decided against.
