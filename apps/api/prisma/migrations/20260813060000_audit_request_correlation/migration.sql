-- Correlate the audit rows written by one operation (#229).
--
-- Purely additive. Both columns are nullable and every existing row keeps a
-- NULL requestId, which is the truthful value: those rows were written before
-- anything was correlating them, and inventing ids would imply operations a
-- reader could go and look for.
ALTER TABLE "audit_logs" ADD COLUMN "requestId" UUID;
ALTER TABLE "audit_logs" ADD COLUMN "entityLabel" VARCHAR(200);

-- "What else did that operation do?" must be one indexed lookup, not a scan of
-- a table bounded only by AUDIT_RETENTION_DAYS.
CREATE INDEX "audit_logs_requestId_idx" ON "audit_logs"("requestId");
