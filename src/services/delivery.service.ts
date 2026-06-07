import { InlineKeyboard } from "grammy";
import type { DealMessage } from "@prisma/client";
import { loadConfig } from "../config/index.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { transitionDealStatus } from "../modules/deals/deal.service.js";
import { appendDealTimelineEvent } from "../modules/dealTimeline/timeline.service.js";
import { countLockedDeliveryMessages } from "../modules/dealMessages/dealMessage.service.js";
import { enqueueBuyerDeliverySend } from "../modules/notifications/notificationQueue.service.js";
import {
  notifyDealParticipantCritical,
  notifyDmWithButtonsCritical,
} from "../modules/notifications/critical-notify.service.js";
import { userFacingDealStatus } from "../modules/deals/user-facing-status.js";
import { COMMUNITY_TRUST_LINE, TRUST_OPS_FOOTER } from "../bots/mainBot/trust-copy.js";
import { PAYMENT_EXACT_AMOUNT_WARNING } from "../bots/mainBot/payment-copy.js";
import {
  formatCryptoAmount,
  previewSellerPayoutAmount,
  resolveBuyerPayAmount,
  resolveDealPaymentAmounts,
} from "./fee.service.js";
import { sellerPayoutReady } from "../modules/deals/seller-payout.service.js";
import { getRedis } from "../utils/redis.js";

const DIV = "━━━━━━━━━━━━━━━━━━";
const PAY_REQ_DEDUP_TTL_SEC = 3600;

function paymentRequiredDedupKey(dealId: string, paymentAddress: string): string {
  return `ogmp:buyer_pay_req:${dealId}:${paymentAddress}`;
}

export async function countSellerLockedDelivery(dealId: string, sellerId: string | null): Promise<number> {
  if (!sellerId) return 0;
  return prisma.dealMessage.count({
    where: { dealId, lockedForBuyer: true, senderId: sellerId },
  });
}

/** True when buyer may pay: vault locked, seller wallet set, escrow address issued. */
export async function isBuyerPaymentReady(dealId: string): Promise<boolean> {
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal?.sellerId || !deal.paymentAddress) return false;
  if (deal.status !== "waiting_payment" && deal.status !== "payment_detected") return false;
  const locked = await countSellerLockedDelivery(dealId, deal.sellerId);
  return locked > 0 && sellerPayoutReady(deal);
}

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
  /** Exact amount the buyer must send (includes fee when buyer/split pays). */
  payAmount: string;
  dealAmount: string;
  sellerReceives: string;
  escrowFee: string;
  feePayer: string;
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
    "Next: copy the address → send the exact amount → I Have Paid / Check Payment.",
    "",
    lockLine,
    "",
    PAYMENT_EXACT_AMOUNT_WARNING,
    "",
    `Deal price: ${params.dealAmount} ${params.currency}`,
    `OGMP fee (1%): ${params.escrowFee} ${params.currency} (${params.feePayer})`,
    "",
    `▶ Pay exactly: ${params.payAmount} ${params.currency}`,
    `Seller receives on release: ${params.sellerReceives} ${params.currency}`,
    `Network: ${params.network}`,
    "",
    "Escrow address (long-press to copy):",
    params.paymentAddress,
    "",
    `Expires: ${exp}`,
    "",
    TRUST_OPS_FOOTER,
    "",
    COMMUNITY_TRUST_LINE,
  ].join("\n");
  return core;
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

/** Plain hint when a seller text note does not lock the vault. */
export function sellerDeliveryNeedsFileHint(): string {
  return [
    "Text saved, but it does not lock the Delivery Vault.",
    "",
    "What: buyers pay only after the seller locks real delivery files.",
    "Next: send a photo, video, or document (or a .zip archive) in this Deal room.",
    "Then tap Submit Delivery on the deal card if the buyer has not been pinged yet.",
  ].join("\n");
}

/** Plain hint when the buyer tries to upload product files. */
export function buyerDoesNotUploadDeliveryHint(): string {
  return [
    "Only the seller uploads the product for this deal.",
    "",
    "What: you are the buyer — wait for the seller to lock files in the Delivery Vault.",
    "Safe: you are not asked to upload delivery.",
    "Next: watch for the Payment Required DM, then pay using the in-bot escrow address only.",
  ].join("\n");
}

export async function notifyBuyerPaymentRequired(
  dealId: string,
  opts?: { force?: boolean },
): Promise<boolean> {
  let deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true, seller: true },
  });
  if (!deal?.buyer || !deal.sellerId) return false;

  const lockedCount = await countSellerLockedDelivery(dealId, deal.sellerId);
  if (lockedCount === 0) return false;

  if (!sellerPayoutReady(deal)) {
    await notifyBuyerVaultLockedPaymentPending(dealId);
    return false;
  }

  if (!deal.paymentAddress) {
    try {
      const { ensurePaymentInstruction } = await import("../modules/deals/deal.service.js");
      await ensurePaymentInstruction(dealId);
      deal = await prisma.deal.findUnique({
        where: { id: dealId },
        include: { buyer: true, seller: true },
      });
    } catch (e) {
      logger.warn("notify_buyer_payment_ensure_instruction_failed", { dealId, err: String(e) });
    }
  }

  if (!deal?.buyer || !deal.sellerId) return false;

  if (!deal.paymentAddress) {
    await notifyBuyerVaultLockedPaymentPending(dealId);
    return false;
  }

  const dedupKey = paymentRequiredDedupKey(dealId, deal.paymentAddress);
  if (!opts?.force) {
    const sent = await getRedis().get(dedupKey);
    if (sent) {
      logger.warn("notify_buyer_payment_skipped_dedup", { dealId, dealCode: deal.dealCode });
      return true;
    }
  }

  const pay = await prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } });
  if (!pay) return false;
  const amounts = resolveDealPaymentAmounts(deal);
  const buyerPays = resolveBuyerPayAmount(deal, pay);
  const sellerPreview = previewSellerPayoutAmount(deal, pay);
  const locked = await prisma.dealMessage.findMany({
    where: { dealId, lockedForBuyer: true, senderId: deal.sellerId },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const names = locked.map((m: DealMessage) => m.fileName).filter(Boolean) as string[];
  const text = buyerPaymentRequiredText({
    dealCode: deal.dealCode,
    payAmount: formatCryptoAmount(buyerPays),
    dealAmount: formatCryptoAmount(amounts.dealAmount),
    sellerReceives: formatCryptoAmount(sellerPreview.payout),
    escrowFee: formatCryptoAmount(amounts.escrowFee),
    feePayer: amounts.feePayer,
    currency: deal.currency,
    network: deal.network,
    paymentAddress: deal.paymentAddress,
    expiresAt: pay.expiresAt,
    lockedFileName: names[0],
    lockedFileCount: locked.length,
  });
  await notifyDmWithButtonsCritical({
    chatId: deal.buyer.telegramId.toString(),
    text,
    buttons: buyerPaymentRequiredButtons(deal.dealCode),
  });
  await getRedis().set(dedupKey, "1", "EX", PAY_REQ_DEDUP_TTL_SEC);
  return true;
}

/** Buyer nudge when vault is locked but escrow pay address is not ready yet. */
export async function notifyBuyerVaultLockedPaymentPending(dealId: string): Promise<void> {
  const dedupKey = `ogmp:vault_pending:${dealId}`;
  if (await getRedis().get(dedupKey)) return;

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true, seller: true },
  });
  if (!deal?.buyer) return;
  const needsWallet = deal.seller && !sellerPayoutReady(deal);
  const text = [
    DIV,
    "OGMP MM — Delivery Vault locked",
    DIV,
    "",
    `Deal: ${deal.dealCode}`,
    "",
    "What: the seller locked delivery in the vault.",
    "Safe: you do not upload files — only the seller delivers the product.",
    needsWallet
      ? "Next: waiting for the seller to finish payout wallet setup — then you will get Payment Required with the escrow address."
      : "Next: escrow address is being prepared — you will get Payment Required shortly. Do not pay outside OGMP MM until that DM arrives.",
    "",
    TRUST_OPS_FOOTER,
  ].join("\n");
  await notifyDmWithButtonsCritical({
    chatId: deal.buyer.telegramId.toString(),
    text,
    buttons: [[{ text: "View deal", cb: `d:v:${deal.dealCode}` }]],
  });
  if (needsWallet && deal.seller) {
    await notifyDmWithButtonsCritical({
      chatId: deal.seller.telegramId.toString(),
      text: [
        DIV,
        "OGMP MM — Buyer waiting on you",
        DIV,
        "",
        `Deal: ${deal.dealCode}`,
        "",
        "What: delivery is locked but the buyer cannot pay yet.",
        "Next: Set payout wallet on the deal card — then they receive Payment Required automatically.",
      ].join("\n"),
      buttons: [
        [
          { text: "Set payout wallet", cb: `spw:start:${deal.dealCode}` },
          { text: "View deal", cb: `d:v:${deal.dealCode}` },
        ],
      ],
    });
  }
  await getRedis().set(dedupKey, "1", "EX", 1800);
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
    await notifyDealParticipantCritical({
      targetTelegramId: dealFresh.seller.telegramId,
      text: sellerFundsSecuredText(dealFresh.dealCode),
      buttons: [[{ text: "View deal", cb: `d:v:${dealFresh.dealCode}` }]],
    });
  }

  if (dealFresh.buyer) {
    const auto = loadConfig().AUTO_SEND_DELIVERY_AFTER_PAYMENT;
    if (lockedBefore > 0) {
      const text = buyerUnlockedText(dealFresh.dealCode);
      await notifyDmWithButtonsCritical({
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
      await notifyDmWithButtonsCritical({
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

export async function resubmitSellerDeliveryNotify(dealId: string): Promise<boolean> {
  const ok = await notifyBuyerPaymentRequired(dealId, { force: true });
  await appendDealTimelineEvent({
    dealId,
    eventType: "seller_submitted_delivery",
    metadata: { buyerNotified: ok },
  });
  return ok;
}

export function paymentNotDetectedBuyerText(details?: {
  dealCode: string;
  expected: string;
  currency: string;
  network: string;
  addressTail: string;
  provider: string;
}): string {
  const lines = [
    "What: payment not detected yet.",
    "Safe: nothing is released.",
    "Next: Check Payment again after a few minutes.",
    "",
    PAYMENT_EXACT_AMOUNT_WARNING,
    "",
    "Use the address from Payment Required or View deal only.",
  ];
  if (details) {
    lines.splice(
      4,
      0,
      `Deal: ${details.dealCode}`,
      `Expected: ${details.expected} ${details.currency} (${details.network})`,
      `Address ends: …${details.addressTail}`,
      `Processor: ${details.provider}`,
      "",
    );
  }
  return lines.join("\n");
}

export function paymentDetectedWaitingText(): string {
  return [
    "What: payment detected — waiting for confirmations.",
    "Safe: Deal Protection keeps funds in escrow until confirmed.",
    "Next: you should get a Payment received DM shortly; vault unlocks automatically when confirmed.",
  ].join("\n");
}

export function paymentConfirmedUnlockingText(): string {
  return [
    "What: payment confirmed — Delivery Vault is unlocking.",
    "Safe: escrow still applies until Buyer Review + Release Request.",
    "Next: open your latest OGMP MM message or View Deal.",
  ].join("\n");
}
