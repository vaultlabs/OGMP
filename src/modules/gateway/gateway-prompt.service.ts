import type { Context } from "grammy";
import { getRedis } from "../../utils/redis.js";
import { getEffectiveGatewayConfig } from "./gateway-settings.service.js";
import { GATEWAY_ACCESS_PROMPT, gatewayAccessKeyboard } from "./gateway-messages.js";

const DEDUP_TTL_SEC = 120;
const dedupKey = (telegramId: bigint) => `ogmp:gw_prompt:${telegramId.toString()}`;

/** Send gateway join prompt once per cooldown — stops duplicate /start + middleware spam. */
export async function replyGatewayAccessPrompt(ctx: Context, telegramId: bigint): Promise<boolean> {
  const r = getRedis();
  try {
    if (await r.get(dedupKey(telegramId))) return false;
    await r.set(dedupKey(telegramId), "1", "EX", DEDUP_TTL_SEC);
  } catch {
    /* continue without dedup */
  }

  const eff = await getEffectiveGatewayConfig();
  await ctx.reply(GATEWAY_ACCESS_PROMPT, {
    parse_mode: "HTML",
    reply_markup: gatewayAccessKeyboard(eff.joinUrl),
  });
  return true;
}

export async function clearGatewayPromptDedup(telegramId: bigint): Promise<void> {
  try {
    await getRedis().del(dedupKey(telegramId));
  } catch {
    /* ignore */
  }
}
