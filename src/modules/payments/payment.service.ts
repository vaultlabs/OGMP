import type { PaymentRecordStatus } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { getPaymentProvider } from "../../payments/index.js";
import { writeAuditLog } from "../../services/audit.service.js";
import { transitionDealStatus } from "../deals/deal.service.js";
import { appendDealTimelineEvent } from "../dealTimeline/timeline.service.js";
import { assertValidDealTransition } from "../../services/escrow-state-machine.js";
import { logger } from "../../utils/logger.js";
import { createHash } from "node:crypto";

function mapProviderStatus(
  s: "pending" | "detecting" | "confirming" | "confirmed" | "underpaid" | "overpaid" | "expired",
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
    default:
      return "pending";
  }
}

async function loadDeal(dealId: string) {
  return prisma.deal.findUnique({ where: { id: dealId } });
}

export async function applyPaymentSyncForDeal(dealId: string): Promise<void> {
  const payment = await prisma.payment.findFirst({
    where: { dealId },
    orderBy: { createdAt: "desc" },
  });
  if (!payment) return;

  const provider = getPaymentProvider();
  const status = await provider.checkPaymentStatus(payment);

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: mapProviderStatus(status.status),
      receivedAmount: status.receivedAmount,
      txHash: status.txHash,
      confirmations: status.confirmations,
    },
  });

  let deal = await loadDeal(dealId);
  if (!deal) return;
  if (
    deal.status !== "waiting_payment" &&
    deal.status !== "payment_detected" &&
    deal.status !== "funded"
  ) {
    return;
  }

  if (status.status === "expired") {
    if (deal.status === "waiting_payment" || deal.status === "payment_detected") {
      assertValidDealTransition(deal.status, "cancelled");
      await prisma.deal.update({
        where: { id: deal.id, version: deal.version },
        data: { status: "cancelled", cancelledAt: new Date(), version: { increment: 1 } },
      });
      await writeAuditLog({ eventType: "payment_expired", dealId });
      await appendDealTimelineEvent({
        dealId,
        eventType: "deal_closed",
        metadata: { reason: "payment_expired" },
      });
    }
    return;
  }

  if (status.status === "underpaid" || status.status === "overpaid") {
    if (deal.status === "waiting_payment") {
      await transitionDealStatus(deal.id, "waiting_payment", "payment_detected");
      await appendDealTimelineEvent({
        dealId: deal.id,
        eventType: "payment_detected",
        metadata: { phase: status.status, received: status.receivedAmount },
      });
    }
    await writeAuditLog({
      eventType: status.status === "underpaid" ? "payment_underpaid" : "payment_overpaid",
      dealId,
      metadata: { received: status.receivedAmount },
    });
    return;
  }

  if (status.status === "pending") {
    return;
  }

  if (status.status === "confirming" || status.status === "detecting") {
    deal = await loadDeal(dealId);
    if (!deal) return;
    if (deal.status === "waiting_payment") {
      await transitionDealStatus(deal.id, "waiting_payment", "payment_detected");
      await appendDealTimelineEvent({
        dealId: deal.id,
        eventType: "payment_detected",
        metadata: { phase: status.status, confirmations: status.confirmations },
      });
    }
    await writeAuditLog({ eventType: "payment_detected", dealId, metadata: { confirmations: status.confirmations } });
    return;
  }

  if (status.status === "confirmed") {
    deal = await loadDeal(dealId);
    if (!deal) return;
    if (deal.status === "waiting_payment") {
      await transitionDealStatus(deal.id, "waiting_payment", "payment_detected");
      await appendDealTimelineEvent({
        dealId: deal.id,
        eventType: "payment_detected",
        metadata: { phase: "confirmed", confirmations: status.confirmations },
      });
    }
    deal = await loadDeal(dealId);
    if (!deal) return;
    let becameFunded = false;
    if (deal.status === "payment_detected") {
      await transitionDealStatus(deal.id, "payment_detected", "funded", {
        fundedAt: new Date(),
        txHash: status.txHash ?? deal.txHash,
      });
      await appendDealTimelineEvent({
        dealId: deal.id,
        eventType: "payment_confirmed",
        metadata: { txHash: status.txHash },
      });
      becameFunded = true;
    }
    await writeAuditLog({ eventType: "payment_confirmed", dealId, metadata: { txHash: status.txHash } });
    if (becameFunded) {
      const { onPaymentConfirmedDeliveryFlow } = await import("../../services/delivery.service.js");
      await onPaymentConfirmedDeliveryFlow(dealId);
    }
  }
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
    const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
    if (code === "P2002") {
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

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: mapProviderStatus(normalized.result.status),
      receivedAmount: normalized.result.receivedAmount,
      txHash: normalized.result.txHash,
      confirmations: normalized.result.confirmations,
      webhookDeliveredAt: new Date(),
      rawPayload: parsed as object,
    },
  });

  await applyPaymentSyncForDeal(payment.dealId);
  return { ok: true };
}
