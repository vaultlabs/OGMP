-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('pending_acceptance', 'waiting_payment', 'payment_detected', 'funded', 'item_delivered', 'buyer_confirmed', 'release_pending_admin', 'released', 'disputed', 'cancelled', 'refunded');

-- CreateEnum
CREATE TYPE "FeePayer" AS ENUM ('buyer', 'seller', 'split');

-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('buyer', 'seller');

-- CreateEnum
CREATE TYPE "PaymentRecordStatus" AS ENUM ('pending', 'detecting', 'confirming', 'confirmed', 'underpaid', 'overpaid', 'expired', 'failed');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('open', 'awaiting_evidence', 'resolved');

-- CreateEnum
CREATE TYPE "DisputeResolution" AS ENUM ('release_to_seller', 'refund_buyer', 'partial_refund', 'cancel_deal', 'request_more_evidence');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('open', 'closed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "telegram_id" BIGINT NOT NULL,
    "username" TEXT,
    "first_name" TEXT,
    "terms_accepted_at" TIMESTAMP(3),
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "banned" BOOLEAN NOT NULL DEFAULT false,
    "banned_reason" TEXT,
    "completed_deals" INTEGER NOT NULL DEFAULT 0,
    "disputed_deals" INTEGER NOT NULL DEFAULT 0,
    "cancelled_deals" INTEGER NOT NULL DEFAULT 0,
    "total_volume_usd" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "reputation_score" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "suspicious_flags" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" UUID NOT NULL,
    "deal_code" TEXT NOT NULL,
    "invite_token" TEXT NOT NULL,
    "buyer_id" UUID,
    "seller_id" UUID,
    "creator_id" UUID NOT NULL,
    "creator_role" "ParticipantRole" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "deal_terms" TEXT NOT NULL,
    "delivery_instructions" TEXT NOT NULL,
    "proof_requirements" TEXT,
    "seller_payout_address" TEXT,
    "buyer_refund_address" TEXT,
    "amount" DECIMAL(36,18) NOT NULL,
    "currency" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "fee_amount" DECIMAL(36,18) NOT NULL,
    "fee_payer" "FeePayer" NOT NULL,
    "network_fee_estimate" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "status" "DealStatus" NOT NULL DEFAULT 'pending_acceptance',
    "version" INTEGER NOT NULL DEFAULT 0,
    "payment_address" TEXT,
    "payment_provider_ref" TEXT,
    "payment_expires_at" TIMESTAMP(3),
    "tx_hash" TEXT,
    "funded_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "disputed_at" TIMESTAMP(3),
    "auto_release_not_before" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_participants" (
    "id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "ParticipantRole" NOT NULL,
    "terms_accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "address" TEXT,
    "reference" TEXT,
    "expected_amount" DECIMAL(36,18) NOT NULL,
    "received_amount" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "status" "PaymentRecordStatus" NOT NULL DEFAULT 'pending',
    "tx_hash" TEXT,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "required_confirmations" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMP(3),
    "webhook_delivered_at" TIMESTAMP(3),
    "raw_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "fee_deducted" DECIMAL(36,18) NOT NULL,
    "currency" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'pending',
    "tx_hash" TEXT,
    "provider_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "opened_by_id" UUID NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'open',
    "resolution" "DisputeResolution",
    "resolution_note" TEXT,
    "partial_refund_amount" DECIMAL(36,18),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_evidence" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "message" TEXT NOT NULL,
    "file_id" TEXT,
    "file_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "from_user_id" UUID NOT NULL,
    "to_user_id" UUID NOT NULL,
    "stars" INTEGER NOT NULL,
    "text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_settings" (
    "id" UUID NOT NULL,
    "percentage" DECIMAL(10,6) NOT NULL DEFAULT 0.01,
    "minimum_usd" DECIMAL(18,2) NOT NULL DEFAULT 1,
    "maximum_usd" DECIMAL(18,2),
    "fixed_usd" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "default_fee_payer" "FeePayer" NOT NULL DEFAULT 'split',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supported_coins" (
    "id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "confirmations_required" INTEGER NOT NULL DEFAULT 12,
    "payment_timeout_minutes" INTEGER NOT NULL DEFAULT 60,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supported_coins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_action_logs" (
    "id" UUID NOT NULL,
    "admin_telegram_id" BIGINT NOT NULL,
    "action" TEXT NOT NULL,
    "deal_id" UUID,
    "target_telegram_id" BIGINT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_action_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_settings" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "deal_id" UUID,
    "event_type" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "deal_code" TEXT,
    "issue_type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "file_id" TEXT,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_code_counters" (
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "deal_code_counters_pkey" PRIMARY KEY ("year")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "deals_deal_code_key" ON "deals"("deal_code");

-- CreateIndex
CREATE UNIQUE INDEX "deals_invite_token_key" ON "deals"("invite_token");

-- CreateIndex
CREATE INDEX "deals_status_idx" ON "deals"("status");

-- CreateIndex
CREATE INDEX "deals_creator_id_idx" ON "deals"("creator_id");

-- CreateIndex
CREATE INDEX "deal_participants_deal_id_idx" ON "deal_participants"("deal_id");

-- CreateIndex
CREATE UNIQUE INDEX "deal_participants_deal_id_user_id_key" ON "deal_participants"("deal_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "payments_deal_id_idx" ON "payments"("deal_id");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payouts_deal_id_idx" ON "payouts"("deal_id");

-- CreateIndex
CREATE INDEX "disputes_deal_id_idx" ON "disputes"("deal_id");

-- CreateIndex
CREATE INDEX "disputes_status_idx" ON "disputes"("status");

-- CreateIndex
CREATE INDEX "dispute_evidence_dispute_id_idx" ON "dispute_evidence"("dispute_id");

-- CreateIndex
CREATE INDEX "reviews_to_user_id_idx" ON "reviews"("to_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_deal_id_from_user_id_key" ON "reviews"("deal_id", "from_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "supported_coins_currency_network_key" ON "supported_coins"("currency", "network");

-- CreateIndex
CREATE INDEX "admin_action_logs_admin_telegram_id_idx" ON "admin_action_logs"("admin_telegram_id");

-- CreateIndex
CREATE INDEX "admin_action_logs_created_at_idx" ON "admin_action_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bot_settings_key_key" ON "bot_settings"("key");

-- CreateIndex
CREATE INDEX "notification_logs_user_id_created_at_idx" ON "notification_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_deal_id_idx" ON "audit_logs"("deal_id");

-- CreateIndex
CREATE INDEX "audit_logs_event_type_created_at_idx" ON "audit_logs"("event_type", "created_at");

-- CreateIndex
CREATE INDEX "support_tickets_user_id_idx" ON "support_tickets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_idempotency_key_key" ON "webhook_events"("idempotency_key");

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_participants" ADD CONSTRAINT "deal_participants_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_participants" ADD CONSTRAINT "deal_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_opened_by_id_fkey" FOREIGN KEY ("opened_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

