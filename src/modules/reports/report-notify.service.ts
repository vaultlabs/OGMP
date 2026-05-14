import { Api, InlineKeyboard } from "grammy";
import { getAdminTelegramIds, getMainBotToken, getReportBotToken, loadConfig } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import { escapeTelegramMarkdownLegacy } from "../../utils/telegram-html.js";
import { loadReportForAdmin } from "./report.service.js";

function fmtParty(u: { telegramId: bigint; username: string | null; firstName: string | null } | null): string {
  if (!u) return "\\_none\\_";
  const un = u.username ? `@${escapeTelegramMarkdownLegacy(u.username)}` : "no @";
  return `${escapeTelegramMarkdownLegacy(u.firstName ?? "User")} (${un}, id \`${u.telegramId.toString()}\`)`;
}

function buildAdminReportActionKeyboard(rep: { id: string }, dealCode: string): InlineKeyboard {
  const cfg = loadConfig();
  const reportTok = getReportBotToken();
  const mainUser = cfg.BOT_PUBLIC_USERNAME?.trim().replace(/^@/, "");
  const kb = new InlineKeyboard();
  if (reportTok) {
    kb.text("View report", `rpa:v:${rep.id}`)
      .text("View evidence", `rpa:ev:${rep.id}`)
      .row();
    if (mainUser) {
      kb.url("Open main bot", `https://t.me/${mainUser}`);
    }
    kb.text("Mark under review", `rpa:under:${rep.id}`)
      .text("Request proof", `rpa:more:${rep.id}`)
      .row()
      .text("Close report", `rpa:cl:${rep.id}`);
  } else {
    kb.text("View deal (main bot)", `d:v:${dealCode}`);
    const ru = cfg.REPORT_BOT_USERNAME?.trim().replace(/^@/, "");
    if (ru) kb.row().url("Open Report bot", `https://t.me/${ru}`);
  }
  return kb;
}

export async function notifyAdminsReportSubmitted(reportId: string): Promise<void> {
  const rep = await loadReportForAdmin(reportId);
  if (!rep) return;
  const api = new Api(getReportBotToken() ?? getMainBotToken());
  const kb = buildAdminReportActionKeyboard(rep, rep.deal.dealCode);
  const summary = escapeTelegramMarkdownLegacy(
    `${rep.description.slice(0, 400)}${rep.description.length > 400 ? "…" : ""}`,
  );
  const text = [
    "🚨 *New report submitted*",
    `Report: \`${rep.reportCode}\` · id \`${rep.id}\``,
    `Deal: \`${rep.deal.dealCode}\` · status \`${rep.deal.status}\``,
    `Reporter TG: \`${rep.reporter.telegramId}\` @${escapeTelegramMarkdownLegacy(rep.reporter.username ?? "n/a")}`,
    `Role: ${rep.reporterRole}`,
    `Category: ${escapeTelegramMarkdownLegacy(rep.category)}`,
    `Summary: ${summary}`,
    `Amount: *${rep.deal.amount.toString()} ${rep.deal.currency}* · network *${rep.deal.network}*`,
    `Buyer: ${fmtParty(rep.deal.buyer)}`,
    `Seller: ${fmtParty(rep.deal.seller)}`,
    "_Use buttons above (same chat). File IDs stay in DB — do not open unknown executables._",
  ].join("\n");
  for (const adminId of getAdminTelegramIds()) {
    try {
      await api.sendMessage(adminId, text, { parse_mode: "Markdown", reply_markup: kb });
    } catch (e) {
      logger.error("admin_notify_failed", { adminId, err: String(e) });
    }
  }
}

export async function notifyAdminsReportMoreEvidence(reportId: string): Promise<void> {
  const rep = await loadReportForAdmin(reportId);
  if (!rep) return;
  const api = new Api(getReportBotToken() ?? getMainBotToken());
  const kb = buildAdminReportActionKeyboard(rep, rep.deal.dealCode);
  const text = [
    "📎 *Additional report evidence uploaded*",
    `Report: \`${rep.reportCode}\` · id \`${rep.id}\``,
    `Deal: \`${rep.deal.dealCode}\` · status \`${rep.deal.status}\``,
    `Evidence files in DB: ${rep.evidence.length}`,
    "_Metadata only in “View evidence” — do not open unknown executables._",
  ].join("\n");
  for (const adminId of getAdminTelegramIds()) {
    try {
      await api.sendMessage(adminId, text, { parse_mode: "Markdown", reply_markup: kb });
    } catch (e) {
      logger.error("admin_notify_more_evidence_failed", { adminId, err: String(e) });
    }
  }
}
