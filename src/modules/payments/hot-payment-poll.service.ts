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
