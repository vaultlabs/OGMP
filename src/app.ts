import "dotenv/config";
import { loadConfig, getReportBotToken, cacheReportBotTelegramUsername } from "./config/index.js";
import { prisma } from "./db/prisma.js";
import { initDefaultSettings } from "./services/bot-settings.service.js";
import { createMainBot } from "./bots/mainBot/main-bot.js";
import { createReportBot } from "./bots/reportBot/report-bot.js";
import { startHttpServer } from "./server/http.js";
import { runPaymentWatcherOnce } from "./jobs/paymentWatcher.job.js";
import { runExpiryWatcherOnce } from "./jobs/expiryWatcher.job.js";
import { logger } from "./utils/logger.js";
import { startNotificationWorker, stopNotificationWorker } from "./workers/notification.worker.js";
import type { Bot } from "grammy";
import type { Context } from "grammy";

export { createMainBot as createBot } from "./bots/mainBot/main-bot.js";

export async function startApp(): Promise<void> {
  loadConfig();
  await prisma.$connect();
  await initDefaultSettings();

  const mainBot = createMainBot();
  startHttpServer(mainBot);

  let reportBot: Bot<Context> | null = null;
  if (getReportBotToken()) {
    try {
      reportBot = createReportBot();
    } catch (e) {
      logger.warn("report_bot_disabled", { err: String(e) });
    }
  }

  startNotificationWorker();

  const paymentTimer = setInterval(() => {
    void runPaymentWatcherOnce().catch((e) => logger.error("payment_watcher", { err: String(e) }));
  }, 60_000);

  const expiryTimer = setInterval(() => {
    void runExpiryWatcherOnce().catch((e) => logger.error("expiry_watcher", { err: String(e) }));
  }, 120_000);

  void runPaymentWatcherOnce().catch(() => {});
  void runExpiryWatcherOnce().catch(() => {});

  /** This app uses long polling (`bot.start()`). A leftover webhook in BotFather blocks updates — bot looks “dead”. */
  try {
    await mainBot.api.deleteWebhook({ drop_pending_updates: false });
  } catch (e) {
    logger.warn("main_bot_delete_webhook_failed", { err: String(e) });
  }

  await mainBot.start({
    onStart: (info) => {
      logger.info("main_bot_started", { username: info.username });
    },
  });

  if (reportBot) {
    try {
      await reportBot.api.deleteWebhook({ drop_pending_updates: false });
    } catch (e) {
      logger.warn("report_bot_delete_webhook_failed", { err: String(e) });
    }
    await reportBot.start({
      onStart: (info) => {
        cacheReportBotTelegramUsername(info.username);
        logger.info("report_bot_started", { username: info.username });
      },
    });
  }

  const shutdown = async () => {
    clearInterval(paymentTimer);
    clearInterval(expiryTimer);
    await mainBot.stop();
    if (reportBot) await reportBot.stop();
    await stopNotificationWorker();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
