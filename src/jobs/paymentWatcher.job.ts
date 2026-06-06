import { prisma } from "../db/prisma.js";
import { applyPaymentSyncForDeal, isPaymentSyncRaceError } from "../modules/payments/payment.service.js";
import { logger } from "../utils/logger.js";

export async function runPaymentWatcherOnce(): Promise<void> {
  const deals = await prisma.deal.findMany({
    where: { status: { in: ["waiting_payment", "payment_detected"] } },
    select: { id: true },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  for (const d of deals) {
    try {
      await applyPaymentSyncForDeal(d.id);
    } catch (e) {
      if (isPaymentSyncRaceError(e)) {
        logger.warn("payment_watcher_deal_race", { dealId: d.id });
        continue;
      }
      logger.error("payment_watcher_deal_failed", { dealId: d.id, err: String(e) });
    }
  }
}
