-- Directory accounts are linked to their directory entry (ADR-0031).
--
-- A directory sign-in used to find its account by the address typed, and that
-- address also had to be the entry's mail or UPN. In real Active Directories
-- the UPN suffix is often .local while the email is .com, and mail is often
-- empty, so people could not sign in at all. Sign-in is now directory-first:
-- the directory authenticates whatever was typed (username, UPN or email),
-- and the account is the one LINKED to that entry by its stable id — AD's
-- objectGUID or OpenLDAP's entryUUID, as a canonical lower-case UUID.
--
-- Additive and nullable, with NO backfill: an existing directory account is
-- linked at its next sign-in, by its email matching the entry's. Unique, so
-- one directory entry can never open two accounts — which is also what turns
-- two concurrent first sign-ins of one person into one account.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "directoryId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_directoryId_key" ON "users"("directoryId");
