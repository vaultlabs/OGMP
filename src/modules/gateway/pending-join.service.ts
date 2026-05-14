import { getRedis } from "../../utils/redis.js";

const KEY = (telegramId: bigint) => `ogmp:gw:pending_join:${telegramId.toString()}`;
const TTL_SEC = 86400 * 7;

export async function setPendingJoinInvite(telegramId: bigint, token: string): Promise<void> {
  const r = getRedis();
  await r.set(KEY(telegramId), token, "EX", TTL_SEC);
}

export async function getPendingJoinInvite(telegramId: bigint): Promise<string | null> {
  const r = getRedis();
  return r.get(KEY(telegramId));
}

export async function clearPendingJoinInvite(telegramId: bigint): Promise<void> {
  const r = getRedis();
  await r.del(KEY(telegramId));
}
