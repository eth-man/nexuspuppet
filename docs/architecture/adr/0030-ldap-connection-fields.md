# ADR-0030 — LDAP connection fields an operator recognises

- **Status:** Accepted
- **Deciders:** Project owner, architect
- **Related:** [ADR-0015](./0015-hybrid-authentication.md), [ADR-0016](./0016-settings-store-and-audit-forwarding.md), [ADR-0029](./0029-directory-from-the-console.md)

## Context

ADR-0029 put the directory in the console. The form it shipped asked for a **Server URL** — `ldaps://dc01.example.com:636` — a **Directory type** (Active Directory or OpenLDAP), a **Bind DN** and a **Bind password**.

An operator configuring LDAPS against a real Active Directory said what was wrong with it:

> I don't like the GUI part here, it should be more simple instead of typing ldaps://url:port. We need these fields: Server Name/IP instead of Server URL; Port; Bind type = Regular | Simple | Anonymous (Regular is default); User DN; Password; Protocol = LDAPS | STARTTLS instead of Active Directory and OpenLDAP.

The list is the LDAP server form of the firewall they already run. It is also the vocabulary of nearly every LDAP client they own, and it exposes three things the old form got wrong:

- **A URL is three decisions in one string.** The scheme decides encryption, the authority decides the server *and* the name the certificate is checked against, and the port is optional and easy to get wrong. An operator assembling `ldaps://…:636` by hand is doing the parsing.
- **Only LDAPS and cleartext existed.** STARTTLS — the plain port, upgraded before anything is sent — was not supported at all, though it is how many directories are configured and what their operators expect to choose. Meanwhile `ldap://` was accepted, and sent every password in clear.
- **The directory type was a guess the operator had to make, and it mattered.** It selects the search filter (`mail` for OpenLDAP; `sAMAccountName`/`userPrincipalName` for AD), the login label and whether nested groups exist. Choosing wrong refuses every login with a message that points nowhere near the select. The server already knows what it is, and says so in its RootDSE.

"Anonymous" was there too, but implied: an empty Bind DN meant anonymous search. "Simple" — no service account at all — did not exist.

## Decision

**The LDAP form asks for Server name or IP, Port, Protocol (LDAPS | STARTTLS) and Bind type (Regular | Simple | Anonymous), and the directory type is detected from the server rather than chosen.**

### 1. Server, port and protocol replace the URL

The stored configuration holds `host`, `port` and `protocol` (`ldaps` | `starttls`). The client's URL is derived: `ldaps://host:port` for LDAPS, `ldap://host:port` for STARTTLS (IPv6 bracketed).

- **Port follows the protocol** — 636 for LDAPS, 389 for STARTTLS — until the operator types one. After that it is theirs: a Global Catalog on 3269 must not be reset by a change of mind about the protocol.
- **There is no unencrypted option.** The form offers two protocols, the API refuses a third, and `ldap` survives only as the protocol of a configuration saved before this decision (§6).
- **The server name is validated where it is typed**, with messages that say where a stray part belongs: a pasted `ldaps://` is told to use Protocol, a pasted `:636` to use Port. The same functions run in the browser and the API (they live in contracts).
- **"Use the name on the certificate"** is the field's help text, because that name is what the certificate is verified against — for STARTTLS as well, where Node would otherwise check it against `localhost`, since the socket it upgrades carries no name. The name is also sent as SNI; an IP literal never is (RFC 6066 §3).

### 2. STARTTLS, failing closed

STARTTLS is implemented with `ldapts`' `startTLS(tlsOptions)`, called **immediately after connecting and before any bind** — service account, anonymous search or user — on **every** connection the client opens. Its TLS options are LDAPS's: the pasted CA or `LDAP_CA_PATH`, verification, the server name.

It fails closed, in three ways a test can see:

1. **A refused or failed upgrade ends the operation.** The client throws before returning a connection, and nothing that carries a credential has been sent. Test connection says *The server refused STARTTLS … It may have no certificate configured for STARTTLS, or expect LDAPS on port 636. No credentials were sent.* — and names a certificate problem as a certificate problem.
2. **A handshake that never finishes times out**, with the configured timeout, instead of hanging a login.
3. **A dropped session is not reconnected.** `ldapts` reconnects a closed socket transparently before the next operation, and its reconnect is plain TCP: a bind after a lost STARTTLS session would go out in clear on a new socket. The client is given a connection factory that opens exactly one socket and refuses a second.

The proof is not a unit test alone. The OpenLDAP fixture gained a second directory with no TLS, and a recording proxy between it and the client shows that the bytes sent hold the StartTLS request and nothing else — no BindRequest, no search, no DN, no password. A second proxy plays a stripping attacker that answers "STARTTLS accepted" and then speaks no TLS; the client sends a ClientHello, gets nothing, and gives up.

### 3. Bind types

`bindType` is explicit, and each one's fields are required and the others' are dropped:

| Bind type | Fields | Flow |
|---|---|---|
| **Regular** (default) | User DN, Password | Bind as the service account, search for the person, bind as the DN found. Unchanged. |
| **Anonymous** | — | Search without binding, then bind as the DN found. What an empty Bind DN used to imply. |
| **Simple** | User DN pattern | No service account. Bind directly as the identity built from the pattern, then read the person's **own** entry, as them, on the same connection, for email, display name and groups — nested groups through the AD matching rule when enabled. |

**A Simple pattern is a DN or a UPN, and nothing else.** It contains `{username}` exactly once.

- **A DN** (`uid={username},ou=people,dc=example,dc=com`) has `{username}` as a whole attribute value, and the username is escaped for DN context — RFC 4514, whose specials are `, + " \ < > ; =` and a leading space or `#` and a trailing one. That is a different set from filter escaping (RFC 4515), and the tests hold both apart. A username cannot add an RDN, add a value to the RDN, or end the value: `alice,ou=admins` is one `uid` that no entry has.
- **A UPN** (`{username}@corp.example`) is not a DN, so there is nothing to escape into. Anything that could name a different account — `@`, `\`, DN specials, whitespace, filter specials — is refused. The entry is then found by searching for **exactly the bound UPN**, never for the typed name: on AD a typed `jdoe` can be another account's `sAMAccountName`, and its groups would be granted to whoever knew the first account's password. More than one match is refused rather than guessed.
- **Control characters are refused** in both, before any network round trip.

**No new login oracle.** Every Simple refusal — an unusable username, a rejected bind, an entry the person may not read — is the same `INVALID_CREDENTIALS` as a wrong password, inside the resolver's timing floor (ADR-0015 §2).

**An empty password authenticates nobody, in any bind type.** The provider already refused it before binding; the client now refuses it too, without opening a connection, so a future caller cannot forget. The fixture is configured to *accept* an unauthenticated bind, which is what makes the test of this mean something.

### 4. The directory type is detected

At Test connection and at Save, the API reads the RootDSE (base `""`, scope base). `1.2.840.113556.1.4.800` — LDAP_CAP_ACTIVE_DIRECTORY_OID — in `supportedCapabilities` means `ad`; any other readable RootDSE means `openldap`. An empty one is not evidence of anything.

- **Hidden from anonymous readers:** a Regular configuration binds as the service account and reads it again. Still unknown is treated as OpenLDAP, and the Test result says so in words.
- **Stored with the configuration** as `detectedDialect`, and shown read-only: *Detected: Active Directory*. A value in a request body is ignored.
- **A directory unreachable at Save** does not block the save. What was detected before is kept if the server is the same host and port; otherwise nothing is stored, which means OpenLDAP.
- **The environment does not detect.** That would need the network at boot. `LDAP_DIALECT` still decides it, exactly as before — an AD configured from the environment without it would otherwise switch filters on upgrade and refuse everyone who types an email.

### 5. Labels

**User DN** and **Password** are the service account's (Regular only); they are hidden for Anonymous and Simple. **CA certificate (PEM)**, **Verify TLS**, **Search base**, **Group search base** and **Role mappings** are unchanged.

### 6. Compatibility, with no migration

The configuration is JSON in `provider_settings`, so no schema change is needed and none is made.

- **Rows saved by v1.11/1.12** hold `url` (+ `dialect`, optional `bindDn`). They are read for ever, by one function in contracts that both the settings view and the provider use: `ldaps://h:p` becomes LDAPS; the stored `dialect` becomes the detected one; `bindType` is inferred — a bind DN *with* a stored password is Regular, anything else Anonymous. (The old client bound only when it had both, so a bind DN without a password was always an anonymous search, and still is.)
- **`ldap://` rows keep working exactly as before.** The form shows them as *Unencrypted (legacy) — choose LDAPS or STARTTLS to save*, and the API refuses to save one.
- **API clients** may still send `url`; an `ldaps://` one is converted, an `ldap://` one refused with the same message.
- **The environment:** `LDAP_URL` is read unchanged. `LDAP_STARTTLS=true` upgrades an `ldap://` URL; `LDAP_BIND_TYPE` and `LDAP_USER_DN_PATTERN` give it parity with the console. A contradiction — STARTTLS with `ldaps://`, Simple with a bind DN, a pattern without Simple — refuses to boot (`IntegrationConfigError`), as every malformed `LDAP_*` value does.

## Consequences

- **The form matches what an operator already knows**, and the decision most likely to be got wrong — the directory type — is no longer theirs to make.
- **STARTTLS is supported, and an unencrypted directory can no longer be configured.** Existing ones keep working until somebody changes them.
- **A deployment without a service account is possible** (Simple). It needs users to be able to read their own entry; the Test result says that Simple cannot be fully tested without a person's credentials, and stops at connecting.
- **Test connection opens two connections** — the RootDSE read and the probe search — because the probe needs the detected dialect's filter.
- **Save contacts the directory.** It does not depend on it: an unreachable directory saves, keeping what it knew.
- **Regular bind with no password anywhere is refused at Save** (`BIND_PASSWORD_REQUIRED`). Before, it saved and searched anonymously, which is a configuration that says one thing and does another.
- **Switching away from Regular discards the stored service-account password**, through a new `drop` option on the settings store's save; otherwise "a password is stored" would go on being true of a configuration that has no use for one.
- **ADR-0029 is amended** to point here: its *Server URL* and *Directory type* fields are replaced.

## Alternatives considered

- **Keep the URL and add a protocol toggle beside it.** Rejected. It leaves the operator parsing, and a URL whose scheme disagrees with the toggle is a new way to be wrong.
- **Keep the Directory type select as an override beside detection.** Rejected for the console. It is the field the operator asked to remove, and the one most often wrong. `LDAP_DIALECT` remains for the environment, and for a server that hides its RootDSE from everyone the console can bind as.
- **Offer unencrypted LDAP as a third protocol "for test directories".** Rejected. Every password typed into the console would cross the network in clear, and a test directory can use STARTTLS with verification off — warned about, but encrypted.
- **Fall back to plaintext when STARTTLS is refused.** Rejected outright: that is the downgrade STARTTLS stripping exploits.
- **Find a Simple-bind user's entry by searching for the typed name.** Rejected: on AD a typed name can match a different account than the UPN that authenticated, and that account's groups would be granted.
- **Escape a UPN like a DN.** Rejected: a UPN is not parsed as a DN, so escaping protects nothing; refusing the characters that could change the account is what does.
- **Migrate stored rows to the new shape.** Rejected. A read-time upgrade does the same with no downgrade hazard and no migration to run, and a downgraded build still finds the `url` it wrote until somebody saves again.
