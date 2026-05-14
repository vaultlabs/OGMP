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
import { COMMUNITY_TRUST_LINE, DEAL_PROTECTION_BEFORE_PAY, TRUST_OPS_FOOTER } from "../bots/mainBot/trust-copy.js";

const DIV = "━━━━━━━━━━━━━━━━━━";

export function sellerFileSecuredText(dealCode: string, fileName: string): string {
  return [
    DIV,
    "OGMP MM — Delivery Vault",
    DIV,
    "",
    `Deal: ${dealCode}`,
    "",
    "What: your file is locked in the Delivery Vault.",
    "Safe: buyer cannot download until Deal Protection (payment) completes.",
    "Next: wait for buyer pay, or add another file then Submit Delivery.",
    "",
    `File: ${fileName}`,
    "",
    "Only upload files for this deal.",
    "",
    TRUST_OPS_FOOTER,
    "",
    COMMUNITY_TRUST_LINE,
  ].join("\n");
}

export function sellerFileSecuredKeyboard(dealCode: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Upload Another File", `dr:enter:${dealCode}`)
    .row()
    .text("Submit Delivery", `dl:sub:${dealCode}`)
    .text("View Deal Room", `dr:enter:${dealCode}`)
    .row()
    .text("View Deal", `d:v:${dealCode}`);
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
      ? `${params.lockedFileCount} files in the Delivery Vault (names only until you pay).`
      : params.lockedFileName
        ? `Delivery Vault: ${params.lockedFileName}`
        : "Delivery: secured in the Delivery Vault.";
  const core = [
    DIV,
    "OGMP MM — Payment Required",
    DIV,
    "",
    `Deal: ${params.dealCode}`,
    "Status: Deal Protection — Delivery Vault locked",
    "",
    "What: pay escrow to unlock the vault.",
    "Safe: funds stay in escrow until Buyer Review + Release Request.",
    "Next: copy the address, send exact amount on the right network, then I Have Paid / Check Payment.",
    "",
    lockLine,
    "",
    `Amount: ${params.amount} ${params.currency}`,
    `Network: ${params.network}`,
    "",
    "Address:",
    params.paymentAddress,
    "",
    `Expires: ${exp}`,
    "",
    "Send only the selected crypto on this network. Never pay outside OGMP MM.",
    "",
    TRUST_OPS_FOOTER,
    "",
    COMMUNITY_TRUST_LINE,
  ].join("\n");
  return `${DEAL_PROTECTION_BEFORE_PAY}\n\n${core}`;
}

export function buyerPaymentRequiredButtons(dealCode: string): { text: string; cb: string }[][] {
  return [
    [
      { text: "I Have Paid", cb: `bx:pay:${dealCode}` },
      { text: "Check Payment", cb: `bx:cp:${dealCode}` },
    ],
    [{ text: "Copy Address", cb: `bx:addr:${dealCode}` }],
    [
      { text: "View Deal Room", cb: `dr:enter:${dealCode}` },
      { text: "View Deal", cb: `d:v:${dealCode}` },
    ],
    [{ text: "Open Case", cb: `d:rp:${dealCode}` }],
  ];
}

export function buyerUnlockedText(dealCode: string): string {
  return [
    DIV,
    "OGMP MM — Delivery Vault",
    DIV,
    "",
    `Deal: ${dealCode}`,
    "Status: Delivery Vault unlocked",
    "",
    "What: payment confirmed — vault is opening.",
    "Safe: funds still in escrow until you finish Buyer Review (confirm).",
    "Next: download, inspect, then Confirm Received — or Open Case if something is wrong.",
    "",
    "Only confirm after you fully checked the delivery.",
    "",
    TRUST_OPS_FOOTER,
    "",
    COMMUNITY_TRUST_LINE,
  ].join("\n");
}

export function buyerUnlockedKeyboard(dealCode: string, showDownload: boolean): { text: string; cb: string }[][] {
  const row: { text: string; cb: string }[] = [];
  if (showDownload) row.push({ text: "Download Files", cb: `bx:dl:${dealCode}` });
  row.push({ text: "Confirm Received", cb: `d:rel:${dealCode}` });
  return [
    row,
    [
      { text: "Open Case", cb: `d:rp:${dealCode}` },
      { text: "View Deal", cb: `d:v:${dealCode}` },
    ],
    [{ text: "View Deal Room", cb: `dr:enter:${dealCode}` }],
  ];
}

export function buyerReviewFollowupText(dealCode: string): string {
  return [
    DIV,
    "OGMP MM — Buyer Review",
    DIV,
    "",
    `Deal: ${dealCode}`,
    "",
    "What: Buyer Review — check the unlocked vault contents.",
    "Safe: escrow still holds funds until you confirm.",
    "Next: Confirm Received, or Open Case if there is a problem.",
    "",
    "Only confirm after you fully checked the delivery.",
    "",
    TRUST_OPS_FOOTER,
    "",
    COMMUNITY_TRUST_LINE,
  ].join("\n");
}

export function buyerReviewKeyboard(dealCode: string): { text: string; cb: string }[][] {
  return [
    [
      { text: "Confirm Received", cb: `d:rel:${dealCode}` },
      { text: "Open Case", cb: `d:rp:${dealCode}` },
    ],
    [{ text: "View Deal", cb: `d:v:${dealCode}` }, { text: "View Deal Room", cb: `dr:enter:${dealCode}` }],
  ];
}

export function buyerPaymentSecuredAwaitingDeliveryText(dealCode: string): string {
  return [
    DIV,
    "OGMP MM — Deal Protection",
    DIV,
    "",
    `Deal: ${dealCode}`,
    "",
    "What: payment confirmed — waiting on Delivery Vault content.",
    "Safe: your pay is in escrow.",
    "Next: seller should upload/lock in Deal room; you’ll get files when the vault unlocks.",
  ].join("\n");
}

export function sellerFundsSecuredText(dealCode: string): string {
  return [
    DIV,
    "OGMP MM — Deal Protection",
    DIV,
    "",
    `Deal: ${dealCode}`,
    "",
    "What: buyer payment confirmed.",
    "Safe: escrow holds funds until Buyer Review + Release Request.",
    "Next: buyer can access the Delivery Vault; wait for their confirm.",
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
    "What: payment not detected yet.",
    "Safe: nothing is released; your wallet is unchanged by OGMP MM.",
    "Next: double-check amount, network, and address — then Check Payment again.",
    "",
    "Never pay outside OGMP MM.",
  ].join("\n");
}

export function paymentDetectedWaitingText(): string {
  return [
    "What: payment detected — waiting for confirmations.",
    "Safe: Deal Protection keeps funds in escrow until confirmed.",
    "Next: wait a moment, then Check Payment again — Delivery Vault unlocks automatically.",
  ].join("\n");
}

export function paymentConfirmedUnlockingText(): string {
  return [
    "What: payment confirmed — Delivery Vault is unlocking.",
    "Safe: escrow still applies until Buyer Review + Release Request.",
    "Next: open your latest OGMP MM message or View Deal.",
  ].join("\n");
}
