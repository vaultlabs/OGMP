import { Prisma } from "@prisma/client";
import { loadConfig } from "../config/index.js";
import { prisma } from "../db/prisma.js";
import { getPaymentProvider } from "../payments/index.js";
import { appendDealTimelineEvent } from "../modules/dealTimeline/timeline.service.js";
import { enqueueDealParticipantNotify } from "../modules/notifications/notificationQueue.service.js";
import { notifyDealParticipantCritical } from "../modules/notifications/critical-notify.service.js";
import { acquireLock, releaseLock } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import { formatCryptoAmount, resolveDealPaymentAmounts } from "./fee.service.js";
import { randomBytes } from "node:crypto";

import { formatPayoutAmount } from "../payments/payout-amount.js";
import { isPayoutVerifyConfigured } from "../payments/nowpayments-payout-verify.js";

const DIV = "━━━━━━━━━━━━━━━━━━";

export { formatPayoutAmount };

export function isAutoPayoutConfigured(): boolean {
  const cfg = loadConfig();
  if (cfg.PAYMENT_PROVIDER === "mock") return true;
  if (cfg.PAYMENT_PROVIDER !== "nowpayments") return false;
  return Boolean(
    cfg.NOWPAYMENTS_EMAIL?.trim() &&
      cfg.NOWPAYMENTS_PASSWORD?.trim() &&
      isPayoutVerifyConfigured(),
  );
}

export async function executeDealPayoutAfterRelease(dealId: string): Promise<void> {
  const lockKey = `lock:deal:${dealId}:payout`;
  const token = randomBytes(8).toString("hex");
  if (!(await acquireLock(lockKey, 120_000, token))) {
    logger.warn("payout_lock_busy", { dealId });
    return;
  }
  try {
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      include: { seller: true, payouts: { orderBy: { createdAt: "desc" } } },
    });
    if (!deal || deal.status !== "released") return;
    if (!deal.sellerPayoutAddress?.trim() || !deal.sellerPayoutConfirmedAt) {
      logger.warn("payout_skipped_no_seller_wallet", { dealId, dealCode: deal.dealCode });
      return;
    }

    const amounts = resolveDealPaymentAmounts(deal);
    let payoutRow = deal.payouts.find((p) => p.status !== "failed") ?? null;

    if (payoutRow?.status === "completed") return;
    if (payoutRow?.status === "processing" && payoutRow.providerRef) return;

    if (!payoutRow) {
      payoutRow = await prisma.payout.create({
        data: {
          dealId,
          amount: amounts.sellerReceives,
          feeDeducted: amounts.dealAmount.sub(amounts.sellerReceives),
          currency: deal.currency,
          network: deal.network,
          toAddress: deal.sellerPayoutAddress.trim(),
          status: "pending",
          providerRef: null,
        },
      });
    }

    const provider = getPaymentProvider();
    if (provider.name === "nowpayments" && !isAutoPayoutConfigured()) {
      await notifySellerPayoutQueued(deal.dealCode, deal.sellerPayoutAddress, amounts.sellerReceives, deal.currency);
      return;
    }

    try {
      const result = await provider.createPayout(payoutRow, deal.sellerPayoutAddress.trim());
      const nextStatus = result.status === "completed" ? "completed" : "processing";
      await prisma.payout.update({
        where: { id: payoutRow.id },
        data: {
          status: nextStatus,
          providerRef: result.payoutId,
          txHash: result.txHash ?? payoutRow.txHash,
        },
      });
      await appendDealTimelineEvent({
        dealId,
        actorId: null,
        eventType: "payout_submitted",
        metadata: { provider: provider.name, payoutId: result.payoutId, status: nextStatus },
      });
      if (deal.sellerId) {
        await notifySellerPayoutSubmitted(
          {
            dealCode: deal.dealCode,
            sellerPayoutAddress: deal.sellerPayoutAddress,
            sellerId: deal.sellerId,
          },
          amounts.sellerReceives,
          result.status,
        );
      }
    } catch (e) {
      const err = String(e);
      logger.error("deal_payout_execute_failed", { dealId, err });
      await prisma.payout.update({
        where: { id: payoutRow.id },
        data: { status: "failed", adminNote: err.slice(0, 500) },
      });
      if (deal.seller) {
        await enqueueDealParticipantNotify({
          targetTelegramId: deal.seller.telegramId,
          text: [
            DIV,
            "OGMP MM — Payout needs attention",
            DIV,
            "",
            `Deal: ${deal.dealCode}`,
            "",
            "What: automatic payout to your wallet failed.",
            "Safe: deal is marked released — support will complete payout manually.",
            "Next: contact /support with your deal code if you do not receive funds within 24h.",
          ].join("\n"),
          buttons: [[{ text: "View deal", cb: `d:v:${deal.dealCode}` }]],
        });
      }
    }
  } finally {
    await releaseLock(lockKey, token);
  }
}

async function notifySellerPayoutQueued(
  dealCode: string,
  address: string,
  amount: Prisma.Decimal,
  currency: string,
): Promise<void> {
  const deal = await prisma.deal.findUnique({
    where: { dealCode },
    include: { seller: true },
  });
  if (!deal?.seller) return;
  await enqueueDealParticipantNotify({
    targetTelegramId: deal.seller.telegramId,
    text: [
      DIV,
      "OGMP MM — Payout queued",
      DIV,
      "",
      `Deal: ${dealCode}`,
      `Amount: ${formatCryptoAmount(amount)} ${currency}`,
      `Wallet: ${maskPayoutAddress(address)}`,
      "",
      "What: funds are released in OGMP — crypto payout is queued for admin/NOWPayments setup.",
      "Next: you will get another message when the transfer is sent.",
    ].join("\n"),
    buttons: [[{ text: "View deal", cb: `d:v:${dealCode}` }]],
  });
}

async function notifySellerPayoutSubmitted(
  deal: { dealCode: string; sellerPayoutAddress: string | null; sellerId: string | null },
  amount: Prisma.Decimal,
  providerStatus: string,
): Promise<void> {
  if (!deal.sellerId) return;
  const seller = await prisma.user.findUnique({ where: { id: deal.sellerId } });
  if (!seller) return;
  const addr = deal.sellerPayoutAddress ?? "";
  const done = providerStatus === "completed";
  await notifyDealParticipantCritical({
    targetTelegramId: seller.telegramId,
    text: [
      DIV,
      done ? "OGMP MM — Payout sent" : "OGMP MM — Payout processing",
      DIV,
      "",
      `Deal: ${deal.dealCode}`,
      `Amount: ${formatCryptoAmount(amount)}`,
      `Wallet: ${maskPayoutAddress(addr)}`,
      "",
      done
        ? "What: crypto was sent to your wallet."
        : "What: payout was submitted to NOWPayments — watch your wallet.",
      "Safe: deal is complete.",
      "Next: check your wallet; open /support only if nothing arrives after network confirmations.",
    ].join("\n"),
    buttons: [[{ text: "View deal", cb: `d:v:${deal.dealCode}` }]],
  });
}

export function maskPayoutAddress(address: string): string {
  const a = address.trim();
  if (a.length <= 14) return a;
  return `${a.slice(0, 8)}…${a.slice(-6)}`;
}

/** Update payout row from admin or NOWPayments IPN. */
export async function markPayoutCompleted(params: {
  payoutId: string;
  txHash?: string;
  adminNote?: string;
}): Promise<void> {
  const before = await prisma.payout.findUnique({
    where: { id: params.payoutId },
    include: { deal: { include: { seller: true } } },
  });
  if (!before) return;

  const payout = await prisma.payout.update({
    where: { id: params.payoutId },
    data: {
      status: "completed",
      txHash: params.txHash ?? before.txHash ?? undefined,
      adminNote: params.adminNote ?? before.adminNote ?? undefined,
      sellerNotifiedSentAt: new Date(),
    },
    include: { deal: { include: { seller: true } } },
  });

  if (payout.deal.seller && !before.sellerNotifiedSentAt) {
    await notifyDealParticipantCritical({
      targetTelegramId: payout.deal.seller.telegramId,
      text: [
        DIV,
        "OGMP MM — Payout confirmed",
        DIV,
        "",
        `Deal: ${payout.deal.dealCode}`,
        params.txHash ? `Tx: ${params.txHash}` : "Tx: (see NOWPayments dashboard)",
        "",
        "What: payout marked complete.",
      ].join("\n"),
      buttons: [[{ text: "View deal", cb: `d:v:${payout.deal.dealCode}` }]],
    });
  }
}

/** NOWPayments payout IPN (same HMAC as payments). */
export async function processPayoutIpn(payload: Record<string, unknown>): Promise<void> {
  const payoutId =
    (typeof payload.id === "string" && payload.id) ||
    (typeof payload.id === "number" && String(payload.id)) ||
    (typeof payload.payout_id === "string" && payload.payout_id);
  const status = typeof payload.status === "string" ? payload.status.toUpperCase() : "";
  const hash = typeof payload.hash === "string" ? payload.hash : undefined;
  const externalId = typeof payload.unique_external_id === "string" ? payload.unique_external_id : undefined;

  let row = externalId
    ? await prisma.payout.findUnique({ where: { id: externalId } })
    : null;
  if (!row && payoutId) {
    row = await prisma.payout.findFirst({ where: { providerRef: payoutId } });
  }
  if (!row) {
    logger.warn("payout_ipn_unknown", { payoutId, externalId, status });
    return;
  }

  if (status === "FINISHED") {
    await markPayoutCompleted({ payoutId: row.id, txHash: hash });
  } else if (status === "FAILED" || status === "REJECTED") {
    await prisma.payout.update({
      where: { id: row.id },
      data: { status: "failed", adminNote: typeof payload.error === "string" ? payload.error : status },
    });
  } else if (status === "PROCESSING" || status === "WAITING" || status === "SENDING") {
    await prisma.payout.update({
      where: { id: row.id },
      data: { status: "processing", txHash: hash ?? undefined },
    });
  }
}
