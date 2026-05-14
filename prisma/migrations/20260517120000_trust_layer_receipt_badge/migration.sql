-- Trust layer: optional admin profile badge + deal completion receipts
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "profile_badge" VARCHAR(64);

CREATE TABLE IF NOT EXISTS "deal_receipts" (
    "id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "deal_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "deal_receipts_deal_id_key" ON "deal_receipts"("deal_id");

ALTER TABLE "deal_receipts" ADD CONSTRAINT "deal_receipts_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
