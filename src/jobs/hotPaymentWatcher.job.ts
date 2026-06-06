import { applyPaymentSyncForDeal, isPaymentSyncRaceError } from "../modules/payments/payment.service.js";
import {
  listHotPaymentDealIds,
  unmarkDealHotPaymentPoll,
} from "../modules/payments/hot-payment-poll.service.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";

/** Fast poll (5s) for deals with open invoices — complements 10s global watcher. */
export async function runHotPaymentWatcherOnce(): Promise<void> {
  const hotIds = await listHotPaymentDealIds();
  if (!hotIds.length) return;

  for (const dealId of hotIds) {
    try {
      const deal = await prisma.deal.findUnique({
        where: { id: dealId },
        select: { status: true },
      });
      if (
        !deal ||
        (deal.status !== "waiting_payment" && deal.status !== "payment_detected")
      ) {
        await unmarkDealHotPaymentPoll(dealId);
        continue;
      }
      await applyPaymentSyncForDeal(dealId);
    } catch (e) {
      if (isPaymentSyncRaceError(e)) {
        logger.warn("hot_payment_watcher_deal_race", { dealId });
        continue;
      }
      logger.error("hot_payment_watcher_deal_failed", { dealId, err: String(e) });
    }
  }
}
