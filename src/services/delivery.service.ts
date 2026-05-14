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
import {
  COMMUNITY_TRUST_LINE,
  MAIN_UI_PARSE_MODE,
  RULER_HTML,
  TRUST_OPS_FOOTER,
} from "../bots/mainBot/trust-copy.js";
import { escapeTelegramHtml } from "../utils/telegram-html.js";

function trustFooterHtml(): string {
  return [
    "",
    `<i>${escapeTelegramHtml(TRUST_OPS_FOOTER)}</i>`,
    "",
    `<i>${escapeTelegramHtml(COMMUNITY_TRUST_LINE)}</i>`,
  ].join("\n");
}

export function sellerFileSecuredText(dealCode: string, fileName: string): string {
  const dc = escapeTelegramHtml(dealCode);
  const fn = escapeTelegramHtml(fileName);
  return [
    `<b>OGMP MM</b> · <i>Delivery vault</i>`,
    RULER_HTML,
    "",
    `<b>Deal</b> ${dc}`,
    "",
    "<b>What</b> Your file is locked in the Delivery Vault.",
    "<b>Safe</b> The buyer cannot download until Deal Protection (payment) completes.",
    "<b>Next</b> Wait for payment, or add another file, then <b>Submit Delivery</b>.",
    "",
    `<b>File</b> <code>${fn}</code>`,
    "",
    "<i>Only upload files intended for this deal.</i>",
    trustFooterHtml(),
  ].join("\n");
}

export function sellerFileSecuredKeyboard(dealCode: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Upload another file", `dr:enter:${dealCode}`)
    .row()
    .text("Submit delivery", `dl:sub:${dealCode}`)
    .text("Deal room", `dr:enter:${dealCode}`)
    .row()
    .text("View deal", `d:v:${dealCode}`);
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
    ? escapeTelegramHtml(params.expiresAt.toISOString().slice(0, 16).replace("T", " ") + " UTC")
    : "—";
  const lockLine =
    params.lockedFileCount && params.lockedFileCount > 1
      ? escapeTelegramHtml(
          `${params.lockedFileCount} files in the Delivery Vault (names only until you pay).`,
        )
      : params.lockedFileName
        ? `Delivery vault: ${escapeTelegramHtml(params.lockedFileName)}`
        : escapeTelegramHtml("Delivery is secured in the vault.");
  const addr = escapeTelegramHtml(params.paymentAddress);
  const dc = escapeTelegramHtml(params.dealCode);
  const amt = escapeTelegramHtml(params.amount);
  const cur = escapeTelegramHtml(params.currency);
  const net = escapeTelegramHtml(params.network);

  const intro = [
    `<b>Deal Protection</b>`,
    RULER_HTML,
    "",
    "<b>What</b> You are paying escrow to unlock the Delivery Vault.",
    "<b>Safe</b> Funds are not released to the seller until Buyer Review + Release Request (or Case Review if needed).",
    "<b>Next</b> Send only the correct coin and network to the address below.",
  ].join("\n");

  const core = [
    `<b>Payment required</b>`,
    RULER_HTML,
    "",
    `<b>Deal</b> ${dc}`,
    "<b>Status</b> Deal Protection — Delivery Vault locked",
    "",
    "<b>What</b> Pay escrow to unlock the vault.",
    "<b>Safe</b> Funds stay in escrow until Buyer Review + Release Request.",
    "<b>Next</b> Copy the address, send the exact amount on the right network, then use <b>I have paid</b> / <b>Check payment</b>.",
    "",
    `<i>${escapeTelegramHtml(lockLine)}</i>`,
    "",
    `<b>Amount</b> ${amt} ${cur}`,
    `<b>Network</b> ${net}`,
    "",
    "<b>Address</b>",
    `<code>${addr}</code>`,
    "",
    `<b>Expires</b> ${exp}`,
    "",
    "<i>Send only the selected crypto on this network. Never pay outside OGMP MM.</i>",
    trustFooterHtml(),
  ].join("\n");

  return `${intro}\n\n${core}`;
}

export function buyerPaymentRequiredButtons(dealCode: string): { text: string; cb: string }[][] {
  return [
    [
      { text: "I have paid", cb: `bx:pay:${dealCode}` },
      { text: "Check payment", cb: `bx:cp:${dealCode}` },
    ],
    [{ text: "Copy address", cb: `bx:addr:${dealCode}` }],
    [
      { text: "Deal room", cb: `dr:enter:${dealCode}` },
      { text: "View deal", cb: `d:v:${dealCode}` },
    ],
    [{ text: "Open case", cb: `d:rp:${dealCode}` }],
  ];
}

export function buyerUnlockedText(dealCode: string): string {
  const dc = escapeTelegramHtml(dealCode);
  return [
    `<b>Delivery vault</b> · <i>Unlocked</i>`,
    RULER_HTML,
    "",
    `<b>Deal</b> ${dc}`,
    "<b>Status</b> Delivery Vault unlocked",
    "",
    "<b>What</b> Payment confirmed — the vault is open.",
    "<b>Safe</b> Funds still sit in escrow until you finish Buyer Review.",
    "<b>Next</b> Download, inspect, then <b>Confirm received</b> — or <b>Open case</b> if something is wrong.",
    "",
    "<i>Confirm only after you have fully checked the delivery.</i>",
    trustFooterHtml(),
  ].join("\n");
}

export function buyerUnlockedKeyboard(dealCode: string, showDownload: boolean): { text: string; cb: string }[][] {
  const row: { text: string; cb: string }[] = [];
  if (showDownload) row.push({ text: "Download files", cb: `bx:dl:${dealCode}` });
  row.push({ text: "Confirm received", cb: `d:rel:${dealCode}` });
  return [
    row,
    [
      { text: "Open case", cb: `d:rp:${dealCode}` },
      { text: "View deal", cb: `d:v:${dealCode}` },
    ],
    [{ text: "Deal room", cb: `dr:enter:${dealCode}` }],
  ];
}

export function buyerReviewFollowupText(dealCode: string): string {
  const dc = escapeTelegramHtml(dealCode);
  return [
    `<b>Buyer review</b>`,
    RULER_HTML,
    "",
    `<b>Deal</b> ${dc}`,
    "",
    "<b>What</b> Check the unlocked vault contents.",
    "<b>Safe</b> Escrow still holds funds until you confirm.",
    "<b>Next</b> Confirm received, or open a case if there is a problem.",
    "",
    "<i>Confirm only after you have fully checked the delivery.</i>",
    trustFooterHtml(),
  ].join("\n");
}

export function buyerReviewKeyboard(dealCode: string): { text: string; cb: string }[][] {
  return [
    [
      { text: "Confirm received", cb: `d:rel:${dealCode}` },
      { text: "Open case", cb: `d:rp:${dealCode}` },
    ],
    [{ text: "View deal", cb: `d:v:${dealCode}` }, { text: "Deal room", cb: `dr:enter:${dealCode}` }],
  ];
}

export function buyerPaymentSecuredAwaitingDeliveryText(dealCode: string): string {
  const dc = escapeTelegramHtml(dealCode);
  return [
    `<b>Deal Protection</b> · <i>Payment secured</i>`,
    RULER_HTML,
    "",
    `<b>Deal</b> ${dc}`,
    "",
    "<b>What</b> Payment confirmed — waiting on Delivery Vault content.",
    "<b>Safe</b> Your pay is in escrow.",
    "<b>Next</b> The seller should upload and lock in Deal room; you will get files when the vault unlocks.",
  ].join("\n");
}

export function sellerFundsSecuredText(dealCode: string): string {
  const dc = escapeTelegramHtml(dealCode);
  return [
    `<b>Deal Protection</b> · <i>Buyer paid</i>`,
    RULER_HTML,
    "",
    `<b>Deal</b> ${dc}`,
    "",
    "<b>What</b> Buyer payment confirmed.",
    "<b>Safe</b> Escrow holds funds until Buyer Review + Release Request.",
    "<b>Next</b> The buyer can access the vault — wait for their confirmation.",
    trustFooterHtml(),
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
    parseMode: MAIN_UI_PARSE_MODE,
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
  const ufsEsc = escapeTelegramHtml(ufs);

  if (dealFresh.seller) {
    await enqueueDealParticipantNotify({
      targetTelegramId: dealFresh.seller.telegramId,
      text: sellerFundsSecuredText(dealFresh.dealCode),
      parseMode: MAIN_UI_PARSE_MODE,
    });
  }

  if (dealFresh.buyer) {
    const auto = loadConfig().AUTO_SEND_DELIVERY_AFTER_PAYMENT;
    if (lockedBefore > 0) {
      const text = buyerUnlockedText(dealFresh.dealCode);
      await enqueueDmWithButtons({
        chatId: dealFresh.buyer.telegramId.toString(),
        text: `${text}\n\n<b>Status</b> ${ufsEsc}`,
        parseMode: MAIN_UI_PARSE_MODE,
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
        text: `${buyerPaymentSecuredAwaitingDeliveryText(dealFresh.dealCode)}\n\n<b>Status</b> ${ufsEsc}`,
        parseMode: MAIN_UI_PARSE_MODE,
        buttons: [
          [
            { text: "View deal", cb: `d:v:${dealFresh.dealCode}` },
            { text: "Deal room", cb: `dr:enter:${dealFresh.dealCode}` },
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
    "<b>Payment</b> · <i>Not detected yet</i>",
    RULER_HTML,
    "",
    "<b>What</b> No matching payment seen yet.",
    "<b>Safe</b> Nothing is released; your wallet is unchanged by OGMP MM.",
    "<b>Next</b> Double-check amount, network, and address — then tap <b>Check payment</b> again.",
    "",
    "<i>Never pay outside the address this bot shows for your deal.</i>",
  ].join("\n");
}

export function paymentDetectedWaitingText(): string {
  return [
    "<b>Payment</b> · <i>Confirming</i>",
    RULER_HTML,
    "",
    "<b>What</b> Payment detected — waiting for confirmations.",
    "<b>Safe</b> Deal Protection keeps funds in escrow until confirmed.",
    "<b>Next</b> Wait a moment, then <b>Check payment</b> again — the vault unlocks automatically when ready.",
  ].join("\n");
}

export function paymentConfirmedUnlockingText(): string {
  return [
    "<b>Payment</b> · <i>Confirmed</i>",
    RULER_HTML,
    "",
    "<b>What</b> Payment confirmed — the Delivery Vault is unlocking.",
    "<b>Safe</b> Escrow still applies until Buyer Review + Release Request.",
    "<b>Next</b> Open your latest OGMP MM message or <b>View deal</b>.",
  ].join("\n");
}
