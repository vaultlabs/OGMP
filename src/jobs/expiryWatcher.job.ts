import { prisma } from "../db/prisma.js";
import { assertValidDealTransition } from "../services/escrow-state-machine.js";
import { writeAuditLog } from "../services/audit.service.js";
import { logger } from "../utils/logger.js";
import { appendDealTimelineEvent } from "../modules/dealTimeline/timeline.service.js";
import { enqueueDealParticipantNotify } from "../modules/notifications/notificationQueue.service.js";

const REMIND_PAY_MINUTES = 30;

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
      await appendDealTimelineEvent({
        dealId: deal.id,
        actorId: null,
        eventType: "deal_closed",
        metadata: { reason: "payment_window_expired" },
      });
    } catch (e) {
      logger.error("expiry_watcher_failed", { dealId: deal.id, err: String(e) });
    }
  }

  const joinExpired = await prisma.deal.findMany({
    where: {
      status: "pending_acceptance",
      joinExpiresAt: { lt: now },
    },
    take: 40,
  });
  for (const deal of joinExpired) {
    try {
      assertValidDealTransition(deal.status, "cancelled");
      await prisma.deal.update({
        where: { id: deal.id, version: deal.version },
        data: { status: "cancelled", cancelledAt: now, version: { increment: 1 } },
      });
      await writeAuditLog({ eventType: "join_window_expired", dealId: deal.id });
      await appendDealTimelineEvent({
        dealId: deal.id,
        actorId: null,
        eventType: "deal_closed",
        metadata: { reason: "join_window_expired" },
      });
    } catch (e) {
      logger.error("join_expiry_failed", { dealId: deal.id, err: String(e) });
    }
  }

  const termsExpired = await prisma.deal.findMany({
    where: {
      status: "pending_acceptance",
      termsExpiresAt: { lt: now },
    },
    take: 40,
  });
  for (const deal of termsExpired) {
    try {
      assertValidDealTransition(deal.status, "cancelled");
      await prisma.deal.update({
        where: { id: deal.id, version: deal.version },
        data: { status: "cancelled", cancelledAt: now, version: { increment: 1 } },
      });
      await writeAuditLog({ eventType: "terms_window_expired", dealId: deal.id });
      await appendDealTimelineEvent({
        dealId: deal.id,
        actorId: null,
        eventType: "deal_closed",
        metadata: { reason: "terms_window_expired" },
      });
    } catch (e) {
      logger.error("terms_expiry_failed", { dealId: deal.id, err: String(e) });
    }
  }

  const unpaid = await prisma.deal.findMany({
    where: {
      status: { in: ["waiting_payment", "payment_detected"] },
      buyerId: { not: null },
      buyerPayRemindedAt: null,
    },
    include: { buyer: true },
    take: 40,
  });
  for (const deal of unpaid) {
    if (!deal.buyer) continue;
    const ageMin = (now.getTime() - deal.lastActivityAt.getTime()) / 60_000;
    if (ageMin < REMIND_PAY_MINUTES) continue;
    try {
      await prisma.deal.update({
        where: { id: deal.id },
        data: { buyerPayRemindedAt: now },
      });
      await enqueueDealParticipantNotify({
        targetTelegramId: deal.buyer.telegramId,
        text: [
          "OGMP MM — Payment reminder",
          "",
          `Deal ${deal.dealCode}: payment is still open.`,
          "If you intend to proceed, complete payment soon (check the deal card).",
        ].join("\n"),
        buttons: [[{ text: "View deal", cb: `d:v:${deal.dealCode}` }]],
      });
    } catch (e) {
      logger.error("buyer_pay_reminder_failed", { dealId: deal.id, err: String(e) });
    }
  }

  const needUpload = await prisma.deal.findMany({
    where: { status: "waiting_payment", sellerId: { not: null }, sellerUploadRemindedAt: null },
    include: { seller: true },
    take: 30,
  });
  for (const deal of needUpload) {
    if (!deal.seller) continue;
    const locked = deal.sellerId
      ? await prisma.dealMessage.count({
          where: { dealId: deal.id, lockedForBuyer: true, senderId: deal.sellerId },
        })
      : 0;
    if (locked > 0 || deal.sellerUploadRemindedAt) continue;
    const ageMin = (now.getTime() - deal.lastActivityAt.getTime()) / 60_000;
    if (ageMin < 45) continue;
    try {
      await prisma.deal.update({ where: { id: deal.id }, data: { sellerUploadRemindedAt: now } });
      await enqueueDealParticipantNotify({
        targetTelegramId: deal.seller.telegramId,
        text: [
          "OGMP MM — Delivery reminder",
          "",
          `Deal ${deal.dealCode}: buyer is waiting for a locked Delivery Vault upload.`,
          "Use Deal room → upload → Submit Delivery.",
        ].join("\n"),
        buttons: [[{ text: "View deal", cb: `d:v:${deal.dealCode}` }]],
      });
    } catch (e) {
      logger.error("seller_upload_reminder_failed", { dealId: deal.id, err: String(e) });
    }
  }
}
