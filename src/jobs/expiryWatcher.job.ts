import { prisma } from "../db/prisma.js";
import { assertValidDealTransition } from "../services/escrow-state-machine.js";
import { writeAuditLog } from "../services/audit.service.js";
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
      assertValidDealTransition(deal.status, "cancelled");
      await prisma.deal.update({
        where: { id: deal.id, version: deal.version },
        data: { status: "cancelled", cancelledAt: now, version: { increment: 1 } },
      });
      await writeAuditLog({ eventType: "payment_window_expired", dealId: deal.id });
    } catch (e) {
      logger.error("expiry_watcher_failed", { dealId: deal.id, err: String(e) });
    }
  }
}
