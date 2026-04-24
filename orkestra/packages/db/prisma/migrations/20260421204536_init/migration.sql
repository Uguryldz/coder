-- CreateEnum
CREATE TYPE "AgentRoleType" AS ENUM ('intake', 'analyst', 'developer', 'dev_reviewer', 'test_designer', 'test_reviewer', 'test_runner');

-- CreateEnum
CREATE TYPE "KnowledgeCategory" AS ENUM ('rules', 'conventions', 'domain', 'examples', 'glossary');

-- CreateEnum
CREATE TYPE "KnowledgeScope" AS ENUM ('variant', 'shared');

-- CreateEnum
CREATE TYPE "WorkMode" AS ENUM ('full_auto', 'ai_assist', 'human_lead', 'human_only');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('running', 'waiting_info', 'waiting_po', 'waiting_tech_lead', 'in_development', 'ai_coding', 'security_scan', 'ai_reviewing', 'test_design', 'waiting_qa', 'testing', 'ci_running', 'waiting_qa_results', 'waiting_pr_approval', 'done', 'cancelled', 'blocked', 'failed');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('admin', 'team_lead', 'analyst', 'viewer');

-- CreateTable
CREATE TABLE "AgentVariant" (
    "id" TEXT NOT NULL,
    "role" "AgentRoleType" NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "activeVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "maxTokens" INTEGER NOT NULL DEFAULT 4096,
    "toolAllowlist" JSONB NOT NULL DEFAULT '[]',
    "outputSchemaRef" TEXT,
    "knowledgeHash" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeFile" (
    "id" TEXT NOT NULL,
    "scope" "KnowledgeScope" NOT NULL,
    "ownerId" TEXT,
    "category" "KnowledgeCategory" NOT NULL,
    "filename" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "contentKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantKnowledgeLink" (
    "variantId" TEXT NOT NULL,
    "knowledgeFileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VariantKnowledgeLink_pkey" PRIMARY KEY ("variantId","knowledgeFileId")
);

-- CreateTable
CREATE TABLE "RoutingRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "matchLabel" TEXT,
    "matchComponent" TEXT,
    "matchProject" TEXT,
    "matchWorkType" TEXT,
    "variantId" TEXT NOT NULL,
    "workMode" "WorkMode" NOT NULL DEFAULT 'full_auto',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoldenTicket" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "category" TEXT,
    "contentKey" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoldenTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evaluation" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "fromVersionId" TEXT NOT NULL,
    "toVersionId" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "overallScore" DOUBLE PRECISION,
    "notes" TEXT,

    CONSTRAINT "Evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationRun" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "goldenTicketId" TEXT NOT NULL,
    "fromOutputKey" TEXT NOT NULL,
    "toOutputKey" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "verdict" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" TEXT NOT NULL,
    "jiraTicketId" TEXT NOT NULL,
    "jiraProjectKey" TEXT NOT NULL,
    "temporalWorkflowId" TEXT,
    "temporalRunId" TEXT,
    "workMode" "WorkMode" NOT NULL,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'running',
    "currentStep" TEXT NOT NULL DEFAULT 'start',
    "baseCommit" TEXT,
    "branchName" TEXT,
    "prId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "tokenCostUsdCents" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "cacheHits" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepExecution" (
    "id" TEXT NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "stepName" TEXT NOT NULL,
    "agentRole" "AgentRoleType",
    "variantId" TEXT,
    "promptVersionId" TEXT,
    "knowledgeHash" TEXT,
    "inputKey" TEXT,
    "outputKey" TEXT,
    "model" TEXT,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "cacheHits" INTEGER NOT NULL DEFAULT 0,
    "costUsdCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "StepExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HumanDecision" (
    "id" TEXT NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "stepName" TEXT NOT NULL,
    "jiraUserId" TEXT NOT NULL,
    "jiraUsername" TEXT,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "command" TEXT,
    "signature" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HumanDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "workflowRunId" TEXT,
    "kind" TEXT NOT NULL,
    "contentKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "workflowRunId" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "prevHash" TEXT NOT NULL,
    "thisHash" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "role" "AdminRole" NOT NULL DEFAULT 'viewer',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "PIIMaskingConfig" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "fieldRules" JSONB NOT NULL DEFAULT '[]',
    "patternRules" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "PIIMaskingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostCounter" (
    "scope" TEXT NOT NULL,
    "usdCents" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostCounter_pkey" PRIMARY KEY ("scope")
);

-- CreateTable
CREATE TABLE "KnowledgeFeedback" (
    "id" TEXT NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "aiPatchKey" TEXT NOT NULL,
    "finalDiffKey" TEXT NOT NULL,
    "deltaKey" TEXT NOT NULL,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "reviewerId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentVariant_activeVersionId_key" ON "AgentVariant"("activeVersionId");

-- CreateIndex
CREATE INDEX "AgentVariant_role_active_idx" ON "AgentVariant"("role", "active");

-- CreateIndex
CREATE UNIQUE INDEX "AgentVariant_role_name_key" ON "AgentVariant"("role", "name");

-- CreateIndex
CREATE INDEX "PromptVersion_variantId_idx" ON "PromptVersion"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_variantId_version_key" ON "PromptVersion"("variantId", "version");

-- CreateIndex
CREATE INDEX "KnowledgeFile_scope_ownerId_idx" ON "KnowledgeFile"("scope", "ownerId");

-- CreateIndex
CREATE INDEX "KnowledgeFile_scope_category_idx" ON "KnowledgeFile"("scope", "category");

-- CreateIndex
CREATE INDEX "VariantKnowledgeLink_knowledgeFileId_idx" ON "VariantKnowledgeLink"("knowledgeFileId");

-- CreateIndex
CREATE INDEX "RoutingRule_active_priority_idx" ON "RoutingRule"("active", "priority");

-- CreateIndex
CREATE INDEX "GoldenTicket_category_idx" ON "GoldenTicket"("category");

-- CreateIndex
CREATE INDEX "Evaluation_variantId_idx" ON "Evaluation"("variantId");

-- CreateIndex
CREATE INDEX "EvaluationRun_evaluationId_idx" ON "EvaluationRun"("evaluationId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRun_temporalWorkflowId_key" ON "WorkflowRun"("temporalWorkflowId");

-- CreateIndex
CREATE INDEX "WorkflowRun_jiraTicketId_idx" ON "WorkflowRun"("jiraTicketId");

-- CreateIndex
CREATE INDEX "WorkflowRun_status_idx" ON "WorkflowRun"("status");

-- CreateIndex
CREATE INDEX "WorkflowRun_startedAt_idx" ON "WorkflowRun"("startedAt");

-- CreateIndex
CREATE INDEX "StepExecution_workflowRunId_idx" ON "StepExecution"("workflowRunId");

-- CreateIndex
CREATE INDEX "StepExecution_stepName_status_idx" ON "StepExecution"("stepName", "status");

-- CreateIndex
CREATE INDEX "HumanDecision_workflowRunId_idx" ON "HumanDecision"("workflowRunId");

-- CreateIndex
CREATE INDEX "Artifact_workflowRunId_kind_idx" ON "Artifact"("workflowRunId", "kind");

-- CreateIndex
CREATE INDEX "AuditLog_workflowRunId_idx" ON "AuditLog"("workflowRunId");

-- CreateIndex
CREATE INDEX "AuditLog_actor_idx" ON "AuditLog"("actor");

-- CreateIndex
CREATE INDEX "AuditLog_timestamp_idx" ON "AuditLog"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_active_idx" ON "User"("role", "active");

-- CreateIndex
CREATE INDEX "KnowledgeFeedback_reviewed_createdAt_idx" ON "KnowledgeFeedback"("reviewed", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentVariant" ADD CONSTRAINT "AgentVariant_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "AgentVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantKnowledgeLink" ADD CONSTRAINT "VariantKnowledgeLink_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "AgentVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantKnowledgeLink" ADD CONSTRAINT "VariantKnowledgeLink_knowledgeFileId_fkey" FOREIGN KEY ("knowledgeFileId") REFERENCES "KnowledgeFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "AgentVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "AgentVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "Evaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_goldenTicketId_fkey" FOREIGN KEY ("goldenTicketId") REFERENCES "GoldenTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepExecution" ADD CONSTRAINT "StepExecution_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepExecution" ADD CONSTRAINT "StepExecution_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "AgentVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanDecision" ADD CONSTRAINT "HumanDecision_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
