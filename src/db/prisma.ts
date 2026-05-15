import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { loadConfig } from "../config/index.js";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; __ogmpDbBootDone?: boolean };

/**
 * Migrate + idempotent schema repair run in a subprocess before the first PrismaClient
 * is constructed. That way it still runs if someone starts the wrong file, uses stale dist,
 * or the previous in-process boot race reappears.
 */
function runDatabaseBootSubprocessSync(): void {
  if (globalForPrisma.__ogmpDbBootDone) return;

  const skip =
    process.env.VITEST === "true" ||
    process.env.VITEST === "1" ||
    process.env.NODE_ENV === "test" ||
    process.env.OGMP_SKIP_DB_BOOT === "1";

  if (skip) {
    globalForPrisma.__ogmpDbBootDone = true;
    return;
  }

  const bootScript = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "db-boot.ts");
  console.info("[OGMP-MM] db_boot_subprocess_spawning", { script: bootScript });
  execSync(`npx tsx "${bootScript}"`, { stdio: "inherit", cwd: process.cwd(), env: process.env });
  globalForPrisma.__ogmpDbBootDone = true;
}

export function createPrismaClient(): PrismaClient {
  runDatabaseBootSubprocessSync();
  const cfg = loadConfig();
  return new PrismaClient({
    log: cfg.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
