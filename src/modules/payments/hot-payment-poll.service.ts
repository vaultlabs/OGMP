import { getRedis } from "../../utils/redis.js";

const HOT_SET = "ogmp:hotpay:deals";

/** Poll these deals every few seconds until funded or TTL. */
export async function markDealHotPaymentPoll(dealId: string): Promise<void> {
  const r = getRedis();
  await r.sadd(HOT_SET, dealId);
  await r.expire(HOT_SET, 86400);
}

export async function unmarkDealHotPaymentPoll(dealId: string): Promise<void> {
  await getRedis().srem(HOT_SET, dealId);
}

export async function listHotPaymentDealIds(): Promise<string[]> {
  return getRedis().smembers(HOT_SET);
}

/** Drop Redis hot-poll IDs that no longer exist or are past payment (e.g. after DB reset). */
export async function pruneStaleHotPaymentDeals(): Promise<number> {
  const ids = await listHotPaymentDealIds();
  if (!ids.length) return 0;
  const { prisma } = await import("../../db/prisma.js");
  const live = await prisma.deal.findMany({
    where: {
      id: { in: ids },
      status: { in: ["waiting_payment", "payment_detected"] },
    },
    select: { id: true },
  });
  const liveSet = new Set(live.map((d) => d.id));
  let pruned = 0;
  for (const id of ids) {
    if (!liveSet.has(id)) {
      await unmarkDealHotPaymentPoll(id);
      pruned++;
    }
  }
  return pruned;
}
