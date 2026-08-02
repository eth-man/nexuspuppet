# ADR-0018 — Custom roles with granular permissions

- **Status:** Proposed — needs a core/enterprise decision before implementation
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
- "Highest role wins" on multiple matches stops meaning anything once roles are
  not ordered. Replace it with **union of permissions** across matched roles,
  and say so in the UI — it is a different rule and operators must not assume
  the old one.

That last point is the sharpest edge in this ADR. It changes the meaning of an
existing configuration: someone in both `ops` and `viewers` today gets
OPERATOR; under a union they get the same, but someone in two disjoint custom
roles gets more than either. Migration must not silently re-interpret existing
mappings — the built-in roles keep their ordered semantics until an operator
opts a mapping into the new model, or we accept a one-time documented change.

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

1. **Core or enterprise?** Custom RBAC is conventionally a paid tier, and
   `IAuthorizationPolicy` exists precisely so the enterprise layer can replace
   the policy. But the lockout rules, the schema and the LDAP mapping change all
   have to live in core regardless, so "enterprise" here means the *editing* is
   licensed while the *mechanism* is not. Needs deciding before any code: it
   determines whether the roles UI is built behind a capability check.
2. Should a role be assignable to local users only, or also nameable by an OIDC
   claim? OIDC has no mapping UI yet.
3. Does the union rule in §5 apply to built-in roles retroactively, or only to
   mappings an operator has migrated?
