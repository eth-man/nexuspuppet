# ADR-0018 — Custom roles with granular permissions

- **Status:** Accepted — mechanism in core, editing behind an enterprise capability
- **Deciders:** Architect
- **Related:** [ADR-0006](./0006-auth-local-jwt-modular-sso.md), [ADR-0011](./0011-scoped-rbac.md), [ADR-0015](./0015-hybrid-authentication.md), [ADR-0002](./0002-open-core-runtime-discovery.md)

## Context

Roles are three fixed values — `VIEWER`, `OPERATOR`, `ADMIN` — a Prisma enum
mapped to permission sets by a constant in `rbac.policy.ts`. The eight
permissions are already granular and already surfaced per-session in the
console, which is what makes the fixed grouping conspicuous: an operator can see
that `pql:raw` and `classification:write` are separate things, and cannot
separate them.

The concrete ask: create roles and assign those permissions individually.

Note what this is *not*. [ADR-0011](./0011-scoped-rbac.md) covers **scoping** —
bounding a write to an environment or group — and is deliberately not built.
This is orthogonal: *which verbs*, not *over which nodes*. Nothing here reopens
ADR-0011, and a custom role does not become a scope.

## Decision

### 1. Roles become rows; permissions become a set on the row

```prisma
model Role {
  id          String   @id @default(uuid()) @db.Uuid
  name        String   @unique @db.VarChar(64)
  description String?
  permissions String[]
  builtIn     Boolean  @default(false)
  @@map("roles")
}
```

`User.role` moves from the enum to a foreign key. The three current values are
seeded as `builtIn` rows with exactly today's permission sets, so an existing
deployment is unchanged on the first boot after upgrade.

**Built-in roles are fixed: not deletable, not renamable, and not
redefinable.** Their names are written into directory role mappings, into audit
history, and into other people's runbooks, and every one of those readers
assumes the name still means what the product documents.

An earlier revision of this ADR allowed their permission sets to be edited,
guarded only against total administrative lockout. That guard is real but it
answers a different question: it stops a deployment losing administration
altogether, and does nothing about a role still *named* `VIEWER` that grants
`settings:manage`, or one stripped of `inventory:read` so its holders can sign
in but cannot load their own session or change their own password. Both were
reachable, and neither is visible from the name — which is the whole problem,
because the name is what every runbook and directory mapping refers to.

A deployment that wants a different set builds one. A custom role says what it
is by its own name and carries no inherited expectation of what it grants; the
console offers **Duplicate as custom role** from a built-in, so the starting
point is one click away. Core-only deployments keep exactly the three roles
they had before this ADR, which is what they had anyway.

### 2. `IAuthorizationPolicy` is already the seam

Core's `RbacPolicy` reads a constant. It becomes a policy that reads the
principal's resolved permission set instead. `IAuthorizationPolicy` was written
to be replaceable by the enterprise layer, and nothing about this changes that
contract — it changes where core's own implementation gets its data.

### 3. A permission change takes effect without waiting for a re-login

The permission list is resolved per request from the role, not read from a claim
baked into the JWT at login. Revoking `classification:write` from a role must
stop the next write, not the write after the operator's session expires.

This costs a lookup per request. Cache it in the request scope, keyed by role
id, invalidated on role update — not per user, and not across requests.

### 4. Lockout prevention keys on the permission, not the name

The current guard counts active users whose `role === 'ADMIN'`. With editable
roles that check is wrong twice over: an `ADMIN` role could have `users:manage`
removed, and a custom role could have been granted it.

The rule becomes: **at least one active user must hold `users:manage` and
`settings:manage`.** Enforced on user update, on user deactivation, on role
update, and on role deletion — inside the transaction, as the existing
last-administrator check already is. `users:manage` cannot be removed from the
last role that grants it.

### 5. Directory role mappings refer to roles by name

`ldapSettingsSchema.roleMappings[].role` is currently the three-value enum. It
becomes a string naming a role. Consequences worth stating:

- A mapping may name a role that no longer exists. That must be visible in the
  settings UI as a broken mapping, and must resolve as **no role** — refusing
  the login — rather than as a default. ADR-0015's "fails closed" applies.
- Deleting a role that a mapping names is refused, the same way as the
  last-admin rule, because the failure would otherwise surface as people being
  unable to sign in.

**Both guarantees are currently LDAP-only, and that is a gap rather than a
decision.** `MappingSource` has one implementation, which reads the directory
settings; OIDC mappings live in the environment and are invisible to it. So a
role named by an OIDC mapping can be deleted without the refusal above, and a
dangling OIDC mapping is shown nowhere, because OIDC has no settings surface at
all yet.

This was inert while OIDC mappings could only name built-in roles — built-ins
are not deletable, so there was nothing to guard. Widening OIDC to role names
made it live: the guard now has a hole exactly where the ADR says it must not.
It fails closed on permissions (a name with no row grants nothing), so it is an
operability failure rather than a privilege one — somebody signs in able to do
nothing, with nothing to explain why, which is the outcome this bullet exists to
prevent.

Closing it means a second `MappingSource` reading the OIDC configuration, which
is cheap once OIDC has a settings surface and awkward before then.

**Multiple matches: union for custom roles, each provider's prior rule preserved
for built-ins.**

"Highest role wins" stops meaning anything once roles are unordered, so custom
roles union their permissions. But applying a union everywhere would silently
re-interpret configurations nobody edited: an upgrade would change what an
existing mapping grants, with no diff to review and no event to notice.

So the rule is split by what the mapping actually names:

| Mapping names | Rule |
|---|---|
| only built-in roles | **whatever that provider already did**, unchanged |
| any custom role | union of permissions across all matched roles |

An existing deployment upgrades to identical behaviour. A deployment that opts
into custom roles opts into the union at the same moment, which is when an
operator is looking at the screen and can be told. The UI states which rule is
in force for the mapping set as configured, because a table where the semantics
depend on the contents needs to say so.

#### The built-in rule is per provider, and deliberately not unified

This section was written about LDAP and now governs two providers that resolve
built-ins differently:

| Provider | Built-in rule | Where it comes from |
|---|---|---|
| LDAP | highest role wins | `memberOf` order is unspecified, so ordering could not be meaningful |
| OIDC | first matching mapping in configured order | claim order is equally unspecified, so the provider ranked by the order the operator wrote instead, and documented it |

**Unifying them would be tidier and is refused, for this section's own reason.**
Switching OIDC to highest-wins re-reads existing configurations: a deployment
listing `contractors=VIEWER` before `ops=OPERATOR` grants VIEWER today and would
grant OPERATOR after the upgrade — a promotion, with no diff to review and no
event to notice. That is exactly the trade the paragraph above declines, so it is
declined here too.

The consequence to state plainly: **the built-in rule is a property of the
provider, not of the product.** Anything reading these mappings — the settings
screen, a future provider — must ask which provider it is describing rather than
assume one answer. A third directory provider adopts whichever rule it can
justify from its own ordering guarantees, and says which in its own
documentation.

Union behaviour, by contrast, IS a product rule: once a custom role is matched,
every provider unions, because no provider can rank names it did not invent.

### 6. The mechanism is core; the editing is licensed

The split is not "custom roles are an enterprise feature". It cannot be: the
roles table, per-request resolution, the lockout rules and the directory mapping
change all sit on paths every deployment takes, and a core build has to run them
correctly whether or not it can create a role.

| | Core | Enterprise |
|---|---|---|
| `roles` table and seeded built-ins | ✓ | |
| per-request permission resolution | ✓ | |
| lockout-by-permission | ✓ | |
| directory mapping to role names (LDAP, OIDC) | ✓ | |
| **creating / editing / deleting roles** | | ✓ `rbac.custom` |

A core deployment therefore has exactly three roles, behaving exactly as today,
running on the new mechanism. That is the property that makes this safe to
merge: the risky part ships to everyone and is exercised by everyone, while the
part that is merely valuable is gated.

The gate is a capability check, not a separate code path (ADR-0002). One
implementation, one set of tests.

## Consequences

**What this buys:** the permissions already shown per-session become
assignable. A read-only auditor who may run `pql:raw` but not
`classification:write` is expressible, and today is not.

**What it costs:** authorization stops being a constant. A bug in role
resolution is a security bug, in the path every request takes. The existing
`ROLE_PERMISSIONS` table has the singular virtue of being obviously correct by
inspection, and that goes away.

**What it does not buy:** scoping. See ADR-0011.

## Open questions

1. Should a role be assignable to local users only, or also nameable by an OIDC
   claim? OIDC has no mapping UI yet, so this can wait for one.
2. Does an enterprise licence lapsing strand a deployment on custom roles it can
   no longer edit? Per ADR-0014 the product degrades to core and must never
   break — so custom roles must keep *resolving* without a licence, with only
   the editor withdrawn. Anything else logs people out at renewal time.
3. ~~Is `builtIn` the right immutability boundary, or should the seeded rows be
   editable-but-restorable?~~ **Resolved: `builtIn` is the boundary.** Seeded
   rows are fixed outright rather than editable-but-restorable — a restore
   action only helps somebody who already knows a role was changed, and the
   failure mode here is precisely that nobody knows. A runbook that says
   "ADMIN" does not depend on nobody having redefined it. See §1; the escape
   hatch is duplication, not mutation.
