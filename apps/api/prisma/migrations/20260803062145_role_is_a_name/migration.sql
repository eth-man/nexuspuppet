-- ---------------------------------------------------------------------------
-- users.role becomes a role NAME rather than an enum (ADR-0018 §5).
--
-- HAND-WRITTEN, replacing what Prisma generated. Its version was:
--
--   ALTER TABLE "users" DROP COLUMN "role",
--   ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'VIEWER';
--
-- which drops every user's role and recreates the column at its default. Every
-- administrator on every existing deployment would come back a VIEWER, and the
-- first symptom would be nobody able to administer anything. Prisma warns about
-- the data loss; the warning is easy to scroll past in a diff.
--
-- USING casts in place instead, so the values survive.
-- ---------------------------------------------------------------------------

ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE TEXT USING "role"::text;
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'VIEWER';

-- The enum type is now unreferenced. Dropped so it cannot be resurrected by a
-- later migration that assumes roles are still those three values.
DROP TYPE IF EXISTS "UserRole";
