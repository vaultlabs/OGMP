import { InlineKeyboard } from "grammy";
import type { DealMessage } from "@prisma/client";
import { loadConfig } from "../config/index.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { transitionDealStatus } from "../modules/deals/deal.service.js";
import { appendDealTimelineEvent } from "../modules/dealTimeline/timeline.service.js";
import { countLockedDeliveryMessages } from "../modules/dealMessages/dealMessage.service.js";
import {
  enqueueBuyerDeliverySend,
  enqueueDmWithButtons,
  enqueueDealParticipantNotify,
} from "../modules/notifications/notificationQueue.service.js";
import { userFacingDealStatus } from "../modules/deals/user-facing-status.js";

const DIV = "━━━━━━━━━━━━━━━━━━";

export function sellerFileSecuredText(dealCode: string, fileName: string): string {
  return [
    DIV,
    "OGMP MM — File Secured",
    DIV,
    "",
    `Deal: ${dealCode}`,
    "",
    "Your delivery file has been uploaded and locked.",
    "",
    "The buyer has been notified to complete payment.",
    "",
    "Once payment is confirmed, the file will unlock automatically.",
    "",
    `File: ${fileName}`,
  ].join("\n");
}

export function sellerFileSecuredKeyboard(dealCode: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Upload Another File", `dr:enter:${dealCode}`)
    .row()
    .text("Submit Delivery", `dl:sub:${dealCode}`)
    .text("View Deal", `d:v:${dealCode}`)
    .row()
    .text("Deal Room", `dr:enter:${dealCode}`);
}

export function buyerPaymentRequiredText(params: {
  dealCode: string;
  amount: string;
  currency: string;
  network: string;
  paymentAddress: string;
  expiresAt: Date | null;
  lockedFileName?: string;
  lockedFileCount?: number;
}): string {
  const exp = params.expiresAt
    ? params.expiresAt.toISOString().slice(0, 16).replace("T", " ") + " UTC"
    : "—";
  const lockLine =
    params.lockedFileCount && params.lockedFileCount > 1
      ? `The seller has uploaded ${params.lockedFileCount} delivery files (names only until you pay).`
      : params.lockedFileName
        ? `The seller has uploaded: ${params.lockedFileName}`
        : "The seller has uploaded the delivery.";
  return [
    DIV,
    "OGMP MM — Payment Required",
    DIV,
    "",
    `Deal: ${params.dealCode}`,
    `Status: Delivery Locked`,
    "",
    lockLine,
    "",
    "To unlock and download, send payment to the escrow address below.",
    "",
    `Amount: ${params.amount} ${params.currency}`,
    `Network: ${params.network}`,
    "",
    "Payment Address:",
    params.paymentAddress,
    "",
    `Expires: ${exp}`,
    "",
    "Important:",
    "Send only the selected crypto on the correct network.",
    "",
    "Use the exact amount shown in the main deal card when possible.",
  ].join("\n");
}

export function buyerPaymentRequiredButtons(dealCode: string): { text: string; cb: string }[][] {
  return [
    [
      { text: "I Have Paid", cb: `bx:pay:${dealCode}` },
      { text: "Check Payment", cb: `bx:cp:${dealCode}` },
    ],
    [
      { text: "View Deal", cb: `d:v:${dealCode}` },
      { text: "Deal Room", cb: `dr:enter:${dealCode}` },
    ],
    [{ text: "Report Issue", cb: `d:rp:${dealCode}` }],
  ];
}

export function buyerUnlockedText(dealCode: string): string {
  return [
    DIV,
    "OGMP MM — Delivery Unlocked",
    DIV,
    "",
    `Deal: ${dealCode}`,
    "Status: Payment Confirmed",
    "",
    "Your payment has been secured.",
    "",
    "The seller's delivery is now unlocked.",
    "",
    "Please review the files carefully before confirming release.",
  ].join("\n");
}

export function buyerUnlockedKeyboard(dealCode: string, showDownload: boolean): { text: string; cb: string }[][] {
  const row: { text: string; cb: string }[] = [];
  if (showDownload) row.push({ text: "Download Files", cb: `bx:dl:${dealCode}` });
  row.push({ text: "Confirm Received", cb: `d:rel:${dealCode}` });
  return [
    row,
    [
      { text: "Open Dispute", cb: `d:dp:${dealCode}` },
      { text: "View Deal", cb: `d:v:${dealCode}` },
    ],
  ];
}

export function buyerReviewFollowupText(dealCode: string): string {
  return [
    DIV,
    "OGMP MM — Buyer Review",
    DIV,
    "",
    "Please check the delivery carefully.",
    "",
    "Confirm only if everything is correct.",
    "",
    `Deal: ${dealCode}`,
  ].join("\n");
}

export function buyerReviewKeyboard(dealCode: string): { text: string; cb: string }[][] {
  return [
    [
      { text: "Confirm Received", cb: `d:rel:${dealCode}` },
      { text: "Open Dispute", cb: `d:dp:${dealCode}` },
    ],
    [{ text: "View Deal", cb: `d:v:${dealCode}` }, { text: "Deal Room", cb: `dr:enter:${dealCode}` }],
  ];
}

export function buyerPaymentSecuredAwaitingDeliveryText(dealCode: string): string {
  return [
    DIV,
    "OGMP MM — Payment Confirmed",
    DIV,
    "",
    `Deal: ${dealCode}`,
    "",
    "Your payment is secured in escrow.",
    "",
    "The seller can now post delivery in the deal room.",
  ].join("\n");
}

export function sellerFundsSecuredText(dealCode: string): string {
  return [
    DIV,
    "OGMP MM — Funds Secured",
    DIV,
    "",
    `Deal: ${dealCode}`,
    "",
    "Buyer payment is confirmed and secured in escrow.",
    "",
    "The buyer can now access the delivery.",
  ].join("\n");
}

export async function notifyBuyerPaymentRequired(dealId: string): Promise<void> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true, seller: true },
  });
  const pay = await prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } });
  if (!deal?.buyer || !deal.paymentAddress || !pay || !deal.sellerId) return;
  const locked = await prisma.dealMessage.findMany({
    where: { dealId, lockedForBuyer: true, senderId: deal.sellerId },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const names = locked.map((m: DealMessage) => m.fileName).filter(Boolean) as string[];
  const text = buyerPaymentRequiredText({
    dealCode: deal.dealCode,
    amount: deal.amount.toString(),
    currency: deal.currency,
    network: deal.network,
    paymentAddress: deal.paymentAddress,
    expiresAt: pay.expiresAt,
    lockedFileName: names[0],
    lockedFileCount: locked.length,
  });
  await enqueueDmWithButtons({
    chatId: deal.buyer.telegramId.toString(),
    text,
    buttons: buyerPaymentRequiredButtons(deal.dealCode),
  });
}

export async function onPaymentConfirmedDeliveryFlow(dealId: string): Promise<void> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true, seller: true },
  });
  if (!deal || deal.status !== "funded" || deal.deliveryUnlockNotifiedAt) return;

  const lockedBefore = await countLockedDeliveryMessages(dealId);
  await prisma.dealMessage.updateMany({
    where: { dealId, lockedForBuyer: true },
    data: { lockedForBuyer: false },
  });

  if (lockedBefore > 0) {
    try {
      await transitionDealStatus(dealId, "funded", "item_delivered", { deliveredAt: new Date() });
    } catch (e) {
      logger.warn("delivery_flow_item_delivered_skip", { dealId, err: String(e) });
    }
    await appendDealTimelineEvent({
      dealId,
      eventType: "delivery_unlocked",
      metadata: { lockedFiles: lockedBefore },
    });
  }

  const pay = await prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } });
  const dealFresh = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true, seller: true },
  });
  if (!dealFresh) return;
  const ufs = userFacingDealStatus(dealFresh, { hasLockedDelivery: false, paymentStatus: pay?.status ?? null });

  if (dealFresh.seller) {
    await enqueueDealParticipantNotify({
      targetTelegramId: dealFresh.seller.telegramId,
      text: sellerFundsSecuredText(dealFresh.dealCode),
    });
  }

  if (dealFresh.buyer) {
    const auto = loadConfig().AUTO_SEND_DELIVERY_AFTER_PAYMENT;
    if (lockedBefore > 0) {
      const text = buyerUnlockedText(dealFresh.dealCode);
      await enqueueDmWithButtons({
        chatId: dealFresh.buyer.telegramId.toString(),
        text: `${text}\n\nStatus: ${ufs}`,
        buttons: buyerUnlockedKeyboard(dealFresh.dealCode, !auto),
      });
      if (auto) {
        await enqueueBuyerDeliverySend({
          dealId,
          buyerTelegramId: dealFresh.buyer.telegramId.toString(),
        });
      }
    } else {
      await enqueueDmWithButtons({
        chatId: dealFresh.buyer.telegramId.toString(),
        text: `${buyerPaymentSecuredAwaitingDeliveryText(dealFresh.dealCode)}\n\nStatus: ${ufs}`,
        buttons: [
          [
            { text: "View Deal", cb: `d:v:${dealFresh.dealCode}` },
            { text: "Deal Room", cb: `dr:enter:${dealFresh.dealCode}` },
          ],
        ],
      });
    }
  }

  await prisma.deal.update({
    where: { id: dealId },
    data: { deliveryUnlockNotifiedAt: new Date() },
  });
}

export async function resubmitSellerDeliveryNotify(dealId: string): Promise<void> {
  await notifyBuyerPaymentRequired(dealId);
  await appendDealTimelineEvent({
    dealId,
    eventType: "seller_submitted_delivery",
    metadata: {},
  });
}

export function paymentNotDetectedBuyerText(): string {
  return [
    "Payment not detected yet.",
    "",
    "Please make sure:",
    "• You sent the exact amount",
    "• You used the correct network",
    "• You sent to the correct address",
    "",
    "You can tap Check Payment again shortly.",
  ].join("\n");
}

export function paymentDetectedWaitingText(): string {
  return [
    "Payment detected.",
    "",
    "Waiting for network confirmations before unlocking delivery.",
    "",
    "You can tap Check Payment again in a moment.",
  ].join("\n");
}
