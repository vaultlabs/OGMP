import { InlineKeyboard, Api } from "grammy";
import { getMainBotToken } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import { getNotificationQueue } from "./notificationQueue.service.js";

let api: Api | null = null;

function getApi(): Api {
  if (!api) api = new Api(getMainBotToken());
  return api;
}

async function sendDmDirect(params: {
  chatId: string;
  text: string;
  buttons?: { text: string; cb: string }[][];
}): Promise<void> {
  const telegram = getApi();
  if (params.buttons?.length) {
    const kb = new InlineKeyboard();
    for (const row of params.buttons) {
      for (const b of row) kb.text(b.text, b.cb);
      kb.row();
    }
    await telegram.sendMessage(params.chatId, params.text, { reply_markup: kb });
    return;
  }
  await telegram.sendMessage(params.chatId, params.text);
}

async function tryQueueDm(job: {
  chatId: string;
  text: string;
  buttons?: { text: string; cb: string }[][];
}): Promise<boolean> {
  try {
    await getNotificationQueue().add("dm", {
      chatId: job.chatId,
      text: job.text,
      buttons: job.buttons,
    });
    return true;
  } catch (e) {
    logger.warn("notify_queue_failed", { err: String(e) });
    return false;
  }
}

/** Queue first; if Redis/BullMQ fails, send immediately so payment alerts are not lost. */
export async function notifyDealParticipantCritical(params: {
  targetTelegramId: bigint;
  text: string;
  buttons?: { text: string; cb: string }[][];
}): Promise<void> {
  const ok = await tryQueueDm({
    chatId: params.targetTelegramId.toString(),
    text: params.text,
    buttons: params.buttons,
  });
  if (ok) return;
  try {
    await sendDmDirect({
      chatId: params.targetTelegramId.toString(),
      text: params.text,
      buttons: params.buttons,
    });
  } catch (e2) {
    logger.error("notify_direct_failed", { err: String(e2) });
  }
}

export async function notifyDmWithButtonsCritical(params: {
  chatId: string;
  text: string;
  buttons: { text: string; cb: string }[][];
}): Promise<void> {
  const ok = await tryQueueDm(params);
  if (ok) return;
  try {
    await sendDmDirect(params);
  } catch (e2) {
    logger.error("dm_buttons_direct_failed", { err: String(e2) });
  }
}
