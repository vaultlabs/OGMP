import { prisma } from "../../db/prisma.js";
import { applyPaymentSyncForDeal } from "./payment.service.js";
import {
  paymentConfirmedUnlockingText,
  paymentDetectedWaitingText,
  paymentNotDetectedBuyerText,
} from "../../services/delivery.service.js";
import { escapeTelegramHtml } from "../../utils/telegram-html.js";

function plainLinesHtml(lines: string[]): string {
  return lines.map((l) => escapeTelegramHtml(l)).join("\n");
}

export async function runBuyerPaymentCheck(dealId: string, requesterTelegramId: bigint): Promise<string> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true },
  });
  if (!deal?.buyer || deal.buyer.telegramId !== requesterTelegramId) {
    return plainLinesHtml(["Only the buyer can check payment for this deal."]);
  }
  if (!deal.sellerId) {
    return plainLinesHtml(["This deal is missing a seller."]);
  }
  if (deal.status === "waiting_payment" || deal.status === "payment_detected") {
    const locked = await prisma.dealMessage.count({
      where: { dealId, lockedForBuyer: true, senderId: deal.sellerId },
    });
    if (locked === 0) {
      return plainLinesHtml([
        "What: payment not open yet.",
        "Safe: nothing leaves escrow.",
        "Next: the seller locks the Delivery Vault first — you will get a Payment Required DM.",
      ]);
    }
  }
  await applyPaymentSyncForDeal(dealId);
  const refreshed = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true },
  });
  const pay = await prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } });
  if (!refreshed || !pay) return plainLinesHtml(["No payment record for this deal."]);

  if (refreshed.status === "funded" || refreshed.status === "item_delivered") {
    return paymentConfirmedUnlockingText();
  }
  if (pay.status === "confirming" || pay.status === "detecting") {
    return paymentDetectedWaitingText();
  }
  if (pay.status === "confirmed" && refreshed.status === "payment_detected") {
    return paymentDetectedWaitingText();
  }
  return paymentNotDetectedBuyerText();
}
