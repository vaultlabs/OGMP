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
import {
  isPayoutVerifyConfigured,
} from "../payments/nowpayments-payout-verify.js";
import { getAllAdminTelegramIds } from "../modules/admin/admin-ids.service.js";

const DIV = "━━━━━━━━━━━━━━━━━━";

export { formatPayoutAmount };

/** Email/password (or bearer) — enough to create payouts via API. */
export function isNowpaymentsPayoutAuthConfigured(): boolean {
  const cfg = loadConfig();
  return Boolean(
    cfg.NOWPAYMENTS_BEARER_TOKEN?.trim() ||
      (cfg.NOWPAYMENTS_EMAIL?.trim() && cfg.NOWPAYMENTS_PASSWORD?.trim()),
  );
}

export function isAutoPayoutConfigured(): boolean {
  const cfg = loadConfig();
  if (cfg.PAYMENT_PROVIDER === "mock") return true;
  if (cfg.PAYMENT_PROVIDER !== "nowpayments") return false;
  return isNowpaymentsPayoutAuthConfigured();
}

/** True when bot can auto-submit payout verify (2FA secret or manual code in env). */
export function isPayoutVerifyAutomated(): boolean {
  return isPayoutVerifyConfigured();
}

export type DealPayoutExecuteResult =
  | { ok: true; skipped?: false }
  | { ok: true; skipped: true; message: string }
  | { ok: false; error: string };

export async function executeDealPayoutAfterRelease(dealId: string): Promise<DealPayoutExecuteResult> {
  const lockKey = `lock:deal:${dealId}:payout`;
  const token = randomBytes(8).toString("hex");
  if (!(await acquireLock(lockKey, 120_000, token))) {
    logger.warn("payout_lock_busy", { dealId });
    return { ok: false, error: "Payout already running for this deal — wait a minute and retry." };
  }
  try {
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      include: { seller: true, payouts: { orderBy: { createdAt: "desc" } } },
    });
    if (!deal || deal.status !== "released") {
      return { ok: false, error: "Deal is not in released status." };
    }
    if (!deal.sellerPayoutAddress?.trim() || !deal.sellerPayoutConfirmedAt) {
      logger.warn("payout_skipped_no_seller_wallet", { dealId, dealCode: deal.dealCode });
      return { ok: false, error: "Seller payout wallet is not set on this deal." };
    }

    const amounts = resolveDealPaymentAmounts(deal);
    let payoutRow = deal.payouts.find((p) => p.status !== "failed") ?? null;

    if (payoutRow?.status === "completed") {
      logger.warn("payout_retry_skip_completed", { dealId, dealCode: deal.dealCode, payoutId: payoutRow.id });
      return {
        ok: true,
        skipped: true,
        message: `Payout already completed for ${deal.dealCode}. Seller was paid — check NOWPayments / wallet.`,
      };
    }
    if (payoutRow?.status === "processing" && payoutRow.providerRef) {
      logger.warn("payout_retry_skip_processing", { dealId, dealCode: deal.dealCode, payoutId: payoutRow.providerRef });
      return {
        ok: true,
        skipped: true,
        message:
          `Payout already processing (${payoutRow.providerRef}). Check NOWPayments dashboard — verify 2FA / custody, do not retry.`,
      };
    }

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
      await notifyAdminsPayoutSetupNeeded(deal.dealCode, "missing_nowpayments_email_password");
      return { ok: false, error: "NOWPayments payout auth not configured (email/password in .env)." };
    }

    try {
      logger.warn("payout_create_start", {
        dealId,
        dealCode: deal.dealCode,
        amount: formatCryptoAmount(amounts.sellerReceives),
        currency: deal.currency,
        network: deal.network,
      });
      const result = await provider.createPayout(payoutRow, deal.sellerPayoutAddress.trim());
      if (provider.name === "nowpayments" && !isPayoutVerifyAutomated()) {
        await notifyAdminsPayoutEmailVerifyNeeded(deal.dealCode, result.payoutId);
      }
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
      return { ok: true };
    } catch (e) {
      const err = String(e);
      logger.error("deal_payout_execute_failed", { dealId, err });
      let adminDetail = err;
      const errLower = err.toLowerCase();
      if (errLower.includes("whitelist") || errLower.includes("not allowed") || errLower.includes("invalid address")) {
        adminDetail = [
          err,
          "",
          "NOWPayments wallet whitelist: each new seller address must be allowed on your account.",
          "For escrow (many different wallets), email whitelist@nowpayments.io to disable wallet whitelisting on payouts.",
          "See docs/FULL_AUTOMATION_NOWPAYMENTS.md in the repo.",
        ].join("\n");
      } else if (errLower.includes("invalid ip")) {
        adminDetail = [
          err,
          "",
          "Whitelist your server IP in NOWPayments → Settings → Whitelist → Whitelist IPs,",
          "or ask whitelist@nowpayments.io to disable IP whitelisting for API payouts.",
          "Codespaces: run curl -s https://api.ipify.org and whitelist that IP.",
        ].join("\n");
      } else if (err.toLowerCase().includes("insufficient balance")) {
        const { fetchNowpaymentsBalance, formatInsufficientBalanceHelp } = await import(
          "../payments/nowpayments-balance.js"
        );
        const balance = await fetchNowpaymentsBalance();
        adminDetail = formatInsufficientBalanceHelp({
          dealCode: deal.dealCode,
          currency: deal.currency,
          network: deal.network,
          payoutAmount: formatCryptoAmount(amounts.sellerReceives),
          balance,
        });
      }
      await prisma.payout.update({
        where: { id: payoutRow.id },
        data: { status: "failed", adminNote: adminDetail.slice(0, 500) },
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
      return { ok: false, error: adminDetail };
    }
  } finally {
    await releaseLock(lockKey, token);
  }
}

async function notifyAdminsPayoutEmailVerifyNeeded(
  dealCode: string,
  withdrawalId: string,
): Promise<void> {
  const text = [
    DIV,
    "OGMP MM — Payout verify (admin)",
    DIV,
    "",
    `Deal: ${dealCode}`,
    `NOWPayments payout id: ${withdrawalId}`,
    "",
    "Your account has 2FA OFF — NOWPayments emailed a 6-digit code to your registration email (valid ~1 hour).",
    "",
    "Quick fix:",
    "1. Copy the code from that email",
    "2. In .env set: NOWPAYMENTS_PAYOUT_VERIFY_CODE=123456",
    "3. Restart the bot",
    `4. Run: /admin_retry_payout ${dealCode}`,
    "",
    "Full automation (recommended): NOWPayments → Account → enable 2FA (Google Authenticator) → copy secret into NOWPAYMENTS_2FA_SECRET in .env (leave PAYOUT_VERIFY_CODE empty).",
  ].join("\n");
  const buttons = [[{ text: "View deal", cb: `d:v:${dealCode}` }]];
  for (const id of getAllAdminTelegramIds()) {
    try {
      await notifyDealParticipantCritical({
        targetTelegramId: BigInt(id),
        text,
        buttons,
      });
    } catch (e) {
      logger.warn("admin_payout_verify_notify_failed", { adminId: id, err: String(e) });
    }
  }
}

async function notifyAdminsPayoutSetupNeeded(dealCode: string, reason: string): Promise<void> {
  const text = [
    DIV,
    "OGMP MM — Payout not configured",
    DIV,
    "",
    `Deal: ${dealCode}`,
    `Reason: ${reason}`,
    "",
    "Set NOWPAYMENTS_EMAIL + NOWPAYMENTS_PASSWORD in .env (API password — see docs/ENV_SETUP.md if you use Google login).",
  ].join("\n");
  for (const id of getAllAdminTelegramIds()) {
    try {
      await enqueueDealParticipantNotify({
        targetTelegramId: BigInt(id),
        text,
        buttons: [[{ text: "View deal", cb: `d:v:${dealCode}` }]],
      });
    } catch {
      /* ignore */
    }
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
