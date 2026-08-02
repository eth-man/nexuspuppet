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

**Built-in roles are not deletable and not renamable**, because their names are
written into LDAP role mappings, into audit history, and into other people's
runbooks. Their permission sets *are* editable, with one exception below.

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

### 5. LDAP role mappings refer to roles by name

`ldapSettingsSchema.roleMappings[].role` is currently the three-value enum. It
becomes a string naming a role. Consequences worth stating:

- A mapping may name a role that no longer exists. That must be visible in the
  settings UI as a broken mapping, and must resolve as **no role** — refusing
  the login — rather than as a default. ADR-0015's "fails closed" applies.
- Deleting a role that a mapping names is refused, the same way as the
  last-admin rule, because the failure would otherwise surface as people being
  unable to sign in.

**Multiple matches: union for custom roles, ordering preserved for built-ins.**

"Highest role wins" stops meaning anything once roles are unordered, so custom
roles union their permissions. But applying a union everywhere would silently
re-interpret configurations nobody edited: an upgrade would change what an
existing mapping grants, with no diff to review and no event to notice.

So the rule is split by what the mapping actually names:

| Mapping names | Rule |
|---|---|
| only built-in roles | highest wins — today's behaviour, unchanged |
| any custom role | union of permissions across all matched roles |

An existing deployment upgrades to identical behaviour. A deployment that opts
into custom roles opts into the union at the same moment, which is when an
operator is looking at the screen and can be told. The UI states which rule is
in force for the mapping set as configured, because a table where the semantics
depend on the contents needs to say so.

### 6. The mechanism is core; the editing is licensed

The split is not "custom roles are an enterprise feature". It cannot be: the
roles table, per-request resolution, the lockout rules and the LDAP mapping
change all sit on paths every deployment takes, and a core build has to run them
correctly whether or not it can create a role.

| | Core | Enterprise |
|---|---|---|
| `roles` table and seeded built-ins | ✓ | |
| per-request permission resolution | ✓ | |
| lockout-by-permission | ✓ | |
| LDAP mapping to role names | ✓ | |
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
3. Is `builtIn` the right immutability boundary, or should the seeded rows be
   editable-but-restorable? Leaning to the former: a runbook that says "ADMIN"
   should not depend on nobody having redefined it.
