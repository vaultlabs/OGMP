/**
 * Runs in a child process (see src/db/prisma.ts) so migrate + schema repair
 * always complete before the app PrismaClient connects — survives wrong entrypoints
 * and stale assumptions about index.ts load order.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { executePostgresSchemaEnsure } from "../src/db/postgres-schema-ensure.js";

async function main(): Promise<void> {
  console.info("[OGMP-MM] db_boot_subprocess_start", { cwd: process.cwd() });
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is missing — cannot run db boot");
  }
  if (process.env.SKIP_PRISMA_MIGRATE_ON_START !== "true" && process.env.SKIP_PRISMA_MIGRATE_ON_START !== "1") {
    console.info("[OGMP-MM] prisma_migrate_deploy_start");
    execSync("npx prisma migrate deploy", {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });
    console.info("[OGMP-MM] prisma_migrate_deploy_ok");
  } else {
    console.info("[OGMP-MM] prisma_migrate_deploy_skipped (SKIP_PRISMA_MIGRATE_ON_START)");
  }
  await executePostgresSchemaEnsure();
  console.info("[OGMP-MM] db_boot_subprocess_ok");
}

void main().catch((e) => {
  console.error("[OGMP-MM] db_boot_subprocess_failed", String(e));
  process.exit(1);
});
