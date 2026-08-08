# ADR-0023 — Several authentication sources at once

- **Status:** Proposed (2026-08-08)
- **Deciders:** Architect
- **Related:** [ADR-0015](./0015-hybrid-authentication.md) (supersedes its "not
  multi-directory" consequence), [ADR-0006](./0006-auth-local-jwt-modular-sso.md),
  [ADR-0002](./0002-open-core-runtime-discovery.md),
  [ADR-0014](./0014-enterprise-licensing.md)

## Context

A deployment may configure LDAP **or** OIDC, never both. The enterprise layer
refuses at boot:

```
Both OIDC_ISSUER and LDAP_URL are set. NexusPuppet supports one
authentication provider at a time; unset whichever this deployment does not use.
```

The reason given in the code beside it is that *"exactly one authentication
provider may own `AUTH_PROVIDER`"*. That was true under
[ADR-0006](./0006-auth-local-jwt-modular-sso.md), where `TokenService` injected a
single `IAuthProvider`. **[ADR-0015](./0015-hybrid-authentication.md) removed
it.** The token became `AUTH_PROVIDERS`, plural, and core gained a resolver that
maps `authSource` → provider. The guard outlived its reason and nobody went back
for it.

### How it surfaced

Not as a feature request. On staging — edition `enterprise`, LDAP configured —
the OIDC card rendered a padlock reading "Enterprise", telling an operator to
buy what they were already running. The capability was absent because the
enterprise layer emits exactly one directory capability:

```ts
const capabilities = directoryConfigured
  ? [oidc === null ? CAPABILITIES.DIRECTORY_LDAP : CAPABILITIES.SSO_OIDC]
  : [];
```

An either/or *licence* token standing in for an either/or *configuration* is the
smell that led here.

### Almost all of this already exists

The change is far smaller than "support multiple directories" sounds, because
[ADR-0015](./0015-hybrid-authentication.md) already built the model:

| Already plural | Still singular |
|---|---|
| `AUTH_PROVIDERS`, injected as a collection | The enterprise mutual-exclusion guard |
| `AuthProviderResolver`'s `source → provider` map | `GET /auth/mode`, which answers with one `source` |
| `authSource` on every account, authoritative | `redirectProvider()`, "the ONE provider that logs in by redirect" |
| Role mappings carrying a `provider` field, with separate LDAP and OIDC sources | `describableProvider()`, "the provider worth describing" |
| The create-user dialog's `authSource` selector | The capability pair, emitted as either/or |

The resolver's own comment anticipated this exact work:

> *"Hybrid changes what the login page should offer: an email form for local and
> directory credentials AND a button for the redirect provider, rather than one
> or the other. That UX is deliberately not in this change — see the follow-up
> noted in the ADR."*

This is that follow-up.

## Decision

**Authentication sources are additive. A deployment may run local, a directory,
and a redirect provider at the same time — and an account still belongs to
exactly one of them.**

### 1. The mutual-exclusion guard goes, and the capabilities become independent

`directory.ldap` and `sso.oidc` stop being alternatives. Both may be advertised;
either may be absent. A deployment configuring both gets both, and the
enterprise layer contributes two providers to `AUTH_PROVIDERS` instead of
refusing to boot.

This also removes the confusion at its root rather than at the label: a locked
card on an enterprise deployment stops being a state that needs explaining,
because configuring OIDC is now sufficient to unlock it.

### 2. One account, one source — reaffirmed, because it is what makes this safe

[ADR-0015 §1](./0015-hybrid-authentication.md) already refuses chaining. Adding a
second directory makes that refusal more valuable, not less.

The industry failure mode for multi-provider authentication is **not**
authentication; it is **identity reconciliation**. Where two providers may
resolve the same account, one can impersonate the other. It is a repeating CVE
class, always with the same shape — matching an incoming identity to an existing
account by **email**:

- Grafana **CVE-2023-3128**, an Azure AD OAuth authentication bypass, which is
  why `oauth_allow_insecure_email_lookup` exists and defaults off.
- Coder **GHSA-75vm-6w67-gwvp**, where `email_verified` was read with a direct
  type assertion and failed **open** for a provider returning it as a string.
- nhost **GHSA-6g38-8j4p-j3pr**, the same shape again.

**NexusPuppet is immune by construction, and must stay that way.** A login
resolves the account, reads `authSource`, and asks that provider and no other.
No email lookup, no fallback, no linking. We inherit for free the property
Grafana had to retrofit behind a flag — because we never had the feature that
creates the hole.

So: **no account may ever be matched across sources.** Not by email, not by a
`sub` claim, not by username. Changing an account's source stays an
administrative act.

**And moving an account between sources is that act: `authSource` is edited in
place.** Not deleted and recreated — `email` is globally unique, so the two rows
could never coexist anyway, and a delete would take the account's role, its
history and every audit entry's subject with it, leaving a window where the
person cannot sign in at all.

The edit is one transaction: the new source, the cleared password hash, and the
audit row. **Clearing the hash is not tidiness.** A leftover hash on an account
moved to a directory is a credential that outlives whatever the directory
revokes — the hazard the create-user dialog already warns about, arriving by a
different door. §1's strict dispatch makes it inert rather than exploitable, and
inert is not a reason to keep it.

### 3. `GET /auth/mode` becomes a list, and that is the substance of the work

One endpoint answers with one `source`, and two screens derive their entire
behaviour from it:

- the **login page**, which renders either a credentials form or a redirect
  button;
- the **create-user dialog**, which offers exactly one external source
  (`authMode.data.source !== 'local' ? … : null`).

Everything downstream is singular *because this is*. It becomes a list of
sources, each with its `mode` and `identifierLabel`, and both screens render one
per entry: a credentials form for the credential-mode sources, a button for each
redirect-mode source.

**One form plus a button per redirect source — not a realm dropdown.** This is
the shape Grafana, GitLab and Argo CD all converged on, and it is worth copying
rather than reasoning from first principles. Proxmox's realm dropdown is the
visible alternative and it is the outlier: it makes every user, on every login,
answer a question about our deployment topology, and its own forum threads are
people asking why they must pick. The form covers local and LDAP because
`authSource` already decides which; the buttons exist because a redirect flow
has nobody to dispatch on yet.

`redirectProvider()` and `describableProvider()` — both of which quietly pick
"the one" by iteration order — become `redirectProviders()` and a description
per source.

**Public, and it must stay a list even with one entry.** A shape that changes
between one and many is a shape every caller gets wrong once.

### 4. The create-user dialog defaults to a directory, and refuses to guess between two

With exactly one directory configured, "New user" defaults its source to that
directory. With two, there is no default and the form cannot be submitted until
one is chosen.

The failure modes are lopsided, which is the whole argument. Default to a
directory and get it wrong, and somebody cannot sign in — noticed in minutes,
fixed in one edit. Default to local and get it wrong, and a directory-managed
person now holds a password-backed account that keeps working after the
directory revokes them. One error is an inconvenience; the other is an
offboarding hole nothing reports.

Guessing between two directories has no such asymmetry — either could be right —
so it does not guess.

### 5. NOT NOW: hiding the password form for SSO-only estates

Recorded rather than decided, because nothing has asked for it. Grafana has two
switches here — `disable_login_form` hides the credentials box, and
`oauth_auto_login` skips the login page entirely — and every comparable product
grew something similar eventually.

Whoever builds it inherits one constraint that is not obvious and is expensive
to learn the hard way: **the form may be hidden, and must stay reachable at an
explicit URL, and the local provider must stay registered underneath it.** An
auto-redirect with no way back is precisely the lockout
[ADR-0015](./0015-hybrid-authentication.md) exists to prevent, wearing a
convenience label — a deployment whose IdP is down, misconfigured, or
mid-certificate-expiry must still admit its administrator.

Hiding is presentation. It is never authorization.

### 6. Role mappings are per source, and the deletion guard must see all of them

Mappings already carry `provider`, with `LdapMappingSource` and
`OidcMappingSource` feeding one interface. Nothing changes structurally — but the
guard that refuses to delete a role a mapping names must consult **every**
configured source, not the first one that answers. A role deleted because only
LDAP was checked is an OIDC login that fails at the next sign-in, for a reason
nothing on screen explains.

### 7. What does not change

- **No auto-provisioning.** A directory user without an account is still refused
  (ADR-0015 §5).
- **The timing floor still belongs to the resolver.** With more sources there are
  more latencies to flatten, and the same enumeration oracle to close
  (ADR-0015 §2).
- **Refusal messages stay identical** across every cause, including "no provider
  owns this account's source".
- **Local can never be displaced.** The registry refuses a registration that
  would unbind it (ADR-0015 §3). Two directories make break-glass more
  important, not less.

### Binding constraints

1. **A login consults exactly one source — the one the account names.** No
   chaining, no fallback, no "try the other one". This is the property that makes
   §2's whole CVE class inapplicable, and it is worth more than any convenience
   that would cost it.
2. **No account is ever matched across sources by email or any other claim.** If
   a future feature needs identity linking, it needs its own ADR and its own
   threat model — it does not get to arrive as an implementation detail.
3. **The local provider stays registered, in every edition and every
   configuration.** An operator locked out of their own console by a directory
   change is the defect ADR-0015 exists to close.

## Consequences

### Gained

- An estate mid-migration can run LDAP and OIDC together and move accounts one
  at a time, instead of cutting over on a single restart.
- Local service accounts, an LDAP estate and an OIDC tenant coexist — which is
  what the automation account (ADR-0020) and break-glass both assume.
- The capability pair stops encoding configuration, so a locked card means one
  thing again: this deployment does not have that feature.
- `AUTH_PROVIDERS` and the resolver stop being a generality that only ever holds
  two entries, one of which is always local.

### Paid

- The login page grows a real decision: a form and one or more buttons, which is
  more design than "one or the other" and is where such screens usually get
  ugly.
- More paths to keep identical. Lockout, audit records, rate limiting and the
  timing floor must behave the same on three sources rather than two — a
  test-matrix cost, and the matrix is now wide enough to need generating rather
  than writing out.
- Two directories mean two sets of role mappings that can disagree about the
  same person's role, and the answer — whichever source authenticated them —
  is obvious in code and surprising on screen.
- `authSource` becomes a field operators must understand when creating accounts,
  where today it is mostly invisible.

### Not bought

- **Not several instances of one kind — yet.** Two LDAP servers stays refused,
  because the resolver rejects two providers claiming one source. Grafana draws
  the same line ("you cannot have two different Generic OAuth configurations").

  **Puppet Enterprise does not**, and that matters more than Grafana here: PE
  connects to several LDAP directories and, at a user's first login, searches
  them *in the order they were added*, stopping at the first match. An estate
  that has already been told by our closest analogue that two directories are
  normal will expect the same of us.

  Not now, and not never. The blocker is that `source` is a bare kind
  (`'ldap'`), so a second one has nowhere to live. Whatever adds it should
  namespace the source — `ldap:corp`, `ldap:eu` — and that shape should be kept
  in mind when touching `authSource`, so this does not require a data migration
  later.

  Note also what PE's ordering is and is not: it is a **discovery** order at
  first login, after which the account is bound to a directory. It is not a
  password fallback across sources, and adopting it would not weaken §2.
- **Not identity linking — and not simultaneous accounts either.** `email` is
  globally unique on `User`, so one person cannot hold an LDAP account and an
  OIDC account at the same time. They hold one account whose source changes.

  This is stated because an earlier draft of this ADR claimed the opposite —
  that a person would simply have two accounts with separate audit trails, "a
  feature, not an oversight". The schema does not allow it. The constraint is
  worth keeping: it is what makes an email address name a person rather than a
  person-at-a-provider, and it removes any question about which of two rows an
  audit entry belongs to.
- **Not IdP-initiated flows or RP-initiated logout** ([#108](https://github.com/eth-man/nexuspuppet/issues/108)),
  which are orthogonal and still open.

## Alternatives considered

**Keep one at a time.** Zero work, and it is where Rancher and Harbor sit —
Rancher has carried open requests for multiple IdPs since 2018, and Harbor
freezes `auth_mode` permanently once a local user exists. Neither is defended as
a design; both are lived with. Rejected: we would be choosing a limitation that
our own architecture no longer imposes.

**Link identities per account, as GitLab and Grafana do.** One person, several
identities, auto-linked by email or matching uid. Genuinely more convenient, and
it is precisely the mechanism behind every advisory in §2. Rejected: it trades a
security property we currently hold for free against an ergonomic gain nobody
has asked for. Grafana's own documentation warns that it *"does not support
multiple identity providers resolving the same user"*.

**Federate upstream instead: point one OIDC provider at a broker.** Keycloak,
Dex or Authentik in front, fanning out to LDAP and any number of IdPs. Legitimate
— it is how Argo CD handles this — and it is available to any operator today
without us changing anything. Rejected as *the answer*, because it makes a
second server a prerequisite for using two directories, on an on-prem product
whose pitch is a small dependency-free footprint. It stays the right answer for
estates with five IdPs.

**Realms, as Proxmox VE does.** Many realms of any type, the user picks theirs at
login, authentication kept separate from authorization, and every user needs a
local record and a role regardless of realm. This is the model chosen — and, to
be accurate about it, the model NexusPuppet already implements. `authSource` is a
realm. The only thing missing is that the login screen never learned to offer
more than one.

## What the field does

Gathered because the decision above is mostly "copy the majority", and it is
worth being able to see who the majority is.

| Product | Several at once? | How a user's source is decided | Login screen |
|---|---|---|---|
| **Puppet Enterprise** | Yes — several LDAP directories | Searched in the order added, first match wins, then bound | Form |
| **HashiCorp Vault** | Yes — auth methods mounted at paths | Mount path; identity entities tie aliases together | Method selector |
| **Grafana** | Yes, but not two of the same type | Per-account; explicitly *"does not support multiple identity providers resolving the same user"* | Form + a button per provider |
| **GitLab** | Yes — LDAP + OmniAuth | Per-account identities, opt-in linking by email or uid | Form + a button per provider |
| **Proxmox VE** | Yes — many realms of any type | The realm the user picks at login | Form + realm dropdown |
| **Rancher** | **No** | — | — |
| **Harbor** | **No** — `auth_mode` freezes once local users exist | — | — |

Two things fall out. Running LDAP and OIDC together is **ordinary**, and the
products that refuse are the ones carrying years-old feature requests about it.
And the login screen that most of them converged on is a credentials form with a
button per redirect provider — which is what §3 adopts.

## Resolved during design

Kept with their answers, because the reasoning is the useful part.

1. ~~**What does the create-user dialog default to?**~~ **The directory, when
   there is exactly one. No default when there are two.** (§4)

   Decided on the asymmetry of the mistakes rather than on convenience: the
   wrong directory is a login that fails and gets fixed; the wrong `local` is a
   password-backed account for a directory-managed person, still working after
   that directory revokes them.

2. ~~**Should two sources disagreeing about a person's role be surfaced?**~~
   **The question does not arise — `email` is globally unique.**

   Asked on the assumption that one person could hold an LDAP account and an
   OIDC account at once. They cannot: `User.email` is `@unique` across every
   source. So there is no pair of accounts to disagree, and moving between
   sources is an edit in place (§2).

   Recorded because an earlier draft of this ADR asserted the opposite as a
   feature. Checking the schema took a minute and removed a whole section.

3. ~~**Is hiding the password form wanted now?**~~ **Noted, not built.** (§5)

   No demand behind it. What is worth keeping is the constraint whoever builds
   it would otherwise learn the hard way: hidden is not unbound, and an
   auto-redirect with no way back is the ADR-0015 lockout with better manners.
