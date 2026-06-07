-- Track which Telegram bots each user has interacted with
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "registered_on_main_bot" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "registered_on_report_bot" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_seen_main_bot_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_seen_report_bot_at" TIMESTAMP(3);
