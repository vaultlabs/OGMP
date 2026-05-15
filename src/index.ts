import "dotenv/config";
import { logger } from "./utils/logger.js";
import { startApp } from "./app.js";

void startApp().catch((e) => {
  logger.error("fatal", { err: String(e) });
  process.exit(1);
});
