-- CreateTable
CREATE TABLE "notification_delivery_jobs" (
    "id" UUID NOT NULL,
    "conditionKey" VARCHAR(255) NOT NULL,
    "transition" VARCHAR(16) NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_delivery_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_delivery_jobs_nextAttemptAt_idx" ON "notification_delivery_jobs"("nextAttemptAt");

