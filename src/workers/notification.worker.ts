import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { Api } from "grammy";
import { loadConfig, getMainBotToken } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { NOTIFICATION_QUEUE_NAME } from "../modules/notifications/notificationQueue.service.js";
import type { AdminReportJob, BuyerDeliveryJob, DmJob } from "../modules/notifications/notificationQueue.service.js";
import { notifyAdminsReportSubmitted, notifyAdminsReportMoreEvidence } from "../modules/reports/report-notify.service.js";
import { sendBuyerDeliveryBundleToChat } from "../services/buyer-delivery-send.service.js";
import { InlineKeyboard } from "grammy";

let worker: Worker | null = null;
let workerConnection: Redis | null = null;

export function startNotificationWorker(): Worker | null {
  const cfg = loadConfig();
  if (!cfg.NOTIFICATION_WORKER_ENABLED) return null;
  workerConnection = new Redis(cfg.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  const api = new Api(getMainBotToken());
  worker = new Worker(
    NOTIFICATION_QUEUE_NAME,
    async (job: Job) => {
      if (job.name === "dm") {
        const data = job.data as DmJob;
        if (data.buttons?.length) {
          const kb = new InlineKeyboard();
          for (const row of data.buttons) {
            for (const b of row) kb.text(b.text, b.cb);
            kb.row();
          }
          await api.sendMessage(data.chatId, data.text, {
            ...(data.parseMode ? { parse_mode: data.parseMode } : {}),
            reply_markup: kb,
          });
        } else {
          await api.sendMessage(data.chatId, data.text, {
            ...(data.parseMode ? { parse_mode: data.parseMode } : {}),
          });
        }
        return;
      }
      if (job.name === "buyer_delivery") {
        const data = job.data as BuyerDeliveryJob;
        await sendBuyerDeliveryBundleToChat({
          buyerTelegramId: data.buyerTelegramId,
          dealId: data.dealId,
        });
        return;
      }
      if (job.name === "admin_report") {
        const data = job.data as AdminReportJob;
        if (data.type === "admin_report_submitted") {
          await notifyAdminsReportSubmitted(data.reportId);
        } else if (data.type === "admin_report_more_evidence") {
          await notifyAdminsReportMoreEvidence(data.reportId);
        }
      }
    },
    { connection: workerConnection },
  );
  worker.on("failed", (j: Job | undefined, err: Error) => {
    logger.error("notification_job_failed", { id: j?.id, err: String(err) });
  });
  logger.info("notification_worker_started");
  return worker;
}

export async function stopNotificationWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (workerConnection) {
    await workerConnection.quit();
    workerConnection = null;
  }
}
