import "dotenv/config";
import { execSync } from "node:child_process";

/**
 * Applies pending SQL migrations before PrismaClient is imported anywhere.
 * Stops "column does not exist" when operators forget `prisma migrate deploy`.
 * Set SKIP_PRISMA_MIGRATE_ON_START=true to disable (e.g. some read-only containers).
 */
export function runPendingMigrations(): void {
  if (process.env.SKIP_PRISMA_MIGRATE_ON_START === "true" || process.env.SKIP_PRISMA_MIGRATE_ON_START === "1") {
    console.info("[OGMP-MM] prisma_migrate_deploy_skipped (SKIP_PRISMA_MIGRATE_ON_START)");
    return;
  }
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
