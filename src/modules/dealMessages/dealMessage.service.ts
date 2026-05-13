import type { DealMessageType } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { assertFileAllowed } from "../../utils/file-safety.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../utils/errors.js";
import { appendDealTimelineEvent } from "../dealTimeline/timeline.service.js";
import { enqueueDealParticipantNotify } from "../notifications/notificationQueue.service.js";

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
    },
  });
  await appendDealTimelineEvent({
    dealId: params.dealId,
    actorId: params.senderUserId,
    eventType: "file_or_proof_uploaded",
    metadata: { messageType: params.messageType, fileName: params.fileName },
  });
  const other =
    deal.buyerId === params.senderUserId ? deal.sellerId : deal.buyerId;
  if (other) {
    const otherUser = await prisma.user.findUnique({ where: { id: other } });
    if (otherUser) {
      await enqueueDealParticipantNotify({
        targetTelegramId: otherUser.telegramId,
        text: `📎 Your counterparty posted an update in deal *${deal.dealCode}* (deal room).`,
      });
    }
  }
}

export async function listDealMessages(dealId: string, requesterUserId: string) {
  const deal = await prisma.deal.findFirst({
    where: {
      id: dealId,
      OR: [{ buyerId: requesterUserId }, { sellerId: requesterUserId }, { creatorId: requesterUserId }],
    },
  });
  if (!deal) throw new ForbiddenError();
  return prisma.dealMessage.findMany({
    where: { dealId },
    orderBy: { createdAt: "asc" },
    include: { sender: true },
  });
}
