import { Api, InlineKeyboard } from "grammy";
import { getAdminTelegramIds, getMainBotToken, loadConfig } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import { loadReportForAdmin } from "./report.service.js";

export async function notifyAdminsReportSubmitted(reportId: string): Promise<void> {
  const rep = await loadReportForAdmin(reportId);
  if (!rep) return;
  const api = new Api(getMainBotToken());
  const cfg = loadConfig();
  const kb = new InlineKeyboard().text("View deal", `d:v:${rep.deal.dealCode}`);
  const reportUser = cfg.REPORT_BOT_USERNAME?.trim().replace(/^@/, "");
  if (reportUser) {
    kb.row().url("Open Report bot", `https://t.me/${reportUser}`);
  }
  const text = [
    "🚨 *New report submitted*",
    `Report: \`${rep.reportCode}\``,
    `Deal: \`${rep.deal.dealCode}\` (${rep.deal.status})`,
    `Reporter TG: \`${rep.reporter.telegramId}\` @${rep.reporter.username ?? "n/a"}`,
    `Role: ${rep.reporterRole}`,
    `Category: ${rep.category}`,
    `Amount: ${rep.deal.amount} ${rep.deal.currency} (${rep.deal.network})`,
    reportUser ? `_Use /reports in @${reportUser} to manage this report._` : "_Set REPORT_BOT_USERNAME for a direct link._",
  ].join("\n");
  for (const adminId of getAdminTelegramIds()) {
    try {
      await api.sendMessage(adminId, text, { parse_mode: "Markdown", reply_markup: kb });
    } catch (e) {
      logger.error("admin_notify_failed", { adminId, err: String(e) });
    }
  }
}
