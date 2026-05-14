import { prisma } from "../db/prisma.js";
import { applyPaymentSyncForDeal } from "../modules/payments/payment.service.js";
import { logger } from "../utils/logger.js";
import { touchLastPaymentWatch } from "../services/platform-settings.service.js";

export async function runPaymentWatcherOnce(): Promise<void> {
  const deals = await prisma.deal.findMany({
    where: { status: { in: ["waiting_payment", "payment_detected"] } },
    select: { id: true },
    take: 50,
  });
  for (const d of deals) {
    try {
      await applyPaymentSyncForDeal(d.id);
    } catch (e) {
      logger.error("payment_watcher_deal_failed", { dealId: d.id, err: String(e) });
    }
  }
  await touchLastPaymentWatch();
}
