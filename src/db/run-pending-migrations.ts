import "dotenv/config";
import { execSync } from "node:child_process";
import { executePostgresSchemaEnsure } from "./postgres-schema-ensure.js";

/** Optional: run from CI or tooling (app boot uses scripts/db-boot.ts via prisma.ts). */
export async function runPendingMigrations(): Promise<void> {
  if (process.env.SKIP_PRISMA_MIGRATE_ON_START === "true" || process.env.SKIP_PRISMA_MIGRATE_ON_START === "1") {
    console.info("[OGMP-MM] prisma_migrate_deploy_skipped (SKIP_PRISMA_MIGRATE_ON_START)");
  } else {
    if (!process.env.DATABASE_URL?.trim()) {
      throw new Error("DATABASE_URL is required before prisma migrate deploy");
    }
    console.info("[OGMP-MM] prisma_migrate_deploy_start");
    execSync("npx prisma migrate deploy", {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });
    console.info("[OGMP-MM] prisma_migrate_deploy_ok");
  }
  await executePostgresSchemaEnsure();
}
