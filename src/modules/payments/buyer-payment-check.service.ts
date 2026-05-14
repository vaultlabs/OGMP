import { prisma } from "../../db/prisma.js";
import { applyPaymentSyncForDeal } from "./payment.service.js";
import {
  paymentConfirmedUnlockingText,
  paymentDetectedWaitingText,
  paymentNotDetectedBuyerText,
} from "../../services/delivery.service.js";

export async function runBuyerPaymentCheck(dealId: string, requesterTelegramId: bigint): Promise<string> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true },
  });
  if (!deal?.buyer || deal.buyer.telegramId !== requesterTelegramId) {
    return "Only the buyer can check payment for this deal.";
  }
  if (!deal.sellerId) {
    return "This deal is missing a seller.";
  }
  if (deal.status === "waiting_payment" || deal.status === "payment_detected") {
    const locked = await prisma.dealMessage.count({
      where: { dealId, lockedForBuyer: true, senderId: deal.sellerId },
    });
    if (locked === 0) {
      return "What: payment not open yet.\nSafe: nothing leaves escrow.\nNext: seller locks the Delivery Vault first — you’ll get a Payment Required DM.";
    }
  }
  await applyPaymentSyncForDeal(dealId);
  const refreshed = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true },
  });
  const pay = await prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } });
  if (!refreshed || !pay) return "No payment record for this deal.";

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
