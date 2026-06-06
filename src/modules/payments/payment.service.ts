import type { PaymentRecordStatus } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { getPaymentProvider } from "../../payments/index.js";
import { writeAuditLog } from "../../services/audit.service.js";
import { transitionDealStatus } from "../deals/deal.service.js";
import { appendDealTimelineEvent } from "../dealTimeline/timeline.service.js";
import { assertValidDealTransition } from "../../services/escrow-state-machine.js";
import { logger } from "../../utils/logger.js";
import { createHash } from "node:crypto";
import type { PaymentStatusResult } from "../../payments/payment-provider.types.js";
import {
  notifyBuyerPaymentConfirmedIfNeeded,
  notifyBuyerPaymentDetectedIfNeeded,
  notifyBuyerPaymentPartialIfNeeded,
} from "./payment-notify.service.js";
import {
  isPaymentConfirmedForEscrow,
  shouldAdvancePaymentStatus,
} from "./payment-status-rank.js";
import { unmarkDealHotPaymentPoll } from "./hot-payment-poll.service.js";
import { ConflictError } from "../../utils/errors.js";

export function isPrismaUniqueConstraintError(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
}

/** P2025 — optimistic lock miss or row deleted between read and update. */
export function isPrismaRecordNotFoundError(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2025";
}

export function isPaymentSyncRaceError(e: unknown): boolean {
  return e instanceof ConflictError || isPrismaRecordNotFoundError(e);
}

function mapProviderStatus(
  s: PaymentStatusResult["status"],
): PaymentRecordStatus {
  switch (s) {
    case "pending":
      return "pending";
    case "detecting":
      return "detecting";
    case "confirming":
      return "confirming";
    case "confirmed":
      return "confirmed";
    case "underpaid":
      return "underpaid";
    case "overpaid":
      return "overpaid";
    case "expired":
      return "expired";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

async function loadDeal(dealId: string) {
  return prisma.deal.findUnique({ where: { id: dealId } });
}

async function safeTransition(
  dealId: string,
  from: Parameters<typeof transitionDealStatus>[1],
  to: Parameters<typeof transitionDealStatus>[2],
  extra?: Parameters<typeof transitionDealStatus>[3],
): Promise<boolean> {
  const deal = await loadDeal(dealId);
  if (!deal || deal.status !== from) return false;
  try {
    await transitionDealStatus(deal.id, from, to, extra);
    return true;
  } catch (e) {
    if (isPaymentSyncRaceError(e)) {
      logger.warn("payment_transition_race", { dealId, from, to });
      return false;
    }
    throw e;
  }
}

async function promoteDealToFunded(
  dealId: string,
  txHash: string | undefined,
): Promise<boolean> {
  let deal = await loadDeal(dealId);
  if (!deal) return false;

  if (deal.status === "waiting_payment") {
    const moved = await safeTransition(dealId, "waiting_payment", "payment_detected");
    if (moved) {
      await appendDealTimelineEvent({
        dealId: deal.id,
        eventType: "payment_detected",
        metadata: { phase: "confirmed" },
      });
    }
    deal = await loadDeal(dealId);
    if (!deal) return false;
  }

  if (deal.status !== "payment_detected") {
    return deal.status === "funded";
  }

  const funded = await safeTransition(dealId, "payment_detected", "funded", {
    fundedAt: new Date(),
    txHash: txHash ?? deal.txHash ?? undefined,
  });
  if (!funded) {
    deal = await loadDeal(dealId);
    return deal?.status === "funded";
  }
  await appendDealTimelineEvent({
    dealId: deal.id,
    eventType: "payment_confirmed",
    metadata: { txHash },
  });
  await writeAuditLog({ eventType: "payment_confirmed", dealId, metadata: { txHash } });
  return true;
}

async function runDeliveryFlowIfNeeded(dealId: string): Promise<void> {
  const deal = await loadDeal(dealId);
  if (!deal || deal.status !== "funded") return;
  const { onPaymentConfirmedDeliveryFlow } = await import("../../services/delivery.service.js");
  await onPaymentConfirmedDeliveryFlow(dealId);
}

/**
 * Apply provider status to deal transitions (shared by API poll + IPN webhook).
 */
export async function applyPaymentStatusToDeal(
  dealId: string,
  status: PaymentStatusResult,
): Promise<void> {
  let deal = await loadDeal(dealId);
  if (!deal) return;
  if (
    deal.status !== "waiting_payment" &&
    deal.status !== "payment_detected" &&
    deal.status !== "funded"
  ) {
    return;
  }

  if (status.status === "expired" || status.status === "failed") {
    deal = await loadDeal(dealId);
    if (deal && (deal.status === "waiting_payment" || deal.status === "payment_detected")) {
      try {
        assertValidDealTransition(deal.status, "cancelled");
        await transitionDealStatus(deal.id, deal.status, "cancelled", { cancelledAt: new Date() });
        await writeAuditLog({
          eventType: status.status === "expired" ? "payment_expired" : "payment_failed",
          dealId,
        });
        await appendDealTimelineEvent({
          dealId,
          eventType: "deal_closed",
          metadata: { reason: status.status === "expired" ? "payment_expired" : "payment_failed" },
        });
      } catch (e) {
        if (isPaymentSyncRaceError(e)) {
          logger.warn("payment_cancel_race", { dealId, err: String(e) });
          return;
        }
        throw e;
      }
    }
    await unmarkDealHotPaymentPoll(dealId);
    return;
  }

  if (status.status === "underpaid" || status.status === "overpaid") {
    if (deal.status === "waiting_payment") {
      const moved = await safeTransition(dealId, "waiting_payment", "payment_detected");
      if (moved) {
        await appendDealTimelineEvent({
          dealId: deal.id,
          eventType: "payment_detected",
          metadata: { phase: status.status, received: status.receivedAmount },
        });
      }
    }
    await writeAuditLog({
      eventType: status.status === "underpaid" ? "payment_underpaid" : "payment_overpaid",
      dealId,
      metadata: { received: status.receivedAmount },
    });
    await notifyBuyerPaymentPartialIfNeeded(dealId);
    return;
  }

  if (status.status === "pending") {
    return;
  }

  const escrowConfirmed = isPaymentConfirmedForEscrow(status);

  if (!escrowConfirmed && (status.status === "confirming" || status.status === "detecting")) {
    deal = await loadDeal(dealId);
    if (!deal) return;
    if (deal.status === "waiting_payment") {
      const moved = await safeTransition(dealId, "waiting_payment", "payment_detected");
      if (moved) {
        await appendDealTimelineEvent({
          dealId: deal.id,
          eventType: "payment_detected",
          metadata: { phase: status.status, confirmations: status.confirmations },
        });
      }
    }
    await writeAuditLog({
      eventType: "payment_detected",
      dealId,
      metadata: { confirmations: status.confirmations },
    });
    await notifyBuyerPaymentDetectedIfNeeded(dealId);
    return;
  }

  if (escrowConfirmed) {
    const becameFunded = await promoteDealToFunded(dealId, status.txHash);
    if (becameFunded) {
      await notifyBuyerPaymentConfirmedIfNeeded(dealId);
      await runDeliveryFlowIfNeeded(dealId);
      await unmarkDealHotPaymentPoll(dealId);
      return;
    }
    await runDeliveryFlowIfNeeded(dealId);
    await unmarkDealHotPaymentPoll(dealId);
  }
}

export async function applyPaymentSyncForDeal(dealId: string): Promise<void> {
  const payment = await prisma.payment.findFirst({
    where: { dealId },
    orderBy: { createdAt: "desc" },
  });
  if (!payment) return;

  const provider = getPaymentProvider();
  let status: PaymentStatusResult;
  try {
    status = await provider.checkPaymentStatus(payment);
  } catch (e) {
    logger.error("payment_status_api_failed", { dealId, err: String(e) });
    throw e;
  }

  const mapped = mapProviderStatus(status.status);
  if (shouldAdvancePaymentStatus(payment.status, status.status)) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: mapped,
        receivedAmount: status.receivedAmount,
        txHash: status.txHash,
        confirmations: status.confirmations,
      },
    });
  } else {
    logger.info("payment_status_api_ignored_downgrade", {
      dealId,
      current: payment.status,
      api: status.status,
    });
  }

  await applyPaymentStatusToDeal(dealId, status);
}

export async function processWebhookPayload(
  providerName: string,
  rawBody: Buffer,
  signature: string | undefined,
): Promise<{ ok: boolean; message?: string }> {
  const provider = getPaymentProvider();
  if (provider.name !== providerName) {
    return { ok: false, message: "provider_mismatch" };
  }
  if (!provider.verifyWebhook(rawBody, signature)) {
    return { ok: false, message: "bad_signature" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { ok: false, message: "invalid_json" };
  }
  const normalized = provider.parseWebhook(parsed);
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");

  try {
    await prisma.webhookEvent.create({
      data: {
        provider: providerName,
        idempotencyKey: normalized.idempotencyKey,
        payloadHash,
      },
    });
  } catch (e: unknown) {
    if (isPrismaUniqueConstraintError(e)) {
      return { ok: true, message: "duplicate" };
    }
    throw e;
  }

  const payment = await prisma.payment.findUnique({
    where: { idempotencyKey: normalized.idempotencyKey },
  });
  if (!payment) {
    logger.warn("webhook_unknown_payment", { key: normalized.idempotencyKey });
    return { ok: true, message: "unknown_payment" };
  }

  const mapped = mapProviderStatus(normalized.result.status);
  if (shouldAdvancePaymentStatus(payment.status, normalized.result.status)) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: mapped,
        receivedAmount: normalized.result.receivedAmount,
        txHash: normalized.result.txHash,
        confirmations: normalized.result.confirmations,
        webhookDeliveredAt: new Date(),
        rawPayload: parsed as object,
      },
    });
  } else {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        webhookDeliveredAt: new Date(),
        rawPayload: parsed as object,
      },
    });
  }

  logger.info("payment_webhook_applied", {
    dealId: payment.dealId,
    status: normalized.result.status,
    received: normalized.result.receivedAmount,
  });

  await applyPaymentStatusToDeal(payment.dealId, normalized.result);
  return { ok: true };
}
