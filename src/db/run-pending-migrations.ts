import "dotenv/config";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

/**
 * Idempotent DDL for Postgres when `_prisma_migrations` says "applied" but the DB
 * was restored, cloned, or drifted — no .env changes required.
 */
const ENSURE_PG_STATEMENTS: string[] = [
  // gateway_access
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "gateway_accepted_at" TIMESTAMP(3)`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "gateway_verified_at" TIMESTAMP(3)`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "gateway_verified" BOOLEAN NOT NULL DEFAULT false`,
  // trust / profile
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "profile_badge" VARCHAR(64)`,
  // production_polish (users)
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notification_prefs" JSONB NOT NULL DEFAULT '{}'`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_seen_username" TEXT`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username_change_count" INTEGER NOT NULL DEFAULT 0`,
  // deal_room_reports
  `ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "frozen" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "frozen_at" TIMESTAMP(3)`,
  `ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "frozen_reason" TEXT`,
  `ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "active_report_id" UUID`,
  `ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  // delivery_lock_flow
  `ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "delivery_unlock_notified_at" TIMESTAMP(3)`,
  `ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "delivery_files_bundle_sent_at" TIMESTAMP(3)`,
  `ALTER TABLE "deal_messages" ADD COLUMN IF NOT EXISTS "locked_for_buyer" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "deal_messages" ADD COLUMN IF NOT EXISTS "delivery_asset" BOOLEAN NOT NULL DEFAULT false`,
  // production_polish (deals + payouts)
  `ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "high_value_approval" TEXT`,
  `ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "join_expires_at" TIMESTAMP(3)`,
  `ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "terms_expires_at" TIMESTAMP(3)`,
  `ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "seller_payout_confirmed_at" TIMESTAMP(3)`,
  `ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "cancel_requested_by_buyer" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "cancel_requested_by_seller" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "buyer_pay_reminded_at" TIMESTAMP(3)`,
  `ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "seller_upload_reminded_at" TIMESTAMP(3)`,
  `ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "admin_note" TEXT`,
  `ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "seller_notified_sent_at" TIMESTAMP(3)`,
  // saved_wallets
  `CREATE TABLE IF NOT EXISTS "saved_wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "label" VARCHAR(64),
    "currency" VARCHAR(16) NOT NULL,
    "network" VARCHAR(32) NOT NULL,
    "address" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "saved_wallets_pkey" PRIMARY KEY ("id")
)`,
  `CREATE INDEX IF NOT EXISTS "saved_wallets_user_id_idx" ON "saved_wallets"("user_id")`,
  `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_wallets_user_id_fkey') THEN
    ALTER TABLE "saved_wallets" ADD CONSTRAINT "saved_wallets_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$`,
  // deal_receipts
  `CREATE TABLE IF NOT EXISTS "deal_receipts" (
    "id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "deal_receipts_pkey" PRIMARY KEY ("id")
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "deal_receipts_deal_id_key" ON "deal_receipts"("deal_id")`,
  `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deal_receipts_deal_id_fkey') THEN
    ALTER TABLE "deal_receipts" ADD CONSTRAINT "deal_receipts_deal_id_fkey"
      FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$`,
];

async function ensurePostgresColumnsMatchSchema(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgresql:") && !url.startsWith("postgres:")) {
    console.info("[OGMP-MM] schema_ensure_skipped (not PostgreSQL)");
    return;
  }
  console.info("[OGMP-MM] postgres_schema_ensure_start");
  const p = new PrismaClient({ log: ["error"] });
  try {
    for (const sql of ENSURE_PG_STATEMENTS) {
      await p.$executeRawUnsafe(sql);
    }
  } finally {
    await p.$disconnect();
  }
  console.info("[OGMP-MM] postgres_schema_ensure_ok");
}

/**
 * Applies pending SQL migrations before the shared PrismaClient is imported.
 * Then forces idempotent column DDL so drifted DBs match Prisma schema (no .env edits).
 * Set SKIP_PRISMA_MIGRATE_ON_START=true to disable migrate only; schema ensure still runs unless
 * SKIP_POSTGRES_SCHEMA_ENSURE=1.
 */
export async function runPendingMigrations(): Promise<void> {
  if (process.env.SKIP_PRISMA_MIGRATE_ON_START === "true" || process.env.SKIP_PRISMA_MIGRATE_ON_START === "1") {
    console.info("[OGMP-MM] prisma_migrate_deploy_skipped (SKIP_PRISMA_MIGRATE_ON_START)");
  } else {
    if (!process.env.DATABASE_URL?.trim()) {
      throw new Error("DATABASE_URL is required before prisma migrate deploy");
    }
    console.info("[OGMP-MM] prisma_migrate_deploy_start");
    try {
      execSync("npx prisma migrate deploy", {
        stdio: "inherit",
        cwd: process.cwd(),
        env: process.env,
      });
    } catch (e) {
      console.error("[OGMP-MM] prisma_migrate_deploy_failed", String(e));
      throw e;
    }
    console.info("[OGMP-MM] prisma_migrate_deploy_ok");
  }

  if (process.env.SKIP_POSTGRES_SCHEMA_ENSURE === "true" || process.env.SKIP_POSTGRES_SCHEMA_ENSURE === "1") {
    console.info("[OGMP-MM] postgres_schema_ensure_skipped (SKIP_POSTGRES_SCHEMA_ENSURE)");
    return;
  }
  await ensurePostgresColumnsMatchSchema();
}
