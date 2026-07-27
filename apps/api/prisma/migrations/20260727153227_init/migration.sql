-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('VIEWER', 'OPERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "MatchStrategy" AS ENUM ('ALL_RULES', 'ANY_RULE', 'PINNED');

-- CreateEnum
CREATE TYPE "RuleOperator" AS ENUM ('EQUALS', 'NOT_EQUALS', 'MATCHES_REGEX', 'NOT_MATCHES_REGEX', 'IN', 'NOT_IN', 'GREATER_THAN', 'LESS_THAN', 'EXISTS', 'NOT_EXISTS');

-- CreateEnum
CREATE TYPE "MaterializationStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'VIEWER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "authSource" TEXT NOT NULL DEFAULT 'local',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_nodes" (
    "certname" VARCHAR(255) NOT NULL,
    "environment" TEXT,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "latestReportStatus" TEXT,
    "reportTimestamp" TIMESTAMP(3),
    "factsTimestamp" TIMESTAMP(3),
    "expired" BOOLEAN NOT NULL DEFAULT false,
    "projectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "managed_nodes_pkey" PRIMARY KEY ("certname")
);

-- CreateTable
CREATE TABLE "node_groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 100,
    "strategy" "MatchStrategy" NOT NULL DEFAULT 'ALL_RULES',
    "environment" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "parentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_group_rules" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "factPath" VARCHAR(512) NOT NULL,
    "operator" "RuleOperator" NOT NULL,
    "value" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_group_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_group_pins" (
    "groupId" UUID NOT NULL,
    "certname" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_group_pins_pkey" PRIMARY KEY ("groupId","certname")
);

-- CreateTable
CREATE TABLE "node_group_classes" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "className" VARCHAR(255) NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_group_classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_group_parameters" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_group_parameters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enc_materialization_jobs" (
    "id" UUID NOT NULL,
    "certname" VARCHAR(255),
    "dedupeKey" TEXT NOT NULL,
    "reason" VARCHAR(255) NOT NULL,
    "status" "MaterializationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "enc_materialization_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enc_materializations" (
    "certname" VARCHAR(255) NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "relativePath" TEXT NOT NULL,
    "appliedGroupIds" UUID[],
    "conflicts" JSONB NOT NULL DEFAULT '[]',
    "writtenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enc_materializations_pkey" PRIMARY KEY ("certname")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorUserId" UUID,
    "actorEmail" TEXT,
    "action" VARCHAR(128) NOT NULL,
    "entityType" VARCHAR(64) NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" VARCHAR(128) NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "saved_queries" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "filter" JSONB NOT NULL,
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_queries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_isActive_idx" ON "users"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- CreateIndex
CREATE INDEX "managed_nodes_environment_idx" ON "managed_nodes"("environment");

-- CreateIndex
CREATE INDEX "managed_nodes_projectedAt_idx" ON "managed_nodes"("projectedAt");

-- CreateIndex
CREATE INDEX "managed_nodes_latestReportStatus_idx" ON "managed_nodes"("latestReportStatus");

-- CreateIndex
CREATE UNIQUE INDEX "node_groups_name_key" ON "node_groups"("name");

-- CreateIndex
CREATE INDEX "node_groups_rank_id_idx" ON "node_groups"("rank", "id");

-- CreateIndex
CREATE INDEX "node_groups_parentId_idx" ON "node_groups"("parentId");

-- CreateIndex
CREATE INDEX "node_groups_isEnabled_idx" ON "node_groups"("isEnabled");

-- CreateIndex
CREATE INDEX "node_group_rules_groupId_idx" ON "node_group_rules"("groupId");

-- CreateIndex
CREATE INDEX "node_group_pins_certname_idx" ON "node_group_pins"("certname");

-- CreateIndex
CREATE INDEX "node_group_classes_className_idx" ON "node_group_classes"("className");

-- CreateIndex
CREATE UNIQUE INDEX "node_group_classes_groupId_className_key" ON "node_group_classes"("groupId", "className");

-- CreateIndex
CREATE UNIQUE INDEX "node_group_parameters_groupId_key_key" ON "node_group_parameters"("groupId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "enc_materialization_jobs_dedupeKey_key" ON "enc_materialization_jobs"("dedupeKey");

-- CreateIndex
CREATE INDEX "enc_materialization_jobs_status_nextAttemptAt_idx" ON "enc_materialization_jobs"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "enc_materialization_jobs_certname_idx" ON "enc_materialization_jobs"("certname");

-- CreateIndex
CREATE INDEX "enc_materializations_writtenAt_idx" ON "enc_materializations"("writtenAt");

-- CreateIndex
CREATE INDEX "enc_materializations_contentHash_idx" ON "enc_materializations"("contentHash");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_idx" ON "audit_logs"("actorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "saved_queries_userId_name_key" ON "saved_queries"("userId", "name");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_groups" ADD CONSTRAINT "node_groups_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "node_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_group_rules" ADD CONSTRAINT "node_group_rules_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "node_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_group_pins" ADD CONSTRAINT "node_group_pins_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "node_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_group_pins" ADD CONSTRAINT "node_group_pins_certname_soft_fkey" FOREIGN KEY ("certname") REFERENCES "managed_nodes"("certname") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_group_classes" ADD CONSTRAINT "node_group_classes_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "node_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_group_parameters" ADD CONSTRAINT "node_group_parameters_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "node_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enc_materializations" ADD CONSTRAINT "enc_materializations_certname_fkey" FOREIGN KEY ("certname") REFERENCES "managed_nodes"("certname") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
