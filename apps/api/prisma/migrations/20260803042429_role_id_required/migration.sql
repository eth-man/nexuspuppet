-- ---------------------------------------------------------------------------
-- Backfill AGAIN before requiring the column (ADR-0018).
--
-- The previous migration backfilled it and the application has maintained it
-- since, but that is discipline rather than a constraint: nothing at the
-- database level enforced it, and a rolling deploy has old replicas inserting
-- roleId-less rows for as long as it takes to roll. Assuming the column is
-- populated is how this migration fails at 3am on the one deployment that
-- matters.
--
-- Idempotent: on a deployment where nothing drifted this updates zero rows.
-- ---------------------------------------------------------------------------

UPDATE "users" u
   SET "roleId" = r."id"
  FROM "roles" r
 WHERE r."name" = u."role"::text
   AND u."roleId" IS NULL;

-- Anything still null names a role that does not exist, which the ALTER below
-- would report as a constraint violation naming neither the row nor the reason.
DO $$
DECLARE orphaned int;
BEGIN
  SELECT count(*) INTO orphaned FROM "users" WHERE "roleId" IS NULL;
  IF orphaned > 0 THEN
    RAISE EXCEPTION
      'ADR-0018: % user(s) carry a role with no matching row in "roles". Their role column names something the roles table does not define; fix those users or add the role, then re-run.', orphaned;
  END IF;
END $$;

/*
  Warnings:

  - Made the column `roleId` on table `users` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "users" ALTER COLUMN "roleId" SET NOT NULL;
