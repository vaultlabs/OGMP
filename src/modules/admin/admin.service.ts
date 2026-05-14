import type { DealStatus, FeePayer, PayoutStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { logAdminAction } from "./admin.repository.js";
import { writeAuditLog } from "../../services/audit.service.js";
import { ForbiddenError, NotFoundError, StateMachineError, ValidationError } from "../../utils/errors.js";
import { getPaymentProvider } from "../../payments/index.js";
import { isAdminTelegramId } from "../../config/index.js";
import { applyDealReleasedStats } from "../../services/reputation.service.js";
import { onDealReleasedSideEffects } from "../../services/deal-completion-notify.service.js";
import { appendDealTimelineEvent } from "../dealTimeline/timeline.service.js";
import { ensurePaymentInstruction } from "../deals/deal.service.js";
import { enqueueDealParticipantNotify } from "../notifications/notificationQueue.service.js";
import { getRequirePayoutDoubleConfirm } from "../../services/platform-settings.service.js";

function assertAdmin(telegramId: bigint): void {
  if (!isAdminTelegramId(telegramId)) throw new ForbiddenError("Admin only");
}

const ADMIN_RELEASE_FROM: DealStatus[] = [
  "release_requested",
  "disputed",
  "funded",
  "item_delivered",
  "buyer_confirmed",
  "payment_detected",
];

const ADMIN_REFUND_FROM: DealStatus[] = [
  "release_requested",
  "disputed",
  "funded",
  "item_delivered",
  "buyer_confirmed",
  "payment_detected",
  "waiting_payment",
];

export async function adminForceRelease(dealId: string, adminTelegramId: bigint): Promise<void> {
  assertAdmin(adminTelegramId);
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal) throw new NotFoundError("Deal not found");
  if (!ADMIN_RELEASE_FROM.includes(deal.status)) {
    throw new StateMachineError("Cannot force release from this status");
  }
  if (!deal.sellerPayoutAddress?.trim()) {
    throw new StateMachineError("Seller payout wallet is required before admin release.");
  }
  if ((await getRequirePayoutDoubleConfirm()) && !deal.sellerPayoutConfirmedAt) {
    throw new StateMachineError("Seller payout wallet must be double-confirmed (deal card) before release.");
  }
  const openPayout = await prisma.payout.findFirst({
    where: {
      dealId,
      status: { in: ["pending", "processing"] },
    },
  });
  if (openPayout) {
    throw new StateMachineError("A payout is already queued for this deal. Update that payout record before forcing another release.");
  }
  await prisma.deal.update({
    where: { id: dealId, version: deal.version },
    data: {
      status: "released",
      releasedAt: new Date(),
      frozen: false,
      frozenAt: null,
      frozenReason: null,
      activeReportId: null,
      version: { increment: 1 },
    },
  });
  const provider = getPaymentProvider();
  if (deal.sellerPayoutAddress) {
    await prisma.payout.create({
      data: {
        dealId,
        amount: deal.amount,
        feeDeducted: deal.feeAmount,
        currency: deal.currency,
        network: deal.network,
        toAddress: deal.sellerPayoutAddress,
        status: "pending",
        providerRef: `${provider.name}:admin_release`,
        adminNote: `Admin force release (telegram ${adminTelegramId}). Set tx hash when payout is sent.`,
      },
    });
  }
  await logAdminAction({
    adminTelegramId,
    action: "force_release",
    dealId,
    metadata: { fromStatus: deal.status },
  });
  await writeAuditLog({ eventType: "admin_force_release", dealId, metadata: { admin: adminTelegramId.toString() } });
  await appendDealTimelineEvent({
    dealId,
    actorId: null,
    eventType: "admin_decision",
    metadata: { action: "force_release", admin: adminTelegramId.toString(), fromStatus: deal.status },
  });
  await appendDealTimelineEvent({
    dealId,
    actorId: null,
    eventType: "funds_released",
    metadata: { via: "admin_force_release" },
  });
  const released = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
  await applyDealReleasedStats(released);
  await onDealReleasedSideEffects(dealId);
}

export async function adminForceRefund(dealId: string, adminTelegramId: bigint): Promise<void> {
  assertAdmin(adminTelegramId);
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal) throw new NotFoundError("Deal not found");
  if (!ADMIN_REFUND_FROM.includes(deal.status)) {
    throw new StateMachineError("Cannot force refund from this status");
  }
  await prisma.deal.update({
    where: { id: dealId, version: deal.version },
    data: {
      status: "refunded",
      frozen: false,
      frozenAt: null,
      frozenReason: null,
      activeReportId: null,
      version: { increment: 1 },
    },
  });
  await logAdminAction({ adminTelegramId, action: "force_refund", dealId, metadata: { fromStatus: deal.status } });
  await writeAuditLog({ eventType: "admin_force_refund", dealId, metadata: { admin: adminTelegramId.toString() } });
  await appendDealTimelineEvent({
    dealId,
    actorId: null,
    eventType: "admin_decision",
    metadata: { action: "force_refund", admin: adminTelegramId.toString(), fromStatus: deal.status },
  });
  await appendDealTimelineEvent({
    dealId,
    actorId: null,
    eventType: "deal_closed",
    metadata: { reason: "refunded", via: "admin_force_refund" },
  });
}

export async function adminCancelDeal(dealId: string, adminTelegramId: bigint): Promise<void> {
  assertAdmin(adminTelegramId);
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal) throw new NotFoundError("Deal not found");
  await prisma.deal.update({
    where: { id: dealId, version: deal.version },
    data: { status: "cancelled", cancelledAt: new Date(), version: { increment: 1 } },
  });
  await logAdminAction({ adminTelegramId, action: "admin_cancel", dealId });
}

export async function adminSetFeeSettings(params: {
  adminTelegramId: bigint;
  percentage?: string;
  minimumUsd?: string;
  maximumUsd?: string | null;
  fixedUsd?: string;
  defaultFeePayer?: FeePayer;
}): Promise<void> {
  assertAdmin(params.adminTelegramId);
  const current = await prisma.feeSetting.findFirst({ orderBy: { updatedAt: "desc" } });
  const percentage =
    params.percentage !== undefined
      ? new Prisma.Decimal(params.percentage)
      : (current?.percentage ?? new Prisma.Decimal("0.01"));
  const minimumUsd =
    params.minimumUsd !== undefined
      ? new Prisma.Decimal(params.minimumUsd)
      : (current?.minimumUsd ?? new Prisma.Decimal("1"));
  let maximumUsd: Prisma.Decimal | null =
    current?.maximumUsd === null || current?.maximumUsd === undefined ? null : current.maximumUsd;
  if (params.maximumUsd === null) maximumUsd = null;
  else if (params.maximumUsd !== undefined) maximumUsd = new Prisma.Decimal(params.maximumUsd);
  const fixedUsd =
    params.fixedUsd !== undefined
      ? new Prisma.Decimal(params.fixedUsd)
      : (current?.fixedUsd ?? new Prisma.Decimal("0"));
  const defaultFeePayer = params.defaultFeePayer ?? current?.defaultFeePayer ?? "split";

  if (current) {
    await prisma.feeSetting.update({
      where: { id: current.id },
      data: { percentage, minimumUsd, maximumUsd, fixedUsd, defaultFeePayer },
    });
  } else {
    await prisma.feeSetting.create({
      data: { percentage, minimumUsd, maximumUsd, fixedUsd, defaultFeePayer },
    });
  }
  await logAdminAction({ adminTelegramId: params.adminTelegramId, action: "fee_settings_update" });
}

export async function exportDealsCsv(): Promise<string> {
  const deals = await prisma.deal.findMany({ orderBy: { createdAt: "desc" }, take: 5000 });
  const header = [
    "dealCode",
    "status",
    "amount",
    "currency",
    "network",
    "createdAt",
  ].join(",");
  const lines = deals.map((d) =>
    [d.dealCode, d.status, d.amount.toString(), d.currency, d.network, d.createdAt.toISOString()]
      .map((c) => `"${String(c).replaceAll('"', '""')}"`)
      .join(","),
  );
  return [header, ...lines].join("\n");
}

export async function adminApproveHighValueDeal(dealCode: string, adminTelegramId: bigint): Promise<void> {
  assertAdmin(adminTelegramId);
  const deal = await prisma.deal.findUnique({ where: { dealCode } });
  if (!deal) throw new NotFoundError("Deal not found");
  if (deal.highValueApproval !== "pending") {
    throw new StateMachineError("This deal is not waiting for high-value approval");
  }
  await prisma.deal.update({
    where: { id: deal.id, version: deal.version },
    data: { highValueApproval: "approved", version: { increment: 1 } },
  });
  await logAdminAction({
    adminTelegramId,
    action: "high_value_approved",
    dealId: deal.id,
    metadata: { dealCode },
  });
  await appendDealTimelineEvent({
    dealId: deal.id,
    actorId: null,
    eventType: "admin_decision",
    metadata: { action: "high_value_approved", admin: adminTelegramId.toString() },
  });
  await ensurePaymentInstruction(deal.id);
}

export async function adminRejectHighValueDeal(dealCode: string, adminTelegramId: bigint): Promise<void> {
  assertAdmin(adminTelegramId);
  const deal = await prisma.deal.findUnique({ where: { dealCode } });
  if (!deal) throw new NotFoundError("Deal not found");
  if (deal.highValueApproval !== "pending") {
    throw new StateMachineError("This deal is not waiting for high-value approval");
  }
  await prisma.deal.update({
    where: { id: deal.id, version: deal.version },
    data: { highValueApproval: "rejected", version: { increment: 1 } },
  });
  await logAdminAction({
    adminTelegramId,
    action: "high_value_rejected",
    dealId: deal.id,
    metadata: { dealCode },
  });
  await appendDealTimelineEvent({
    dealId: deal.id,
    actorId: null,
    eventType: "admin_decision",
    metadata: { action: "high_value_rejected", admin: adminTelegramId.toString() },
  });
}

export async function adminUpdateManualPayout(params: {
  dealId: string;
  adminTelegramId: bigint;
  status: PayoutStatus;
  txHash?: string | null;
  adminNote?: string | null;
}): Promise<void> {
  assertAdmin(params.adminTelegramId);
  const p = await prisma.payout.findFirst({
    where: { dealId: params.dealId },
    orderBy: { createdAt: "desc" },
  });
  if (!p) throw new NotFoundError("No payout record for this deal");
  const deal = await prisma.deal.findUnique({
    where: { id: params.dealId },
    include: { seller: true },
  });
  const notify = params.status === "completed";
  const nextTx = params.txHash !== undefined ? params.txHash : p.txHash;
  const nextNote = params.adminNote !== undefined ? params.adminNote : p.adminNote;
  if (params.status === "completed") {
    const hasTx = Boolean(nextTx?.trim());
    const hasNote = Boolean(nextNote?.trim());
    if (!hasTx && !hasNote) {
      throw new ValidationError(
        "Marking a payout completed requires a non-empty transaction hash or admin note (on-chain id or ops explanation).",
      );
    }
  }
  await prisma.payout.update({
    where: { id: p.id },
    data: {
      status: params.status,
      ...(params.txHash !== undefined ? { txHash: params.txHash } : {}),
      ...(params.adminNote !== undefined ? { adminNote: params.adminNote } : {}),
      ...(notify && !p.sellerNotifiedSentAt ? { sellerNotifiedSentAt: new Date() } : {}),
    },
  });
  await logAdminAction({
    adminTelegramId: params.adminTelegramId,
    action: "manual_payout_update",
    dealId: params.dealId,
    metadata: { payoutId: p.id, status: params.status },
  });
  if (notify && deal?.seller && !p.sellerNotifiedSentAt) {
    await enqueueDealParticipantNotify({
      targetTelegramId: deal.seller.telegramId,
      text: [
        "OGMP MM — Payout update",
        "",
        `Deal ${deal.dealCode}: payout was marked as sent by operations.`,
        params.txHash ? `Tx: ${params.txHash}` : "",
        params.adminNote ? `Note: ${params.adminNote}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      buttons: [[{ text: "View deal", cb: `d:v:${deal.dealCode}` }]],
    });
  }
}
