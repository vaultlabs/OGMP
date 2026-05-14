-- Seller pre-payment locked delivery + idempotent funded notifications

ALTER TABLE "deals" ADD COLUMN "delivery_unlock_notified_at" TIMESTAMP(3);
ALTER TABLE "deals" ADD COLUMN "delivery_files_bundle_sent_at" TIMESTAMP(3);

ALTER TABLE "deal_messages" ADD COLUMN "locked_for_buyer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deal_messages" ADD COLUMN "delivery_asset" BOOLEAN NOT NULL DEFAULT false;
