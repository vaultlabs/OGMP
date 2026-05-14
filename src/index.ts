import "dotenv/config";
import { logger } from "./utils/logger.js";
import { runPendingMigrations } from "./db/run-pending-migrations.js";

async function main(): Promise<void> {
  runPendingMigrations();
  const { startApp } = await import("./app.js");
  await startApp();
}

void main().catch((e) => {
  logger.error("fatal", { err: String(e) });
  process.exit(1);
});
