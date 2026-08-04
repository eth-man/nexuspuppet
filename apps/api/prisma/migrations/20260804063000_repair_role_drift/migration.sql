-- Repair users whose role NAME and role KEY disagree.
--
-- `recordLogin` — how a directory provider writes back the role it recomputed
-- from group membership — updated "role" and left "roleId" pointing at whatever
-- the account was provisioned with. The code is fixed; this heals the rows that
-- already drifted, which is every deployment where a directory user's group
-- membership changed after their account was created.
--
-- Symptom that surfaced it: the Roles card reported OPERATOR held by nobody
-- while an operator was signed in, because the console displays the name and
-- the count reads the key.
--
-- The NAME wins. It is what the directory last asserted, what the console
-- shows, and what the operator recognises; the key is stale by construction —
-- only ever written at provisioning. Every other writer sets both together.
UPDATE "users" u
   SET "roleId" = r."id"
  FROM "roles" r
 WHERE r."name" = u."role"
   AND u."roleId" <> r."id";

-- Rows whose name matches no role are left exactly as they are. There is no
-- correct key to choose for them, the column is NOT NULL so there is no
-- "unset", and a guess would hand the account whatever that guess allows.
-- They already resolve no permissions, since resolution goes by name.
DO $$
DECLARE unmatched int;
BEGIN
  SELECT count(*) INTO unmatched
    FROM "users" u
   WHERE NOT EXISTS (SELECT 1 FROM "roles" r WHERE r."name" = u."role");

  IF unmatched > 0 THEN
    RAISE WARNING
      '% user(s) name a role this deployment does not define. Their role key was left unchanged; they resolve no permissions until the name is corrected or the role is created.',
      unmatched;
  END IF;
END $$;
