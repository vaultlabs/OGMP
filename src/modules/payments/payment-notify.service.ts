import { prisma } from "../../db/prisma.js";
import { getRedis } from "../../utils/redis.js";
import {
  notifyDealParticipantCritical,
  notifyDmWithButtonsCritical,
} from "../notifications/critical-notify.service.js";
import { loadConfig } from "../../config/index.js";
import { formatCryptoAmount, resolveDealPaymentAmounts } from "../../services/fee.service.js";

const DETECTED_NOTIFY_KEY = (dealId: string) => `ogmp:pay-notified:detected:${dealId}`;
const CONFIRMED_NOTIFY_KEY = (dealId: string) => `ogmp:pay-notified:confirmed:${dealId}`;
const PARTIAL_NOTIFY_KEY = (dealId: string) => `ogmp:pay-notified:partial:${dealId}`;
const NOTIFY_TTL_SEC = 86400 * 14;

/** Call when a new escrow address is issued so a later payment can notify again. */
export async function clearPaymentProgressNotifyKeys(dealId: string): Promise<void> {
  const r = getRedis();
  await r.del(DETECTED_NOTIFY_KEY(dealId), PARTIAL_NOTIFY_KEY(dealId), CONFIRMED_NOTIFY_KEY(dealId));
}

/** DM buyer when escrow is fully confirmed (before / alongside delivery unlock). */
export async function notifyBuyerPaymentConfirmedIfNeeded(dealId: string): Promise<void> {
  if (!(await claimNotifyOnce(CONFIRMED_NOTIFY_KEY(dealId)))) return;

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true },
  });
  if (!deal?.buyer) return;

  await notifyDmWithButtonsCritical({
    chatId: deal.buyer.telegramId.toString(),
    text: [
      "━━━━━━━━━━━━━━━━━━",
      "OGMP MM — Payment confirmed",
      "━━━━━━━━━━━━━━━━━━",
      "",
      `Deal: ${deal.dealCode}`,
      "",
      "What: escrow payment is confirmed.",
      "Safe: funds are in Deal Protection.",
      "Next: Delivery Vault unlocks now — check your DMs for files.",
    ].join("\n"),
    buttons: [
      [
        { text: "View deal", cb: `d:v:${deal.dealCode}` },
        { text: "Download files", cb: `bx:dl:${deal.dealCode}` },
      ],
    ],
  });
}

async function claimNotifyOnce(key: string): Promise<boolean> {
  const r = getRedis();
  const ok = await r.set(key, "1", "EX", NOTIFY_TTL_SEC, "NX");
  return ok === "OK";
}

/** DM buyer (and seller) when on-chain funds are seen but not fully confirmed yet. */
export async function notifyBuyerPaymentDetectedIfNeeded(dealId: string): Promise<void> {
  if (!(await claimNotifyOnce(DETECTED_NOTIFY_KEY(dealId)))) return;

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true, seller: true },
  });
  const pay = await prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } });
  if (!deal?.buyer || !pay) return;

  const received = pay.receivedAmount?.toString() ?? "0";
  const amounts = resolveDealPaymentAmounts(deal);
  const expected = formatCryptoAmount(amounts.buyerPays);
  const text = [
    "━━━━━━━━━━━━━━━━━━",
    "OGMP MM — Payment received",
    "━━━━━━━━━━━━━━━━━━",
    "",
    "What: we see your payment on-chain.",
    `Amount seen: ${received} ${deal.currency} (pay exactly ${expected} on ${deal.network})`,
    `Seller receives on release: ${formatCryptoAmount(amounts.sellerReceives)} ${deal.currency}`,
    "Safe: funds stay in escrow until fully confirmed.",
    "Next: no need to tap Check Payment repeatedly — we'll DM you when confirmed and unlock the vault.",
    "",
    `Deal: ${deal.dealCode}`,
    "",
    "Never pay outside the address from OGMP MM.",
  ].join("\n");

  await notifyDmWithButtonsCritical({
    chatId: deal.buyer.telegramId.toString(),
    text,
    buttons: [
      [
        { text: "View deal", cb: `d:v:${deal.dealCode}` },
        { text: "Check payment", cb: `bx:cp:${deal.dealCode}` },
      ],
    ],
  });

  if (deal.seller) {
    await notifyDealParticipantCritical({
      targetTelegramId: deal.seller.telegramId,
      text: `Deal ${deal.dealCode}: buyer payment detected — confirming on-chain.`,
      buttons: [[{ text: "View deal", cb: `d:v:${deal.dealCode}` }]],
    });
  }
}

/** DM when paid amount does not match (partial / overpay). */
export async function notifyBuyerPaymentPartialIfNeeded(dealId: string): Promise<void> {
  if (!(await claimNotifyOnce(PARTIAL_NOTIFY_KEY(dealId)))) return;

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true },
  });
  const pay = await prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } });
  if (!deal?.buyer || !pay) return;

  const received = pay.receivedAmount?.toString() ?? "0";
  const amounts = resolveDealPaymentAmounts(deal);
  const expected = formatCryptoAmount(amounts.buyerPays);
  const kind = pay.status === "overpaid" ? "overpaid" : "underpaid";
  const text = [
    "━━━━━━━━━━━━━━━━━━",
    "OGMP MM — Payment amount mismatch",
    "━━━━━━━━━━━━━━━━━━",
    "",
    `What: payment ${kind}.`,
    `Received: ${received} ${deal.currency} · Pay exactly: ${expected} on ${deal.network}`,
    "Safe: escrow will not unlock until this is resolved.",
    "Next: send the remaining amount to the same in-bot address, or open Support with your deal code.",
    "",
    `Deal: ${deal.dealCode}`,
  ].join("\n");

  await notifyDmWithButtonsCritical({
    chatId: deal.buyer.telegramId.toString(),
    text,
    buttons: [[{ text: "View deal", cb: `d:v:${deal.dealCode}` }]],
  });
}

export function mockProviderPaymentWarning(): string | null {
  if (loadConfig().PAYMENT_PROVIDER !== "mock") return null;
  return [
    "",
    "⚠️ This bot is in MOCK payment mode — real crypto sent to the escrow address will NOT be detected.",
    "For real trades set PAYMENT_PROVIDER=nowpayments and configure NOWPayments + PUBLIC_BASE_URL.",
  ].join("\n");
}
