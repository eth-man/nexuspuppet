-- CreateTable
CREATE TABLE "enc_replication_peers" (
    "certname" VARCHAR(255) NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFetchAt" TIMESTAMP(3) NOT NULL,
    "lastEtag" VARCHAR(64) NOT NULL,
    "lastStatus" INTEGER NOT NULL,
    "lastChangedAt" TIMESTAMP(3),
    "fetchCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "enc_replication_peers_pkey" PRIMARY KEY ("certname")
);

-- CreateIndex
CREATE INDEX "enc_replication_peers_lastFetchAt_idx" ON "enc_replication_peers"("lastFetchAt");

