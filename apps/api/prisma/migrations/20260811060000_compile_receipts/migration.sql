-- Compile receipts (ADR-0022 §7-§8, §11).
--
-- No foreign key to managed_nodes on purpose: a receipt for a node the console
-- cannot see is evidence about exactly the node somebody is debugging, and a
-- constraint would reject it at ingest.
CREATE TABLE "compile_receipts" (
    "peerCertname" VARCHAR(255) NOT NULL,
    "certname" VARCHAR(255) NOT NULL,
    "revision" VARCHAR(64) NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "matchedAtIngest" BOOLEAN NOT NULL,

    CONSTRAINT "compile_receipts_pkey" PRIMARY KEY ("peerCertname","certname")
);

-- Node detail reads by node across every serving Puppet server.
CREATE INDEX "compile_receipts_certname_idx" ON "compile_receipts"("certname");
