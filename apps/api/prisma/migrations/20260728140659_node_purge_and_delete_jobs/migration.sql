-- CreateEnum
CREATE TYPE "EncJobKind" AS ENUM ('MATERIALIZE', 'DELETE');

-- AlterTable
ALTER TABLE "enc_materialization_jobs" ADD COLUMN     "kind" "EncJobKind" NOT NULL DEFAULT 'MATERIALIZE';

-- AlterTable
ALTER TABLE "managed_nodes" ADD COLUMN     "deactivated" BOOLEAN NOT NULL DEFAULT false;
