import { getRedis } from "../../utils/redis.js";

const key = (telegramId: bigint) => `ogmp:review_text_wait:${telegramId.toString()}`;

/** After a star rating, optionally accept one text message to attach to the same review. */
export async function setReviewTextWait(telegramId: bigint, dealId: string): Promise<void> {
  await getRedis().set(key(telegramId), dealId, "EX", 600);
}

export async function peekReviewTextWait(telegramId: bigint): Promise<string | null> {
  return getRedis().get(key(telegramId));
}

export async function clearReviewTextWait(telegramId: bigint): Promise<void> {
  await getRedis().del(key(telegramId));
}
