import { randomUUID } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { COMMUNITY_TRUST_LINE, RULER_HTML, TRUST_OPS_FOOTER } from "../bots/mainBot/trust-copy.js";
import { enqueueDealParticipantNotify } from "../modules/notifications/notificationQueue.service.js";
import { logger } from "../utils/logger.js";
import { escapeTelegramHtml } from "../utils/telegram-html.js";

export function formatReceiptHtml(deal: {
  dealCode: string;
  buyer: { firstName: string | null; username: string | null } | null;
  seller: { firstName: string | null; username: string | null } | null;
  amount: { toString(): string };
  currency: string;
  network: string;
  feeAmount: { toString(): string };
  status: string;
  releasedAt: Date | null;
  txHash: string | null;
}): string {
  const b =
    deal.buyer?.username != null && deal.buyer.username !== ""
      ? `@${escapeTelegramHtml(deal.buyer.username)}`
      : escapeTelegramHtml(deal.buyer?.firstName ?? "Buyer");
  const s =
    deal.seller?.username != null && deal.seller.username !== ""
      ? `@${escapeTelegramHtml(deal.seller.username)}`
      : escapeTelegramHtml(deal.seller?.firstName ?? "Seller");
  const statusLabel = deal.status === "released" ? "Completed" : deal.status.replace(/_/g, " ");
  const completed = deal.releasedAt?.toISOString().slice(0, 19) ?? "—";
  const tx = deal.txHash ?? "—";
  return [
    `<b>OGMP MM</b> · <i>Deal receipt</i>`,
    RULER_HTML,
    "",
    `<b>Deal ID</b> <code>${escapeTelegramHtml(deal.dealCode)}</code>`,
    `<b>Buyer</b> ${b}`,
    `<b>Seller</b> ${s}`,
    `<b>Amount</b> ${escapeTelegramHtml(deal.amount.toString())} ${escapeTelegramHtml(deal.currency)}`,
    `<b>Network</b> ${escapeTelegramHtml(deal.network)}`,
    `<b>Fee</b> ${escapeTelegramHtml(deal.feeAmount.toString())}`,
    `<b>Status</b> ${escapeTelegramHtml(statusLabel)}`,
    `<b>Completed at</b> ${escapeTelegramHtml(completed)}Z`,
    `<b>Transaction hash</b> <code>${escapeTelegramHtml(tx)}</code>`,
    "",
    "<b>Thank you</b> for using OGMP MM.",
    "",
    `<i>${escapeTelegramHtml(COMMUNITY_TRUST_LINE)}</i>`,
    "",
    `<i>${escapeTelegramHtml(TRUST_OPS_FOOTER)}</i>`,
  ].join("\n");
}

function rateNudgeHtml(subject: "seller" | "buyer"): string {
  const what =
    subject === "seller"
      ? "Rate the seller (optional text after you pick stars)."
      : "Rate the buyer (optional text after you pick stars).";
  return [
    `<b>OGMP MM</b> · <i>Rate this deal</i>`,
    RULER_HTML,
    "",
    `<b>What</b> ${escapeTelegramHtml(what)}`,
    "<b>Safe</b> Deal is already completed.",
    "<b>Next</b> Tap 1–5 stars.",
    "",
    `<i>${escapeTelegramHtml(TRUST_OPS_FOOTER)}</i>`,
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

    const receiptBody = formatReceiptHtml(deal);
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
      parseMode: "HTML",
      buttons: [
        [{ text: "Download receipt", cb: `rcpt:${deal.dealCode}` }],
        [{ text: "Rate user", cb: `ropen:${deal.dealCode}` }],
        [{ text: "Back to menu", cb: "m:menu" }],
      ],
    });
    await enqueueDealParticipantNotify({
      targetTelegramId: deal.seller.telegramId,
      text: receiptBody,
      parseMode: "HTML",
      buttons: [
        [{ text: "Download receipt", cb: `rcpt:${deal.dealCode}` }],
        [{ text: "Rate user", cb: `ropen:${deal.dealCode}` }],
        [{ text: "Back to menu", cb: "m:menu" }],
      ],
    });

    if (!buyerReview) {
      await enqueueDealParticipantNotify({
        targetTelegramId: deal.buyer.telegramId,
        text: rateNudgeHtml("seller"),
        parseMode: "HTML",
        buttons: rateButtons(deal.dealCode, "S"),
      });
    }

    if (!sellerReview) {
      await enqueueDealParticipantNotify({
        targetTelegramId: deal.seller.telegramId,
        text: rateNudgeHtml("buyer"),
        parseMode: "HTML",
        buttons: rateButtons(deal.dealCode, "B"),
      });
    }
  } catch (e) {
    logger.error("deal_released_side_effects_failed", { dealId, err: String(e) });
  }
}
