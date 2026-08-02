-- AlterTable
ALTER TABLE "users" ADD COLUMN     "roleId" UUID;

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" TEXT,
    "permissions" TEXT[],
    "builtIn" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Seed the built-in roles, and point every existing user at the one matching
-- the enum they already carry (ADR-0018 §1).
--
-- The permission sets below are copied from ROLE_PERMISSIONS in
-- apps/api/src/auth/rbac.policy.ts and MUST equal it exactly. Nothing reads
-- these rows yet, so a mismatch here would not change behaviour today — it
-- would change it silently in the release that switches resolution over. A
-- test asserts the two agree; if you edit one, edit the other.
--
-- gen_random_uuid() is pgcrypto, available in Postgres 13+ core.
-- ---------------------------------------------------------------------------

INSERT INTO "roles" ("id", "name", "description", "permissions", "builtIn") VALUES
  (gen_random_uuid(), 'VIEWER',
   'Read-only access to inventory, reports and classification.',
   ARRAY['inventory:read', 'reports:read', 'classification:read'],
   true),
  (gen_random_uuid(), 'OPERATOR',
   'Reads everything a viewer can, and changes classification.',
   ARRAY['inventory:read', 'reports:read', 'classification:read',
         'classification:write', 'materialization:trigger'],
   true),
  (gen_random_uuid(), 'ADMIN',
   'Full administration, including users, settings and raw PQL.',
   ARRAY['inventory:read', 'reports:read', 'classification:read',
         'classification:write', 'materialization:trigger',
         'users:manage', 'settings:manage', 'pql:raw'],
   true);

UPDATE "users" u
   SET "roleId" = r."id"
  FROM "roles" r
 WHERE r."name" = u."role"::text
   AND u."roleId" IS NULL;
