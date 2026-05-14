-- Idempotent repair: same columns as 20260518140000_production_polish, safe if that migration
-- never ran, was skipped, or the DB was restored from an older snapshot while Prisma schema is new.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notification_prefs" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_seen_username" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username_change_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "high_value_approval" TEXT;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "join_expires_at" TIMESTAMP(3);
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "terms_expires_at" TIMESTAMP(3);
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "seller_payout_confirmed_at" TIMESTAMP(3);
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "cancel_requested_by_buyer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "cancel_requested_by_seller" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "buyer_pay_reminded_at" TIMESTAMP(3);
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "seller_upload_reminded_at" TIMESTAMP(3);

ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "admin_note" TEXT;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "seller_notified_sent_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "saved_wallets" (
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

CREATE INDEX IF NOT EXISTS "saved_wallets_user_id_idx" ON "saved_wallets"("user_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'saved_wallets_user_id_fkey'
  ) THEN
    ALTER TABLE "saved_wallets" ADD CONSTRAINT "saved_wallets_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
