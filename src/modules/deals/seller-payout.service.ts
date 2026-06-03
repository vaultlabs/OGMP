import type { Deal } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { ForbiddenError, NotFoundError, StateMachineError } from "../../utils/errors.js";
import { appendDealTimelineEvent } from "../dealTimeline/timeline.service.js";
import { maskPayoutAddress } from "../../services/payout.service.js";
import { getRedis } from "../../utils/redis.js";

const DRAFT_KEY = (telegramId: bigint) => `ogmp:spw:draft:${telegramId.toString()}`;
const DRAFT_TTL_SEC = 1800;

export function sellerPayoutReady(
  deal: Pick<Deal, "sellerPayoutAddress" | "sellerPayoutConfirmedAt">,
): boolean {
  return Boolean(deal.sellerPayoutAddress?.trim() && deal.sellerPayoutConfirmedAt);
}

export async function setSellerPayoutDraft(
  telegramId: bigint,
  dealCode: string,
  address: string,
): Promise<void> {
  const r = getRedis();
  await r.set(
    DRAFT_KEY(telegramId),
    JSON.stringify({ dealCode: dealCode.trim(), address: address.trim() }),
    "EX",
    DRAFT_TTL_SEC,
  );
}

export async function getSellerPayoutDraft(
  telegramId: bigint,
): Promise<{ dealCode: string; address: string } | null> {
  const r = getRedis();
  const raw = await r.get(DRAFT_KEY(telegramId));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { dealCode?: string; address?: string };
    if (typeof p.dealCode === "string" && typeof p.address === "string" && p.address.length >= 8) {
      return { dealCode: p.dealCode, address: p.address };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function clearSellerPayoutDraft(telegramId: bigint): Promise<void> {
  const r = getRedis();
  await r.del(DRAFT_KEY(telegramId));
}

export async function confirmSellerPayoutForDeal(
  sellerUserId: string,
  dealId: string,
  address: string,
): Promise<Deal> {
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal) throw new NotFoundError("Deal not found");
  if (deal.sellerId !== sellerUserId) throw new ForbiddenError("Only the seller can set payout wallet");
  const addr = address.trim();
  if (addr.length < 8 || addr.length > 256) {
    throw new StateMachineError("Invalid wallet address");
  }
  const terminal = ["released", "refunded", "cancelled"];
  if (terminal.includes(deal.status)) {
    throw new StateMachineError("Deal is already closed");
  }

  const updated = await prisma.deal.update({
    where: { id: dealId, version: deal.version },
    data: {
      sellerPayoutAddress: addr,
      sellerPayoutConfirmedAt: new Date(),
      version: { increment: 1 },
    },
  });

  const existing = await prisma.savedWallet.findFirst({
    where: { userId: sellerUserId, currency: deal.currency, network: deal.network, address: addr },
  });
  if (!existing) {
    await prisma.savedWallet.create({
      data: {
        userId: sellerUserId,
        kind: `${deal.currency}_${deal.network}`,
        currency: deal.currency,
        network: deal.network,
        address: addr,
        label: "Deal payout",
      },
    });
  }

  await appendDealTimelineEvent({
    dealId,
    actorId: sellerUserId,
    eventType: "seller_payout_wallet_set",
    metadata: { address: maskPayoutAddress(addr) },
  });

  return updated;
}

export async function listSellerSavedWalletsForDeal(
  sellerUserId: string,
  currency: string,
  network: string,
): Promise<{ id: string; address: string; label: string | null }[]> {
  const rows = await prisma.savedWallet.findMany({
    where: { userId: sellerUserId, currency, network },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  return rows.map((r) => ({ id: r.id, address: r.address, label: r.label }));
}
