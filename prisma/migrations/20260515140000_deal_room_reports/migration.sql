-- OGMP MM expansion: deal room, timeline, reports, freeze, release_requested rename

ALTER TYPE "DealStatus" RENAME VALUE 'release_pending_admin' TO 'release_requested';

CREATE TYPE "DealMessageType" AS ENUM ('text', 'photo', 'video', 'document', 'animation', 'voice', 'audio', 'other');
CREATE TYPE "ReportStatus" AS ENUM ('draft', 'submitted', 'under_review', 'waiting_for_buyer', 'waiting_for_seller', 'resolved_release', 'resolved_refund', 'resolved_partial', 'rejected', 'closed');
CREATE TYPE "ReportCategory" AS ENUM ('seller_no_delivery', 'buyer_no_confirm', 'wrong_item', 'scam_attempt', 'payment_issue', 'fake_proof', 'other');

ALTER TABLE "deals" ADD COLUMN "frozen" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deals" ADD COLUMN "frozen_at" TIMESTAMP(3);
ALTER TABLE "deals" ADD COLUMN "frozen_reason" TEXT;
ALTER TABLE "deals" ADD COLUMN "active_report_id" UUID;
ALTER TABLE "deals" ADD COLUMN "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "deals_frozen_idx" ON "deals"("frozen");

CREATE TABLE "reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_code" TEXT NOT NULL,
    "deal_id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "reporter_role" "ParticipantRole" NOT NULL,
    "category" "ReportCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'draft',
    "assigned_admin_telegram_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reports_report_code_key" ON "reports"("report_code");
CREATE INDEX "reports_deal_id_idx" ON "reports"("deal_id");
CREATE INDEX "reports_status_idx" ON "reports"("status");

ALTER TABLE "reports" ADD CONSTRAINT "reports_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "deals" ADD CONSTRAINT "deals_active_report_id_fkey" FOREIGN KEY ("active_report_id") REFERENCES "reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "deals_active_report_id_key" ON "deals"("active_report_id");

CREATE TABLE "deal_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deal_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "message_type" "DealMessageType" NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "telegram_file_id" TEXT,
    "telegram_file_unique_id" TEXT,
    "file_name" TEXT,
    "mime_type" TEXT,
    "file_size" INTEGER,
    "caption" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deal_messages_deal_id_created_at_idx" ON "deal_messages"("deal_id", "created_at");
ALTER TABLE "deal_messages" ADD CONSTRAINT "deal_messages_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deal_messages" ADD CONSTRAINT "deal_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "deal_timeline_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deal_id" UUID NOT NULL,
    "actor_id" UUID,
    "event_type" TEXT NOT NULL,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_timeline_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deal_timeline_events_deal_id_created_at_idx" ON "deal_timeline_events"("deal_id", "created_at");
ALTER TABLE "deal_timeline_events" ADD CONSTRAINT "deal_timeline_events_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deal_timeline_events" ADD CONSTRAINT "deal_timeline_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "report_evidence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_id" UUID NOT NULL,
    "uploader_id" UUID NOT NULL,
    "evidence_type" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "telegram_file_id" TEXT,
    "telegram_file_unique_id" TEXT,
    "file_name" TEXT,
    "mime_type" TEXT,
    "file_size" INTEGER,
    "caption" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_evidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "report_evidence_report_id_idx" ON "report_evidence"("report_id");
ALTER TABLE "report_evidence" ADD CONSTRAINT "report_evidence_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_evidence" ADD CONSTRAINT "report_evidence_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "report_admin_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_id" UUID NOT NULL,
    "admin_telegram_id" BIGINT NOT NULL,
    "note" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_admin_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "report_admin_notes_report_id_idx" ON "report_admin_notes"("report_id");
ALTER TABLE "report_admin_notes" ADD CONSTRAINT "report_admin_notes_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "report_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deal_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "report_sessions_token_hash_key" ON "report_sessions"("token_hash");
CREATE INDEX "report_sessions_deal_id_idx" ON "report_sessions"("deal_id");
ALTER TABLE "report_sessions" ADD CONSTRAINT "report_sessions_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_sessions" ADD CONSTRAINT "report_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "report_code_counters" (
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "report_code_counters_pkey" PRIMARY KEY ("year")
);
