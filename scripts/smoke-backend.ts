/**
 * Quick smoke: validates .env parses, Prisma connects, default settings init.
 * Does not start Telegram bots (avoids token / network requirements).
 *
 * Usage: npx tsx scripts/smoke-backend.ts
 */
import "dotenv/config";
import { loadConfig, resetConfigCacheForTests } from "../src/config/index.js";
import { prisma } from "../src/db/prisma.js";
import { initDefaultSettings } from "../src/services/bot-settings.service.js";

async function main(): Promise<void> {
  resetConfigCacheForTests();
  loadConfig();
  await prisma.$connect();
  await initDefaultSettings();
  await prisma.$disconnect();
  // eslint-disable-next-line no-console
  console.log("smoke-backend: OK (config + prisma + settings)");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("smoke-backend: FAILED", e);
  process.exit(1);
});
