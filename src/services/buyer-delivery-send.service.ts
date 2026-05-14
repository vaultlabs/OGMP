import { Api, InlineKeyboard } from "grammy";
import { getMainBotToken } from "../config/index.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { listDeliveryAssetMessagesForDeal } from "../modules/dealMessages/dealMessage.service.js";
import { buyerReviewFollowupText, buyerReviewKeyboard } from "./delivery.service.js";

export async function sendBuyerDeliveryBundleToChat(params: {
  buyerTelegramId: bigint | string;
  dealId: string;
}): Promise<{ sent: number; skipped: boolean }> {
  const chatId =
    typeof params.buyerTelegramId === "bigint"
      ? params.buyerTelegramId.toString()
      : params.buyerTelegramId;
  const deal = await prisma.deal.findUnique({ where: { id: params.dealId } });
  if (!deal) return { sent: 0, skipped: true };
  if (deal.deliveryFilesBundleSentAt) return { sent: 0, skipped: true };
  if (!deal.fundedAt) return { sent: 0, skipped: true };
  if (deal.status !== "funded" && deal.status !== "item_delivered") {
    return { sent: 0, skipped: true };
  }

  const msgs = await listDeliveryAssetMessagesForDeal(deal.id);
  const withFiles = msgs.filter((m) => m.telegramFileId);
  if (!withFiles.length) {
    const api = new Api(getMainBotToken());
    await api.sendMessage(chatId, "No delivery files are on file for this deal yet.");
    return { sent: 0, skipped: false };
  }

  const api = new Api(getMainBotToken());
  const total = withFiles.length;
  let sent = 0;
  for (let i = 0; i < withFiles.length; i++) {
    const m = withFiles[i]!;
    const fi = m.telegramFileId!;
    const idx = i + 1;
    const cap = `OGMP MM Delivery File ${idx}/${total}\nDeal: ${deal.dealCode}\nFile: ${m.fileName ?? m.messageType}`;
    try {
      switch (m.messageType) {
        case "photo":
          await api.sendPhoto(chatId, fi, { caption: cap });
          break;
        case "video":
          await api.sendVideo(chatId, fi, { caption: cap });
          break;
        case "animation":
          await api.sendAnimation(chatId, fi, { caption: cap });
          break;
        case "voice":
          await api.sendVoice(chatId, fi, { caption: cap });
          break;
        case "audio":
          await api.sendAudio(chatId, fi, { caption: cap });
          break;
        case "document":
        case "text":
        case "other":
        default:
          await api.sendDocument(chatId, fi, { caption: cap });
          break;
      }
      sent++;
    } catch (e) {
      logger.error("buyer_delivery_send_one_failed", { dealId: deal.id, err: String(e) });
    }
  }

  const kbRows = buyerReviewKeyboard(deal.dealCode);
  const kb = new InlineKeyboard();
  for (const row of kbRows) {
    for (const b of row) kb.text(b.text, b.cb);
    kb.row();
  }
  await api.sendMessage(chatId, buyerReviewFollowupText(deal.dealCode), {
    reply_markup: kb,
  });

  await prisma.deal.update({
    where: { id: deal.id },
    data: { deliveryFilesBundleSentAt: new Date() },
  });
  return { sent, skipped: false };
}
