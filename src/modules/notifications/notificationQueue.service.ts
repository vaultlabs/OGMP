import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

export const NOTIFICATION_QUEUE_NAME = "ogmp-notifications";

let connection: Redis | null = null;
function getConnection(): Redis {
  if (!connection) {
    connection = new Redis(loadConfig().REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return connection;
}

let notificationQueue: Queue | null = null;

export function getNotificationQueue(): Queue {
  if (!notificationQueue) {
    notificationQueue = new Queue(NOTIFICATION_QUEUE_NAME, {
      connection: getConnection(),
      defaultJobOptions: { removeOnComplete: 500, removeOnFail: 500 },
    });
  }
  return notificationQueue;
}

export type DmJob = { chatId: string; text: string; parseMode?: "Markdown" | "HTML" };
export type AdminReportJob = { type: "admin_report_submitted"; reportId: string };

export async function enqueueDealParticipantNotify(params: {
  targetTelegramId: bigint;
  text: string;
}): Promise<void> {
  try {
    const job: DmJob = {
      chatId: params.targetTelegramId.toString(),
      text: params.text,
      parseMode: "Markdown",
    };
    await getNotificationQueue().add("dm", job);
  } catch (e) {
    logger.error("enqueue_notify_failed", { err: String(e) });
  }
}

export async function enqueueAdminReportSubmitted(reportId: string): Promise<void> {
  try {
    const job: AdminReportJob = { type: "admin_report_submitted", reportId };
    await getNotificationQueue().add("admin_report", job);
  } catch (e) {
    logger.error("enqueue_admin_report_failed", { err: String(e) });
  }
}
