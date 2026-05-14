import { prisma } from "../../db/prisma.js";
import { applyPaymentSyncForDeal } from "./payment.service.js";
import {
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
  await applyPaymentSyncForDeal(dealId);
  const refreshed = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true },
  });
  const pay = await prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } });
  if (!refreshed || !pay) return "No payment record for this deal.";

  if (refreshed.status === "funded" || refreshed.status === "item_delivered") {
    return "Payment confirmed. Your delivery is unlocked — open the latest OGMP MM message or tap View Deal.";
  }
  if (pay.status === "confirming" || pay.status === "detecting") {
    return paymentDetectedWaitingText();
  }
  if (pay.status === "confirmed" && refreshed.status === "payment_detected") {
    return paymentDetectedWaitingText();
  }
  return paymentNotDetectedBuyerText();
}
