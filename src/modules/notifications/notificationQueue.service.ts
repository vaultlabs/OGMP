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

export type DmJob = {
  chatId: string;
  text: string;
  parseMode?: "Markdown" | "HTML";
  /** Optional inline keyboard (serialized for BullMQ). */
  buttons?: { text: string; cb: string }[][];
};
export type AdminReportJob =
  | { type: "admin_report_submitted"; reportId: string }
  | { type: "admin_report_more_evidence"; reportId: string };

export type BuyerDeliveryJob = {
  dealId: string;
  buyerTelegramId: string;
};

export async function enqueueDealParticipantNotify(params: {
  targetTelegramId: bigint;
  text: string;
  buttons?: { text: string; cb: string }[][];
}): Promise<void> {
  try {
    if (params.buttons?.length) {
      await enqueueDmWithButtons({
        chatId: params.targetTelegramId.toString(),
        text: params.text,
        buttons: params.buttons,
      });
      return;
    }
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

export async function enqueueDmWithButtons(params: {
  chatId: string;
  text: string;
  parseMode?: "Markdown" | "HTML";
  buttons: { text: string; cb: string }[][];
}): Promise<void> {
  try {
    await getNotificationQueue().add("dm", {
      chatId: params.chatId,
      text: params.text,
      parseMode: params.parseMode ?? "Markdown",
      buttons: params.buttons,
    } satisfies DmJob);
  } catch (e) {
    logger.error("enqueue_dm_buttons_failed", { err: String(e) });
  }
}

export async function enqueueBuyerDeliverySend(params: {
  dealId: string;
  buyerTelegramId: string;
}): Promise<void> {
  try {
    const job: BuyerDeliveryJob = { dealId: params.dealId, buyerTelegramId: params.buyerTelegramId };
    await getNotificationQueue().add("buyer_delivery", job);
  } catch (e) {
    logger.error("enqueue_buyer_delivery_failed", { err: String(e) });
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

export async function enqueueAdminReportMoreEvidence(reportId: string): Promise<void> {
  try {
    const job: AdminReportJob = { type: "admin_report_more_evidence", reportId };
    await getNotificationQueue().add("admin_report", job);
  } catch (e) {
    logger.error("enqueue_admin_report_more_evidence_failed", { err: String(e) });
  }
}
