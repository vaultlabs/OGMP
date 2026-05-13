import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";

export async function appendDealTimelineEvent(params: {
  dealId: string;
  eventType: string;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await prisma.$transaction([
    prisma.dealTimelineEvent.create({
      data: {
        dealId: params.dealId,
        actorId: params.actorId ?? undefined,
        eventType: params.eventType,
        metadataJson: params.metadata as Prisma.InputJsonValue | undefined,
      },
    }),
    prisma.deal.update({
      where: { id: params.dealId },
      data: { lastActivityAt: new Date() },
    }),
  ]);
}
