import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { Api } from "grammy";
import { loadConfig, getMainBotToken } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { NOTIFICATION_QUEUE_NAME } from "../modules/notifications/notificationQueue.service.js";
import type { AdminReportJob, DmJob } from "../modules/notifications/notificationQueue.service.js";
import { notifyAdminsReportSubmitted } from "../modules/reports/report-notify.service.js";

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
        await api.sendMessage(data.chatId, data.text, {
          parse_mode: data.parseMode ?? "Markdown",
        });
        return;
      }
      if (job.name === "admin_report") {
        const data = job.data as AdminReportJob;
        if (data.type === "admin_report_submitted") {
          await notifyAdminsReportSubmitted(data.reportId);
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
