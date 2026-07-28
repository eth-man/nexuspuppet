-- CreateTable
CREATE TABLE "audit_delivery_jobs" (
    "id" UUID NOT NULL,
    "auditLogId" UUID NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_delivery_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_delivery_jobs_auditLogId_key" ON "audit_delivery_jobs"("auditLogId");

-- CreateIndex
CREATE INDEX "audit_delivery_jobs_nextAttemptAt_idx" ON "audit_delivery_jobs"("nextAttemptAt");

-- AddForeignKey
ALTER TABLE "audit_delivery_jobs" ADD CONSTRAINT "audit_delivery_jobs_auditLogId_fkey" FOREIGN KEY ("auditLogId") REFERENCES "audit_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
