-- AlterTable
ALTER TABLE "users" ADD COLUMN "notification_prefs" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "users" ADD COLUMN "last_seen_username" TEXT;
ALTER TABLE "users" ADD COLUMN "username_change_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "deals" ADD COLUMN "high_value_approval" TEXT;
ALTER TABLE "deals" ADD COLUMN "join_expires_at" TIMESTAMP(3);
ALTER TABLE "deals" ADD COLUMN "terms_expires_at" TIMESTAMP(3);
ALTER TABLE "deals" ADD COLUMN "seller_payout_confirmed_at" TIMESTAMP(3);
ALTER TABLE "deals" ADD COLUMN "cancel_requested_by_buyer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deals" ADD COLUMN "cancel_requested_by_seller" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deals" ADD COLUMN "buyer_pay_reminded_at" TIMESTAMP(3);
ALTER TABLE "deals" ADD COLUMN "seller_upload_reminded_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN "admin_note" TEXT;
ALTER TABLE "payouts" ADD COLUMN "seller_notified_sent_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "saved_wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "label" VARCHAR(64),
    "currency" VARCHAR(16) NOT NULL,
    "network" VARCHAR(32) NOT NULL,
    "address" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_wallets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "saved_wallets_user_id_idx" ON "saved_wallets"("user_id");

ALTER TABLE "saved_wallets" ADD CONSTRAINT "saved_wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
