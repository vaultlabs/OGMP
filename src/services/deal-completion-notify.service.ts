import { randomUUID } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { COMMUNITY_TRUST_LINE, TRUST_OPS_FOOTER } from "../bots/mainBot/trust-copy.js";
import { enqueueDealParticipantNotify } from "../modules/notifications/notificationQueue.service.js";
import { logger } from "../utils/logger.js";
import {
  formatCryptoAmount,
  previewSellerPayoutAmount,
  resolveBuyerPayAmount,
  resolveDealPaymentAmounts,
} from "./fee.service.js";
import type { FeePayer } from "@prisma/client";
import { Prisma } from "@prisma/client";

export function formatReceiptPlain(deal: {
  dealCode: string;
  buyer: { firstName: string | null; username: string | null } | null;
  seller: { firstName: string | null; username: string | null } | null;
  amount: Prisma.Decimal;
  currency: string;
  network: string;
  feeAmount: Prisma.Decimal;
  feePayer: FeePayer;
  networkFeeEstimate: Prisma.Decimal;
  status: string;
  releasedAt: Date | null;
  txHash: string | null;
}, opts?: {
  buyerPaid?: Prisma.Decimal;
  sellerReceived?: Prisma.Decimal;
}): string {
  const b =
    deal.buyer?.username != null && deal.buyer.username !== ""
      ? `@${deal.buyer.username}`
      : deal.buyer?.firstName ?? "Buyer";
  const s =
    deal.seller?.username != null && deal.seller.username !== ""
      ? `@${deal.seller.username}`
      : deal.seller?.firstName ?? "Seller";
  const amounts = resolveDealPaymentAmounts(deal);
  const buyerPaid = opts?.buyerPaid ?? amounts.buyerPays;
  const sellerReceived = opts?.sellerReceived ?? amounts.sellerReceives;
  return [
    "━━━━━━━━━━━━━━━━━━",
    "OGMP MM — Deal Receipt",
    "━━━━━━━━━━━━━━━━━━",
    "",
    `Deal ID: ${deal.dealCode}`,
    `Buyer: ${b}`,
    `Seller: ${s}`,
    `Deal price: ${formatCryptoAmount(amounts.dealAmount)} ${deal.currency}`,
    `Escrow fee: ${formatCryptoAmount(amounts.escrowFee)} ${deal.currency} (${amounts.feePayer})`,
    `Buyer paid: ${formatCryptoAmount(buyerPaid)} ${deal.currency}`,
    `Seller received: ${formatCryptoAmount(sellerReceived)} ${deal.currency}`,
    `Network: ${deal.network}`,
    `Status: ${deal.status === "released" ? "Completed" : deal.status}`,
    `Completed at: ${deal.releasedAt?.toISOString().slice(0, 19) ?? "—"}Z`,
    `Transaction hash: ${deal.txHash ?? "—"}`,
    "",
    "Thank you for using OGMP MM.",
    "",
    COMMUNITY_TRUST_LINE,
    "",
    TRUST_OPS_FOOTER,
  ].join("\n");
}

export function rateButtons(dealCode: string, targetSlot: "B" | "S"): { text: string; cb: string }[][] {
  return [
    [1, 2, 3, 4, 5].map((n) => ({ text: `${n}★`, cb: `rstar:${dealCode}:${targetSlot}:${n}` })),
    [{ text: "Back to menu", cb: "m:menu" }],
  ];
}

/** After a deal reaches `released`, persist receipt and nudge both parties to rate. Idempotent. */
export async function onDealReleasedSideEffects(dealId: string): Promise<void> {
  try {
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      include: { buyer: true, seller: true },
    });
    if (!deal || deal.status !== "released" || !deal.buyerId || !deal.sellerId || !deal.buyer || !deal.seller) {
      return;
    }

    const [payment, payout] = await Promise.all([
      prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } }),
      prisma.payout.findFirst({ where: { dealId, status: { not: "failed" } }, orderBy: { createdAt: "desc" } }),
    ]);
    const sellerPreview = previewSellerPayoutAmount(deal, payment);
    const receiptBody = formatReceiptPlain(deal, {
      buyerPaid: payment ? resolveBuyerPayAmount(deal, payment) : undefined,
      sellerReceived: payout?.amount ?? sellerPreview.payout,
    });
    const payload = {
      dealCode: deal.dealCode,
      buyerId: deal.buyerId,
      sellerId: deal.sellerId,
      amount: deal.amount.toString(),
      currency: deal.currency,
      network: deal.network,
      fee: deal.feeAmount.toString(),
      releasedAt: deal.releasedAt?.toISOString() ?? null,
      txHash: deal.txHash,
    };

    await prisma.dealReceipt.upsert({
      where: { dealId },
      create: { id: randomUUID(), dealId, payload },
      update: { payload },
    });

    const [buyerReview, sellerReview] = await Promise.all([
      prisma.review.findUnique({
        where: { dealId_fromUserId: { dealId, fromUserId: deal.buyerId } },
      }),
      prisma.review.findUnique({
        where: { dealId_fromUserId: { dealId, fromUserId: deal.sellerId } },
      }),
    ]);

    await enqueueDealParticipantNotify({
      targetTelegramId: deal.buyer.telegramId,
      text: receiptBody,
      buttons: [
        [{ text: "Download receipt", cb: `rcpt:${deal.dealCode}` }],
        [{ text: "Rate user", cb: `ropen:${deal.dealCode}` }],
        [{ text: "Back to menu", cb: "m:menu" }],
      ],
    });
    await enqueueDealParticipantNotify({
      targetTelegramId: deal.seller.telegramId,
      text: receiptBody,
      buttons: [
        [{ text: "Download receipt", cb: `rcpt:${deal.dealCode}` }],
        [{ text: "Rate user", cb: `ropen:${deal.dealCode}` }],
        [{ text: "Back to menu", cb: "m:menu" }],
      ],
    });

    if (!buyerReview) {
      await enqueueDealParticipantNotify({
        targetTelegramId: deal.buyer.telegramId,
        text: [
          "━━━━━━━━━━━━━━━━━━",
          "Rate this deal",
          "━━━━━━━━━━━━━━━━━━",
          "",
          "What: rate the seller (optional text after).",
          "Safe: deal is already completed.",
          "Next: tap 1–5 stars.",
          "",
          TRUST_OPS_FOOTER,
        ].join("\n"),
        buttons: rateButtons(deal.dealCode, "S"),
      });
    }

    if (!sellerReview) {
      await enqueueDealParticipantNotify({
        targetTelegramId: deal.seller.telegramId,
        text: [
          "━━━━━━━━━━━━━━━━━━",
          "Rate this deal",
          "━━━━━━━━━━━━━━━━━━",
          "",
          "What: rate the buyer (optional text after).",
          "Safe: deal is already completed.",
          "Next: tap 1–5 stars.",
          "",
          TRUST_OPS_FOOTER,
        ].join("\n"),
        buttons: rateButtons(deal.dealCode, "B"),
      });
    }
  } catch (e) {
    logger.error("deal_released_side_effects_failed", { dealId, err: String(e) });
  }
}
