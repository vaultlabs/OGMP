import type { Deal, DealStatus, ParticipantRole, Prisma, User } from "@prisma/client";
import { Prisma as PrismaNs } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { allocateDealCode } from "../../services/deal-code.service.js";
import { computeFeeBreakdown, getActiveFeeSettings } from "../../services/fee.service.js";
import { assertValidDealTransition } from "../../services/escrow-state-machine.js";
import { applyDealDisputedStats, applyDealReleasedStats } from "../../services/reputation.service.js";
import { onDealReleasedSideEffects } from "../../services/deal-completion-notify.service.js";
import { writeAuditLog } from "../../services/audit.service.js";
import { appendDealTimelineEvent } from "../dealTimeline/timeline.service.js";
import { enqueueDealParticipantNotify } from "../notifications/notificationQueue.service.js";
import { ConflictError, ForbiddenError, NotFoundError, StateMachineError } from "../../utils/errors.js";
import { paymentAddressSetupFailedUserMessage } from "../../utils/user-facing-errors.js";
import { getPaymentProvider } from "../../payments/index.js";
import { loadConfig } from "../../config/index.js";
import { isAutoReleaseEnabled } from "../../services/bot-settings.service.js";
import { acquireLock, releaseLock } from "../../utils/redis.js";
import { logger } from "../../utils/logger.js";
import { assertDealLimitsForCreate } from "./deal-limits.service.js";
import { resolveInitialHighValueApprovalKey } from "../../services/high-value-deal.service.js";
import { appendSuspiciousFlag, flagHighValueNewUser, scanSharedPayoutAddress } from "../../services/suspicion-flags.service.js";
import {
  getJoinExpiryHours,
  getRequirePayoutDoubleConfirm,
  getTermsExpiryHours,
} from "../../services/platform-settings.service.js";
import type { createDealSchema } from "./deal.validation.js";
import type { z } from "zod";

export type CreateDealInput = z.infer<typeof createDealSchema>;

function assertNotFrozen(deal: Deal): void {
  if (deal.frozen) {
    throw new StateMachineError("This deal is frozen while admin review is in progress.");
  }
}

function hasActiveSuspiciousFlags(flags: unknown): boolean {
  return Array.isArray(flags) && flags.length > 0;
}

function inviteToken(): string {
  return randomBytes(16).toString("base64url");
}

export async function findDealForUser(dealId: string, userId: string): Promise<Deal | null> {
  const deal = await prisma.deal.findFirst({
    where: {
      id: dealId,
      OR: [{ buyerId: userId }, { sellerId: userId }, { creatorId: userId }],
    },
  });
  return deal;
}

export async function createDeal(creator: User, input: CreateDealInput): Promise<Deal> {
  const year = new Date().getUTCFullYear();
  const dealCode = await allocateDealCode(year);
  const feeRow = await getActiveFeeSettings();
  const dealAmount = new PrismaNs.Decimal(input.amount);
  await assertDealLimitsForCreate({
    creatorId: creator.id,
    amount: dealAmount,
    currency: input.currency,
  });
  const joinExpiresAt = new Date(Date.now() + (await getJoinExpiryHours()) * 3600 * 1000);
  const highValueApproval = await resolveInitialHighValueApprovalKey(dealAmount);
  const amountUsdForCaps = dealAmount; // TODO: FX rate service for non-USD notional caps
  const breakdown = computeFeeBreakdown({
    dealAmount,
    amountUsdForCaps,
    networkFeeEstimate: new PrismaNs.Decimal(0),
    feePayer: input.feePayer,
    percentage: feeRow.percentage,
    minimumUsd: feeRow.minimumUsd,
    maximumUsd: feeRow.maximumUsd,
    fixedUsd: feeRow.fixedUsd,
  });

  const creatorRole: ParticipantRole = input.creatorRole;
  const buyerId = creatorRole === "buyer" ? creator.id : null;
  const sellerId = creatorRole === "seller" ? creator.id : null;

  const deal = await prisma.$transaction(async (tx) => {
    const d = await tx.deal.create({
      data: {
        dealCode,
        inviteToken: inviteToken(),
        creatorId: creator.id,
        creatorRole,
        buyerId,
        sellerId,
        title: input.title,
        description: input.description,
        dealTerms: input.dealTerms,
        deliveryInstructions: input.deliveryInstructions,
        proofRequirements: input.proofRequirements,
        amount: dealAmount,
        currency: input.currency,
        network: input.network,
        feeAmount: breakdown.escrowFee,
        feePayer: input.feePayer,
        networkFeeEstimate: breakdown.networkFeeEstimate,
        sellerPayoutAddress: input.sellerPayoutAddress,
        buyerRefundAddress: input.buyerRefundAddress,
        status: "pending_acceptance",
        joinExpiresAt,
        highValueApproval,
      },
    });
    await tx.dealParticipant.create({
      data: { dealId: d.id, userId: creator.id, role: creatorRole },
    });
    return d;
  });
  await writeAuditLog({
    eventType: "deal_created",
    userId: creator.id,
    dealId: deal.id,
    metadata: { dealCode: deal.dealCode },
  });
  await appendDealTimelineEvent({
    dealId: deal.id,
    actorId: creator.id,
    eventType: "deal_created",
    metadata: { dealCode: deal.dealCode },
  });
  void flagHighValueNewUser(creator.id, deal.amount.toString()).catch(() => {});
  if (input.sellerPayoutAddress) {
    void scanSharedPayoutAddress(input.sellerPayoutAddress).catch(() => {});
  }
  return deal;
}

export async function joinDealByToken(joiner: User, token: string): Promise<Deal> {
  const deal = await prisma.deal.findUnique({ where: { inviteToken: token } });
  if (!deal) throw new NotFoundError("Deal not found");
  if (deal.status !== "pending_acceptance") {
    throw new ConflictError("Deal is not accepting new participants");
  }
  if (joiner.id === deal.creatorId) {
    throw new ConflictError("You already belong to this deal");
  }
  const neededRole: ParticipantRole = deal.creatorRole === "buyer" ? "seller" : "buyer";
  const buyerId = neededRole === "buyer" ? joiner.id : deal.buyerId;
  const sellerId = neededRole === "seller" ? joiner.id : deal.sellerId;
  if (!buyerId || !sellerId) throw new StateMachineError("Could not resolve buyer/seller");
  const termsExpiresAt = new Date(Date.now() + (await getTermsExpiryHours()) * 3600 * 1000);

  await prisma.$transaction(async (tx) => {
    await tx.dealParticipant.upsert({
      where: { dealId_userId: { dealId: deal.id, userId: joiner.id } },
      create: { dealId: deal.id, userId: joiner.id, role: neededRole },
      update: {},
    });
    await tx.deal.update({
      where: { id: deal.id, version: deal.version },
      data: {
        buyerId,
        sellerId,
        termsExpiresAt,
        version: { increment: 1 },
      },
    });
  });
  await writeAuditLog({
    eventType: "deal_joined",
    userId: joiner.id,
    dealId: deal.id,
    metadata: { role: neededRole },
  });
  await appendDealTimelineEvent({
    dealId: deal.id,
    actorId: joiner.id,
    eventType: neededRole === "buyer" ? "buyer_joined" : "seller_joined",
    metadata: { role: neededRole },
  });
  const updated = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
  return updated;
}

export async function acceptTerms(userId: string, dealId: string): Promise<Deal> {
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal) throw new NotFoundError("Deal not found");
  if (deal.buyerId !== userId && deal.sellerId !== userId) {
    throw new ForbiddenError("You are not a participant");
  }
  const lockKey = `lock:deal:${dealId}:accept`;
  const token = randomBytes(8).toString("hex");
  if (!(await acquireLock(lockKey, 5000, token))) {
    throw new ConflictError("Please wait and try again");
  }
  try {
    const participant = await prisma.dealParticipant.findUnique({
      where: { dealId_userId: { dealId, userId } },
    });
    if (!participant) throw new ForbiddenError();
    await prisma.dealParticipant.update({
      where: { dealId_userId: { dealId, userId } },
      data: { termsAcceptedAt: new Date() },
    });
    const parts = await prisma.dealParticipant.findMany({ where: { dealId } });
    const allAccepted = parts.length === 2 && parts.every((p) => p.termsAcceptedAt);
    let nextStatus: DealStatus = deal.status;
    if (allAccepted && deal.status === "pending_acceptance") {
      assertValidDealTransition(deal.status, "waiting_payment");
      nextStatus = "waiting_payment";
    }
    const updated = await prisma.deal.update({
      where: { id: dealId, version: deal.version },
      data: { status: nextStatus, version: { increment: 1 } },
    });
    await writeAuditLog({
      eventType: "terms_accepted",
      userId,
      dealId,
      metadata: { allAccepted },
    });
    await appendDealTimelineEvent({
      dealId,
      actorId: userId,
      eventType:
        participant.role === "buyer" ? "terms_accepted_by_buyer" : "terms_accepted_by_seller",
      metadata: { allAccepted },
    });
    if (updated.status === "waiting_payment") {
      const hvPending = deal.highValueApproval === "pending";
      try {
        const res = await ensurePaymentInstruction(updated.id);
        if (hvPending && !res.paymentAddress) {
          const full = await prisma.deal.findUnique({
            where: { id: dealId },
            include: { buyer: true, seller: true },
          });
          const line =
            "This deal requires admin approval before payment can be accepted.";
          if (full?.buyer) {
            await enqueueDealParticipantNotify({
              targetTelegramId: full.buyer.telegramId,
              text: ["OGMP MM — High value review", "", line, "", `Deal: ${full.dealCode}`].join("\n"),
              buttons: [[{ text: "View deal", cb: `d:v:${full.dealCode}` }]],
            });
          }
          if (full?.seller) {
            await enqueueDealParticipantNotify({
              targetTelegramId: full.seller.telegramId,
              text: ["OGMP MM — High value review", "", line, "", `Deal: ${full.dealCode}`].join("\n"),
              buttons: [[{ text: "View deal", cb: `d:v:${full.dealCode}` }]],
            });
          }
        }
        return res;
      } catch (e) {
        const errStr = String(e);
        const payCfg = loadConfig().PAYMENT_PROVIDER;
        logger.error("payment_instruction_failed", { dealId, err: errStr, PAYMENT_PROVIDER: payCfg });
        if (payCfg === "nowpayments" && errStr.includes("not implemented")) {
          logger.error("payment_instruction_stale_nowpayments_build", {
            help:
              "This message only appears on outdated builds. Run: git pull origin main && npm run dev. After restart, logs should include payment_provider_selected with impl nowpayments_api_v1_2026_02 before any deal uses NOWPayments.",
          });
        }
        try {
          const d = await prisma.deal.findUnique({
            where: { id: dealId },
            include: { buyer: true, seller: true },
          });
          if (d) {
            const text = paymentAddressSetupFailedUserMessage(d.dealCode);
            const buttons = [[{ text: "View deal", cb: `d:v:${d.dealCode}` }]];
            if (d.buyer) {
              await enqueueDealParticipantNotify({
                targetTelegramId: d.buyer.telegramId,
                text,
                buttons,
              });
            }
            if (d.seller) {
              await enqueueDealParticipantNotify({
                targetTelegramId: d.seller.telegramId,
                text,
                buttons,
              });
            }
          }
        } catch (notifyErr) {
          logger.error("payment_instruction_notify_failed", { dealId, err: String(notifyErr) });
        }
        return updated;
      }
    }
    return updated;
  } finally {
    await releaseLock(lockKey, token);
  }
}

export async function ensurePaymentInstruction(dealId: string): Promise<Deal> {
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal) throw new NotFoundError("Deal not found");
  if (deal.status !== "waiting_payment") return deal;
  if (deal.paymentAddress) return deal;
  if (deal.highValueApproval === "pending") {
    logger.info("payment_address_deferred_high_value", { dealId });
    return deal;
  }
  if (deal.highValueApproval === "rejected") {
    return deal;
  }

  const coin = await prisma.supportedCoin.findFirst({
    where: { currency: deal.currency, network: deal.network, enabled: true },
  });
  if (!coin) throw new StateMachineError("This coin/network is not enabled");

  const provider = getPaymentProvider();
  const expectedAmount = deal.amount.toString();
  const addr = await provider.createPaymentAddress(deal, expectedAmount, deal.currency, deal.network);
  const expires = new Date(Date.now() + coin.paymentTimeoutMinutes * 60 * 1000);
  const idempotencyKey = `${provider.name}:${deal.id}:${deal.version}`;

  await prisma.$transaction(async (tx) => {
    await tx.payment.create({
      data: {
        dealId,
        provider: provider.name,
        idempotencyKey,
        address: addr.address,
        reference: addr.reference,
        expectedAmount: deal.amount,
        currency: deal.currency,
        network: deal.network,
        status: "pending",
        requiredConfirmations: addr.requiredConfirmations ?? coin.confirmationsRequired,
        expiresAt: expires,
      },
    });
    await tx.deal.update({
      where: { id: dealId, version: deal.version },
      data: {
        paymentAddress: addr.address,
        paymentProviderRef: addr.providerRef,
        paymentExpiresAt: expires,
        version: { increment: 1 },
      },
    });
  });
  await writeAuditLog({
    eventType: "payment_address_generated",
    dealId,
    metadata: { provider: provider.name },
  });
  await appendDealTimelineEvent({
    dealId,
    eventType: "payment_address_generated",
    metadata: { provider: provider.name },
  });
  return prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
}

export async function transitionDealStatus(
  dealId: string,
  from: DealStatus,
  to: DealStatus,
  extra?: Prisma.DealUpdateInput,
): Promise<Deal> {
  assertValidDealTransition(from, to);
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal) throw new NotFoundError("Deal not found");
  if (deal.status !== from) {
    throw new StateMachineError(`Deal is ${deal.status}, expected ${from}`);
  }
  try {
    return await prisma.deal.update({
      where: { id: dealId, version: deal.version },
      data: {
        ...extra,
        status: to,
        version: { increment: 1 },
      },
    });
  } catch (e) {
    logger.error("deal_transition_failed", { dealId, from, to, err: String(e) });
    throw new ConflictError("Concurrent update — please retry");
  }
}

export async function markDelivered(sellerId: string, dealId: string): Promise<Deal> {
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal) throw new NotFoundError("Deal not found");
  assertNotFrozen(deal);
  if (deal.sellerId !== sellerId) throw new ForbiddenError("Only the seller can mark delivered");
  if (deal.status !== "funded") throw new StateMachineError("Invalid state for delivery");
  const next = await transitionDealStatus(dealId, "funded", "item_delivered", {
    deliveredAt: new Date(),
  });
  await writeAuditLog({ eventType: "delivery_marked", userId: sellerId, dealId });
  await appendDealTimelineEvent({
    dealId,
    actorId: sellerId,
    eventType: "seller_marked_delivered",
    metadata: {},
  });
  if (deal.buyerId) {
    const bu = await prisma.user.findUnique({ where: { id: deal.buyerId } });
    if (bu) {
      await enqueueDealParticipantNotify({
        targetTelegramId: bu.telegramId,
        text: [
          "OGMP MM — Seller marked delivered",
          "",
          `Deal: ${deal.dealCode}`,
          "",
          "Next: review everything, then confirm release or open a dispute.",
        ].join("\n"),
        buttons: [
          [
            { text: "View deal", cb: `d:v:${deal.dealCode}` },
            { text: "Confirm received", cb: `d:rel:${deal.dealCode}` },
          ],
        ],
      });
    }
  }
  return next;
}

export async function buyerConfirmRelease(buyerId: string, dealId: string): Promise<Deal> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true, seller: true },
  });
  if (!deal) throw new NotFoundError("Deal not found");
  assertNotFrozen(deal);
  if (deal.buyerId !== buyerId) throw new ForbiddenError("Only the buyer can confirm release");
  if (deal.status !== "item_delivered") throw new StateMachineError("Invalid state for release confirm");
  if (!deal.sellerPayoutAddress?.trim()) {
    throw new StateMachineError(
      "Seller payout wallet is missing. Ask the seller to set a payout address before you confirm release.",
    );
  }
  if ((await getRequirePayoutDoubleConfirm()) && !deal.sellerPayoutConfirmedAt) {
    throw new StateMachineError(
      "Seller must complete payout wallet checks on the deal card before you can confirm release.",
    );
  }
  const suspiciousHold =
    hasActiveSuspiciousFlags(deal.buyer?.suspiciousFlags) ||
    hasActiveSuspiciousFlags(deal.seller?.suspiciousFlags);
  const auto = (await isAutoReleaseEnabled()) && !suspiciousHold;
  if (auto) {
    await transitionDealStatus(dealId, "item_delivered", "buyer_confirmed");
    await transitionDealStatus(dealId, "buyer_confirmed", "released", { releasedAt: new Date() });
    await writeAuditLog({ eventType: "funds_released", userId: buyerId, dealId, metadata: { mode: "auto" } });
    await appendDealTimelineEvent({
      dealId,
      actorId: buyerId,
      eventType: "buyer_confirmed",
      metadata: { autoRelease: true },
    });
    await appendDealTimelineEvent({
      dealId,
      actorId: buyerId,
      eventType: "funds_released",
      metadata: { mode: "auto" },
    });
    const released = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    await applyDealReleasedStats(released);
    await onDealReleasedSideEffects(dealId);
    if (deal.sellerId) {
      const su = await prisma.user.findUnique({ where: { id: deal.sellerId } });
      if (su) {
        await enqueueDealParticipantNotify({
          targetTelegramId: su.telegramId,
          text: [
            "OGMP MM — Funds released",
            "",
            `Deal: ${deal.dealCode}`,
            "",
            "Buyer confirmed — escrow release completed (auto).",
          ].join("\n"),
          buttons: [[{ text: "View deal", cb: `d:v:${deal.dealCode}` }]],
        });
      }
    }
    return released;
  }
  await transitionDealStatus(dealId, "item_delivered", "buyer_confirmed");
  await transitionDealStatus(dealId, "buyer_confirmed", "release_requested");
  await writeAuditLog({ eventType: "release_requested", userId: buyerId, dealId });
  await appendDealTimelineEvent({
    dealId,
    actorId: buyerId,
    eventType: "buyer_confirmed",
    metadata: { autoRelease: false, suspiciousHold },
  });
  await appendDealTimelineEvent({
    dealId,
    actorId: buyerId,
    eventType: "release_requested",
    metadata: {},
  });
  if (deal.sellerId) {
    const su = await prisma.user.findUnique({ where: { id: deal.sellerId } });
    if (su) {
      await enqueueDealParticipantNotify({
        targetTelegramId: su.telegramId,
        text: [
          "OGMP MM — Buyer confirmed",
          "",
          `Deal: ${deal.dealCode}`,
          "",
          "Release is pending admin approval.",
        ].join("\n"),
        buttons: [[{ text: "View deal", cb: `d:v:${deal.dealCode}` }]],
      });
    }
  }
  return prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
}

export async function openDispute(openerId: string, dealId: string): Promise<void> {
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal) throw new NotFoundError("Deal not found");
  assertNotFrozen(deal);
  if (deal.buyerId !== openerId && deal.sellerId !== openerId) {
    throw new ForbiddenError();
  }
  const parts = await prisma.dealParticipant.count({ where: { dealId } });
  if (parts < 2) throw new StateMachineError("Both parties must join before a dispute can be opened");
  const from = deal.status;
  assertValidDealTransition(from, "disputed");
  await prisma.$transaction(async (tx) => {
    await tx.dispute.create({
      data: { dealId, openedById: openerId, status: "open" },
    });
    await tx.deal.update({
      where: { id: dealId, version: deal.version },
      data: { status: "disputed", disputedAt: new Date(), version: { increment: 1 } },
    });
  });
  await writeAuditLog({ eventType: "dispute_opened", userId: openerId, dealId });
  const d = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
  await appendDealTimelineEvent({
    dealId,
    actorId: openerId,
    eventType: "dispute_opened",
    metadata: { source: "in_bot_dispute" },
  });
  await applyDealDisputedStats(d);
  const disputeOpens = await prisma.dispute.count({ where: { openedById: openerId } });
  if (disputeOpens >= 3) {
    void appendSuspiciousFlag(openerId, "FREQUENT_DISPUTES", `opened_count=${disputeOpens}`).catch(() => {});
  }
  const notifyId = openerId === deal.buyerId ? deal.sellerId : deal.buyerId;
  if (notifyId) {
    const u = await prisma.user.findUnique({ where: { id: notifyId } });
    if (u) {
      await enqueueDealParticipantNotify({
        targetTelegramId: u.telegramId,
        text: `⚖ A case was opened for admin review on deal ${deal.dealCode}.`,
      });
    }
  }
}

export async function cancelDeal(requesterId: string, dealId: string): Promise<Deal> {
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal) throw new NotFoundError("Deal not found");
  assertNotFrozen(deal);
  if (deal.buyerId !== requesterId && deal.sellerId !== requesterId) {
    throw new ForbiddenError();
  }
  if (deal.status !== "pending_acceptance" && deal.status !== "waiting_payment") {
    throw new StateMachineError("This deal can no longer be cancelled by participants");
  }
  const pay = await prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } });
  const paymentInFlight =
    deal.status === "waiting_payment" && pay != null && pay.status !== "pending";
  if (paymentInFlight) {
    throw new StateMachineError(
      "After payment activity starts, cancellation must go through Case Review (Open Case) so an admin can decide.",
    );
  }
  const isBuyer = deal.buyerId === requesterId;
  const nextBuyerReq = isBuyer ? true : deal.cancelRequestedByBuyer;
  const nextSellerReq = !isBuyer ? true : deal.cancelRequestedBySeller;
  if (nextBuyerReq && nextSellerReq) {
    assertValidDealTransition(deal.status, "cancelled");
    const updated = await prisma.deal.update({
      where: { id: dealId, version: deal.version },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelRequestedByBuyer: false,
        cancelRequestedBySeller: false,
        version: { increment: 1 },
      },
    });
    await writeAuditLog({ eventType: "deal_cancelled", userId: requesterId, dealId });
    await appendDealTimelineEvent({
      dealId,
      actorId: requesterId,
      eventType: "deal_closed",
      metadata: { reason: "mutual_cancel", buyerReq: nextBuyerReq, sellerReq: nextSellerReq },
    });
    return updated;
  }
  return prisma.deal.update({
    where: { id: dealId, version: deal.version },
    data: {
      cancelRequestedByBuyer: nextBuyerReq,
      cancelRequestedBySeller: nextSellerReq,
      version: { increment: 1 },
    },
  });
}
