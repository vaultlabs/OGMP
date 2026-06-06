import { prisma } from "../db/prisma.js";
import { assertValidDealTransition } from "../services/escrow-state-machine.js";
import { writeAuditLog } from "../services/audit.service.js";
import { transitionDealStatus } from "../modules/deals/deal.service.js";
import { isPaymentSyncRaceError } from "../modules/payments/payment.service.js";
import { unmarkDealHotPaymentPoll } from "../modules/payments/hot-payment-poll.service.js";
import { logger } from "../utils/logger.js";

export async function runExpiryWatcherOnce(): Promise<void> {
  const now = new Date();
  const deals = await prisma.deal.findMany({
    where: {
      status: { in: ["waiting_payment", "payment_detected"] },
      paymentExpiresAt: { lt: now },
    },
    take: 50,
  });
  for (const deal of deals) {
    try {
      const fresh = await prisma.deal.findUnique({ where: { id: deal.id } });
      if (
        !fresh ||
        (fresh.status !== "waiting_payment" && fresh.status !== "payment_detected")
      ) {
        continue;
      }
      assertValidDealTransition(fresh.status, "cancelled");
      await transitionDealStatus(fresh.id, fresh.status, "cancelled", { cancelledAt: now });
      await writeAuditLog({ eventType: "payment_window_expired", dealId: fresh.id });
      await unmarkDealHotPaymentPoll(fresh.id);
    } catch (e) {
      if (isPaymentSyncRaceError(e)) {
        logger.warn("expiry_watcher_race", { dealId: deal.id });
        continue;
      }
      logger.error("expiry_watcher_failed", { dealId: deal.id, err: String(e) });
    }
  }
}
