import type { Context, NextFunction } from "grammy";
import { isAdminTelegramId } from "../../config/index.js";
import { findUserByTelegramId } from "../../modules/users/user.service.js";
import { getEffectiveGatewayConfig } from "../../modules/gateway/gateway-settings.service.js";
import { setPendingJoinInvite } from "../../modules/gateway/pending-join.service.js";
import {
  GATEWAY_ACCESS_REQUIRED_SHORT,
  gatewayAccessKeyboard,
} from "../../modules/gateway/gateway-messages.js";
import { MAIN_UI_PARSE_MODE } from "./trust-copy.js";

/** Commands and callbacks allowed before gateway access. */
export function isGatewayExempt(ctx: Context): boolean {
  if (!ctx.from) return true;
  const tid = BigInt(ctx.from.id);
  if (isAdminTelegramId(tid)) return true;

  if (ctx.callbackQuery?.data) {
    const d = ctx.callbackQuery.data;
    if (d.startsWith("gw:")) return true;
    if (d.startsWith("a:") && isAdminTelegramId(tid)) return true;
    if (d === "m:terms") return true;
  }

  const text = ctx.message?.text?.trim();
  if (!text) return false;

  if (/^\/start\b/i.test(text)) return true;
  if (/^\/help\b/i.test(text)) return true;
  if (/^\/terms\b/i.test(text)) return true;
  if (/^\/admin\b/i.test(text)) return true;

  if (isAdminTelegramId(tid) && /^\/admin_/i.test(text)) return true;

  return false;
}

export async function gatewayAccessMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  if (!ctx.from) {
    await next();
    return;
  }
  const tid = BigInt(ctx.from.id);
  if (isAdminTelegramId(tid)) {
    await next();
    return;
  }

  const eff = await getEffectiveGatewayConfig();
  if (!eff.requireGatewayJoin) {
    await next();
    return;
  }

  if (isGatewayExempt(ctx)) {
    await next();
    return;
  }

  const u = await findUserByTelegramId(tid);
  const joinCmd = ctx.message?.text?.match(/^\/join(?:@\w+)?\s+(\S+)/i);
  if (joinCmd?.[1]) await setPendingJoinInvite(tid, joinCmd[1]);

  if (!u) {
    if (!eff.requireGatewayJoin) {
      await next();
      return;
    }
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "Join the gateway first.", show_alert: true });
    }
    await ctx.reply(GATEWAY_ACCESS_REQUIRED_SHORT, {
      parse_mode: MAIN_UI_PARSE_MODE,
      reply_markup: gatewayAccessKeyboard(eff.joinUrl),
    });
    return;
  }
  if (u.gatewayAcceptedAt) {
    await next();
    return;
  }

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: "Join the gateway first.", show_alert: true });
  }
  await ctx.reply(GATEWAY_ACCESS_REQUIRED_SHORT, {
    parse_mode: MAIN_UI_PARSE_MODE,
    reply_markup: gatewayAccessKeyboard(eff.joinUrl),
  });
}
