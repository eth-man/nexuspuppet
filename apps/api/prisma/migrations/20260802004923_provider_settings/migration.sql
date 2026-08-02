-- CreateTable
CREATE TABLE "provider_settings" (
    "kind" VARCHAR(64) NOT NULL,
    "config" JSONB NOT NULL,
    "secrets" BYTEA,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByEmail" TEXT,

    CONSTRAINT "provider_settings_pkey" PRIMARY KEY ("kind")
);
