-- CreateTable
CREATE TABLE "notification_conditions" (
    "key" VARCHAR(255) NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "severity" VARCHAR(16) NOT NULL,
    "summary" TEXT NOT NULL,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "lastEvaluatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_conditions_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "notification_conditions_openedAt_idx" ON "notification_conditions"("openedAt");

-- CreateIndex
CREATE INDEX "notification_conditions_kind_idx" ON "notification_conditions"("kind");

