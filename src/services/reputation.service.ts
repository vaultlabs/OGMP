import type { Deal } from "@prisma/client";
import { prisma } from "../db/prisma.js";

export async function applyDealReleasedStats(deal: Deal): Promise<void> {
  if (!deal.buyerId || !deal.sellerId) return;
  await prisma.$transaction([
    prisma.user.update({
      where: { id: deal.buyerId },
      data: {
        completedDeals: { increment: 1 },
        totalVolumeUsd: { increment: deal.amount },
      },
    }),
    prisma.user.update({
      where: { id: deal.sellerId },
      data: {
        completedDeals: { increment: 1 },
        totalVolumeUsd: { increment: deal.amount },
      },
    }),
  ]);
}

export async function applyDealDisputedStats(deal: Deal): Promise<void> {
  if (!deal.buyerId || !deal.sellerId) return;
  await prisma.$transaction([
    prisma.user.update({
      where: { id: deal.buyerId },
      data: { disputedDeals: { increment: 1 } },
    }),
    prisma.user.update({
      where: { id: deal.sellerId },
      data: { disputedDeals: { increment: 1 } },
    }),
  ]);
}

export async function applyReview(params: {
  dealId: string;
  fromUserId: string;
  toUserId: string;
  stars: number;
  text?: string;
}): Promise<void> {
  await prisma.review.create({
    data: {
      dealId: params.dealId,
      fromUserId: params.fromUserId,
      toUserId: params.toUserId,
      stars: params.stars,
      text: params.text,
    },
  });
  const agg = await prisma.review.aggregate({
    where: { toUserId: params.toUserId },
    _avg: { stars: true },
  });
  const avg = agg._avg.stars ?? params.stars;
  await prisma.user.update({
    where: { id: params.toUserId },
    data: { reputationScore: avg },
  });
}
