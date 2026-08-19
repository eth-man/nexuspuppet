-- Saved queries become usable, polymorphic and survivable (ADR-0026).
--
-- `saved_queries` has existed since the roles work and has never had a line of
-- code touching it — it was designed for this feature and left dead. Three
-- changes make it the thing it was meant to be:
--
--   1. `kind` — one table for node and resource queries rather than two, so
--      the sharing rules, the lifecycle and the UI exist once (§2).
--   2. `ownerEmail` — denormalised, for the same reason AuditLog keeps
--      actorEmail: the row outlives the account, and a shared query whose
--      owner is gone must still say who made it.
--   3. `userId` becomes NULLABLE with ON DELETE SET NULL — deleting a user
--      drops their private queries and orphans their shared ones, rather than
--      cascading away something the team relies on (§4).
--
-- The table is empty in every deployment, so backfill is a formality rather
-- than a data migration. It is written anyway: "empty everywhere" is a claim
-- about other people's databases that this migration cannot check.

ALTER TABLE "saved_queries"
  ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'node';

-- Nullable first, backfilled, then made NOT NULL: adding a NOT NULL column
-- with no default to a table that might not be empty would fail.
ALTER TABLE "saved_queries"
  ADD COLUMN IF NOT EXISTS "ownerEmail" TEXT;

UPDATE "saved_queries" q
   SET "ownerEmail" = u.email
  FROM "users" u
 WHERE u.id = q."userId"
   AND q."ownerEmail" IS NULL;

-- Any row whose user has already gone gets a marker rather than blocking the
-- migration. It cannot happen under the old CASCADE, which is precisely why a
-- row that somehow exists should be visible rather than silently plausible.
UPDATE "saved_queries"
   SET "ownerEmail" = 'unknown@deleted.invalid'
 WHERE "ownerEmail" IS NULL;

ALTER TABLE "saved_queries"
  ALTER COLUMN "ownerEmail" SET NOT NULL;

-- Cascade -> SetNull. The private/shared distinction is applied by
-- UsersService.remove inside the deletion transaction; this is the half the
-- database can express.
ALTER TABLE "saved_queries" DROP CONSTRAINT IF EXISTS "saved_queries_userId_fkey";

ALTER TABLE "saved_queries"
  ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "saved_queries"
  ADD CONSTRAINT "saved_queries_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "saved_queries_isShared_idx" ON "saved_queries"("isShared");
