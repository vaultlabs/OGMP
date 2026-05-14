import type { DealMessageType } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { assertFileAllowed } from "../../utils/file-safety.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../utils/errors.js";
import { appendDealTimelineEvent } from "../dealTimeline/timeline.service.js";
import { enqueueDealParticipantNotify } from "../notifications/notificationQueue.service.js";

/** Buyer may receive Telegram file identifiers only after on-chain payment is confirmed (deal funded). */
export function buyerMayReceiveDealRoomFiles(deal: { fundedAt: Date | null }): boolean {
  return deal.fundedAt != null;
}

export type DealMessageWithSender = Awaited<ReturnType<typeof listDealMessages>>[number];

export async function saveDealRoomMessage(params: {
  dealId: string;
  senderUserId: string;
  messageType: DealMessageType;
  text: string;
  telegramFileId?: string | null;
  telegramFileUniqueId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  caption?: string | null;
  lockedForBuyer?: boolean;
  deliveryAsset?: boolean;
  skipCounterpartyNotification?: boolean;
}): Promise<void> {
  const deal = await prisma.deal.findUnique({ where: { id: params.dealId } });
  if (!deal) throw new NotFoundError("Deal not found");
  if (deal.frozen) {
    throw new ValidationError(
      "This deal is frozen. Use the OGMP MM REPORT bot to add evidence to your open report, or wait for admin instructions.",
    );
  }
  const allowed =
    deal.buyerId === params.senderUserId || deal.sellerId === params.senderUserId;
  if (!allowed) throw new ForbiddenError("Only buyer and seller can post in the deal room.");
  assertFileAllowed({
    fileName: params.fileName,
    mimeType: params.mimeType,
    fileSize: params.fileSize,
  });
  await prisma.dealMessage.create({
    data: {
      dealId: params.dealId,
      senderId: params.senderUserId,
      messageType: params.messageType,
      text: params.text,
      telegramFileId: params.telegramFileId ?? undefined,
      telegramFileUniqueId: params.telegramFileUniqueId ?? undefined,
      fileName: params.fileName ?? undefined,
      mimeType: params.mimeType ?? undefined,
      fileSize: params.fileSize ?? undefined,
      caption: params.caption ?? undefined,
      lockedForBuyer: params.lockedForBuyer ?? false,
      deliveryAsset: params.deliveryAsset ?? false,
    },
  });
  await prisma.deal.update({
    where: { id: params.dealId },
    data: { lastActivityAt: new Date() },
  });
  await appendDealTimelineEvent({
    dealId: params.dealId,
    actorId: params.senderUserId,
    eventType: "file_or_proof_uploaded",
    metadata: { messageType: params.messageType, fileName: params.fileName, locked: params.lockedForBuyer },
  });
  if (params.skipCounterpartyNotification) return;
  const other =
    deal.buyerId === params.senderUserId ? deal.sellerId : deal.buyerId;
  if (other) {
    const otherUser = await prisma.user.findUnique({ where: { id: other } });
    if (otherUser) {
      await enqueueDealParticipantNotify({
        targetTelegramId: otherUser.telegramId,
        text: `Update on deal ${deal.dealCode} (deal room).`,
        buttons: [[{ text: "View deal", cb: `d:v:${deal.dealCode}` }]],
      });
    }
  }
}

/** Buyer must not receive Telegram file identifiers while seller delivery is still payment-locked. */
export async function listDealMessages(dealId: string, requesterUserId: string) {
  const deal = await prisma.deal.findFirst({
    where: {
      id: dealId,
      OR: [{ buyerId: requesterUserId }, { sellerId: requesterUserId }, { creatorId: requesterUserId }],
    },
  });
  if (!deal) throw new ForbiddenError();
  const rows = await prisma.dealMessage.findMany({
    where: { dealId },
    orderBy: { createdAt: "asc" },
    include: { sender: true },
  });
  const isBuyer = deal.buyerId === requesterUserId;
  const buyerUnlocked = buyerMayReceiveDealRoomFiles(deal);
  return rows.map((m) => {
    const hasTelegramFile = Boolean(m.telegramFileId || m.telegramFileUniqueId);
    if (isBuyer && hasTelegramFile && (!buyerUnlocked || m.lockedForBuyer)) {
      return {
        ...m,
        telegramFileId: null,
        telegramFileUniqueId: null,
      };
    }
    return m;
  });
}

export async function countLockedDeliveryMessages(dealId: string): Promise<number> {
  return prisma.dealMessage.count({ where: { dealId, lockedForBuyer: true } });
}

export async function listDeliveryAssetMessagesForDeal(dealId: string) {
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal?.sellerId || !buyerMayReceiveDealRoomFiles(deal)) return [];
  const primary = await prisma.dealMessage.findMany({
    where: { dealId, deliveryAsset: true, telegramFileId: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  if (primary.length) return primary;
  return prisma.dealMessage.findMany({
    where: { dealId, senderId: deal.sellerId, telegramFileId: { not: null } },
    orderBy: { createdAt: "asc" },
  });
}
