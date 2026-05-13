import { getRedis } from "../../utils/redis.js";

const key = (telegramId: bigint) => `ogmp:deal_room:${telegramId.toString()}`;

export async function setActiveDealRoom(telegramId: bigint, dealId: string): Promise<void> {
  const r = getRedis();
  await r.set(key(telegramId), dealId, "EX", 3600);
}

export async function getActiveDealRoom(telegramId: bigint): Promise<string | null> {
  const r = getRedis();
  return r.get(key(telegramId));
}

export async function clearActiveDealRoom(telegramId: bigint): Promise<void> {
  const r = getRedis();
  await r.del(key(telegramId));
}
