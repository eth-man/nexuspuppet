-- AlterTable
ALTER TABLE "enc_materializations" ADD COLUMN     "matchReasons" JSONB NOT NULL DEFAULT '[]';

