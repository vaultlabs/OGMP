import { prisma } from "../../db/prisma.js";
import { applyPaymentSyncForDeal, isPaymentSyncRaceError } from "./payment.service.js";
import {
  paymentConfirmedUnlockingText,
  paymentDetectedWaitingText,
  paymentNotDetectedBuyerText,
} from "../../services/delivery.service.js";
import { mockProviderPaymentWarning } from "./payment-notify.service.js";
import { loadConfig } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import { markDealHotPaymentPoll } from "./hot-payment-poll.service.js";

export async function runBuyerPaymentCheck(dealId: string, requesterTelegramId: bigint): Promise<string> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true },
  });
  if (!deal?.buyer || deal.buyer.telegramId !== requesterTelegramId) {
    return "Only the buyer can check payment for this deal. In OGMP MM the buyer pays escrow — the seller uploads delivery.";
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
  await markDealHotPaymentPoll(dealId);
  try {
    await applyPaymentSyncForDeal(dealId);
  } catch (e) {
    if (isPaymentSyncRaceError(e)) {
      logger.warn("buyer_payment_check_race", { dealId });
    } else {
      logger.error("buyer_payment_check_sync_failed", { dealId, err: String(e) });
      const provider = loadConfig().PAYMENT_PROVIDER;
      return [
        "What: could not reach the payment processor right now.",
        "Safe: nothing was released.",
        `Next: wait 1–2 minutes and tap Check Payment again. (Provider: ${provider})`,
        "",
        "If this keeps happening, check PUBLIC_BASE_URL / NOWPayments API keys and that the bot process is online.",
      ].join("\n");
    }
  }
  const refreshed = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true },
  });
  const pay = await prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } });
  if (!refreshed || !pay) return "No payment record for this deal.";

  const mockWarn = mockProviderPaymentWarning();

  if (refreshed.status === "funded" || refreshed.status === "item_delivered") {
    return paymentConfirmedUnlockingText() + (mockWarn ?? "");
  }
  if (pay.status === "underpaid" || pay.status === "overpaid") {
    const received = pay.receivedAmount?.toString() ?? "0";
    return [
      `What: payment ${pay.status}.`,
      `Received so far: ${received} ${refreshed.currency} · Expected: ${pay.expectedAmount.toString()} on ${refreshed.network}`,
      "Safe: vault stays locked until the full amount is confirmed.",
      "Next: send the remainder to the same in-bot address, or contact Support with your deal code.",
      mockWarn ?? "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (pay.status === "confirming" || pay.status === "detecting") {
    return paymentDetectedWaitingText() + (mockWarn ?? "");
  }
  if (pay.status === "confirmed" && refreshed.status === "payment_detected") {
    return paymentDetectedWaitingText() + (mockWarn ?? "");
  }

  const addr = refreshed.paymentAddress ?? pay.address ?? "";
  const tail = addr.length > 8 ? addr.slice(-8) : addr || "—";
  return (
    paymentNotDetectedBuyerText({
      dealCode: refreshed.dealCode,
      expected: pay.expectedAmount.toString(),
      currency: refreshed.currency,
      network: refreshed.network,
      addressTail: tail,
      provider: pay.provider,
    }) + (mockWarn ?? "")
  );
}
