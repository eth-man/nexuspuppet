-- Grant `resources:read` to the built-in ADMIN role (ADR-0025 §3).
--
-- WHY A MIGRATION AND NOT A CONSTANT. Role permissions live in the `roles`
-- table; `SEEDED_BUILT_IN_PERMISSIONS` in TypeScript only mirrors what the
-- seeding migration wrote, and `can()` reads the table. Editing the constant
-- alone would grant nothing to any deployment that already exists — every
-- upgraded instance would show a Resources screen that nobody could open.
--
-- WHY ADMIN AT ALL, when the permission guards real disclosure — managed file
-- contents, and credentials passed as class parameters. Because otherwise
-- NOBODY can hold it: creating a custom role answers 501 without the
-- enterprise layer (ADR-0018), and `pql:raw` is declared with no endpoint
-- behind it. An unheld permission would make the feature unreachable in every
-- core deployment rather than merely restricted.
--
-- VIEWER and OPERATOR are deliberately NOT granted it. They are the roles most
-- people actually hold, and that is where the disclosure risk lives.
--
-- This widens what an existing ADMIN can do, without anybody asking for it.
-- That is stated in ADR-0025's consequences rather than hidden here.

-- Idempotent, and it will not resurrect the permission on a role an operator
-- has deliberately narrowed: it only touches the BUILT-IN admin row, and only
-- when the permission is absent.
UPDATE "roles"
   SET "permissions" = array_append("permissions", 'resources:read')
 WHERE "name" = 'ADMIN'
   AND "builtIn" = true
   AND NOT ('resources:read' = ANY("permissions"));

-- The description is what an operator reads in the Roles card before granting
-- the role to somebody. Leaving it saying "users, settings and raw PQL" while
-- the role can now read managed file contents would be the console lying about
-- what it hands out.
UPDATE "roles"
   SET "description" = 'Full administration, including users, settings, raw PQL and catalog resources.'
 WHERE "name" = 'ADMIN'
   AND "builtIn" = true
   AND "description" = 'Full administration, including users, settings and raw PQL.';
