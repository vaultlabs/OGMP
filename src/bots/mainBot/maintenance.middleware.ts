import type { Context, NextFunction } from "grammy";
import { isAdminTelegramId } from "../../config/index.js";
import { isMaintenanceEnabled } from "../../services/platform-settings.service.js";
import { formatMaintenanceHtml, MAIN_UI_PARSE_MODE } from "./maintenance-copy.js";

function isCreateDealIntent(ctx: Context): boolean {
  if (ctx.callbackQuery?.data === "m:create" || ctx.callbackQuery?.data === "w:go") return true;
  const t = ctx.message?.text?.trim() ?? "";
  if (/^\/create\b/i.test(t)) return true;
  return false;
}

/** Blocks starting new deals for non-admins while maintenance is on. */
export async function maintenanceMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  if (!ctx.from) {
    await next();
    return;
  }
  const tid = BigInt(ctx.from.id);
  if (isAdminTelegramId(tid)) {
    await next();
    return;
  }
  if (!(await isMaintenanceEnabled())) {
    await next();
    return;
  }
  if (!isCreateDealIntent(ctx)) {
    await next();
    return;
  }
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: "Maintenance mode — try later.", show_alert: true });
  }
  await ctx.reply(await formatMaintenanceHtml(), { parse_mode: MAIN_UI_PARSE_MODE });
}
