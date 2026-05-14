import { Bot, Context, InlineKeyboard } from "grammy";
import { getReportBotToken, isAdminTelegramId, loadConfig } from "../../config/index.js";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { getRedis } from "../../utils/redis.js";
import { upsertTelegramUser, findUserByTelegramId } from "../../modules/users/user.service.js";
import {
  validateReportStartToken,
  markReportSessionUsed,
} from "../../modules/reports/report-session.service.js";
import {
  appendReportEvidence,
  createDraftReport,
  submitReportAndFreezeDeal,
  loadReportForAdmin,
  addReportAdminNote,
  findSubmittedReviewReportForDeal,
  adminResolveReport,
} from "../../modules/reports/report.service.js";
import { assertFileAllowed } from "../../utils/file-safety.js";
import { replyTextForCaughtError } from "../../utils/user-facing-errors.js";
import {
  TELEGRAM_FOLDER_UPLOAD_EXPLANATION_PLAIN,
  formatUploadContinuationPlain,
} from "../../utils/upload-guidance.js";
import type { ParticipantRole, ReportCategory } from "@prisma/client";
import { adminForceRefund, adminForceRelease } from "../../modules/admin/admin.service.js";
import { buildAdminEvidenceDigest } from "../../modules/reports/evidence-view.service.js";
import { enqueueAdminReportMoreEvidence, enqueueDealParticipantNotify } from "../../modules/notifications/notificationQueue.service.js";
import { REPORT_BOT_HOME_PAGE } from "../mainBot/trust-copy.js";

const WIZ = (id: bigint) => `ogmp:report_wiz:${id.toString()}`;

type Wiz =
  | { step: "role"; sessionId: string; dealId: string; userId: string }
  | { step: "category"; sessionId: string; dealId: string; userId: string; role: ParticipantRole }
  | { step: "describe"; sessionId: string; dealId: string; userId: string; role: ParticipantRole; category: ReportCategory }
  | { step: "collect"; reportId: string; dealId: string }
  | { step: "append_collect"; reportId: string; dealId: string };

async function getWiz(id: bigint): Promise<Wiz | null> {
  const raw = await getRedis().get(WIZ(id));
  return raw ? (JSON.parse(raw) as Wiz) : null;
}

async function setWiz(id: bigint, w: Wiz, ttl = 3600): Promise<void> {
  await getRedis().set(WIZ(id), JSON.stringify(w), "EX", ttl);
}

async function clearWiz(id: bigint): Promise<void> {
  await getRedis().del(WIZ(id));
}

function startArg(ctx: Context): string | undefined {
  const t = ctx.message?.text;
  if (!t) return;
  const m = /^\/start(?:@\w+)?(?:\s+(.+))?$/i.exec(t);
  return m?.[1]?.trim();
}

function commandArgs(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean).slice(1);
}

function reportAdminDetailKb(reportId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Evidence digest", `rpa:ev:${reportId}`)
    .text("Admin review", `rpa:under:${reportId}`)
    .row()
    .text("Request evidence", `rpa:more:${reportId}`)
    .text("Close case", `rpa:cl:${reportId}`)
    .row()
    .text("Release", `rpa:rel:${reportId}`)
    .text("Refund", `rpa:ref:${reportId}`)
    .row()
    .text("Admin note", `rpa:note:${reportId}`);
}

async function sendActiveReportList(ctx: Context): Promise<void> {
  const reps = await prisma.report.findMany({
    where: { status: { in: ["submitted", "under_review", "waiting_for_buyer", "waiting_for_seller"] } },
    take: 20,
    orderBy: { createdAt: "desc" },
  });
  const kb = new InlineKeyboard();
  for (const r of reps) kb.text(r.reportCode, `rpa:v:${r.id}`).row();
  await ctx.reply(reps.length ? "Open cases:" : "No open cases.", { reply_markup: kb });
}

export function createReportBot(): Bot<Context> {
  const token = getReportBotToken();
  if (!token) {
    throw new Error("OGMP_MM_REPORT_BOT_TOKEN is not set");
  }
  const bot = new Bot<Context>(token);

  bot.catch((err) => {
    logger.error("report_bot_error", { err: String(err.error) });
    const ctx = err.ctx;
    if (ctx?.reply) {
      void ctx
        .reply(
          [
            "Something went wrong in the REPORT bot.",
            "",
            "What to try: send /start again, or open your case from the main escrow bot. If it repeats, wait a few minutes.",
            "",
            "Never paste API keys, tokens, or wallet seeds here.",
          ].join("\n"),
        )
        .catch(() => {});
    }
  });

  bot.command("start", async (ctx) => {
    if (!ctx.from) return;
    const arg = startArg(ctx);
    if (!arg?.startsWith("report_")) {
      const cfg = loadConfig();
      const kb = new InlineKeyboard();
      const main = cfg.BOT_PUBLIC_USERNAME?.trim().replace(/^@+/, "");
      if (main) kb.url("Start Case", `https://t.me/${main}`);
      else kb.text("Start Case", "r:hint:main");
      kb.row().text("Add Evidence", "r:hint:evidence").row();
      const sup = cfg.SUPPORT_USERNAME?.trim().replace(/^@+/, "");
      if (sup) kb.url("Contact Support", `https://t.me/${sup}`);
      else kb.text("Contact Support", "r:hint:sup");
      await ctx.reply(REPORT_BOT_HOME_PAGE, { reply_markup: kb });
      return;
    }
    const raw = arg.slice("report_".length);
    try {
      const v = await validateReportStartToken(raw, BigInt(ctx.from.id));
      await upsertTelegramUser({
        telegramId: BigInt(ctx.from.id),
        username: ctx.from.username,
        firstName: ctx.from.first_name,
      });
      const u = await findUserByTelegramId(BigInt(ctx.from.id));
      if (!u) {
        await ctx.reply("Could not sync user.");
        return;
      }
      const deal = await prisma.deal.findUnique({ where: { id: v.dealId } });
      if (!deal || (deal.buyerId !== u.id && deal.sellerId !== u.id)) {
        await ctx.reply("This secure link is not valid for your account on this deal.");
        return;
      }
      const active = await findSubmittedReviewReportForDeal(v.dealId);
      if (active) {
        await markReportSessionUsed(v.sessionId);
        await setWiz(BigInt(ctx.from.id), {
          step: "append_collect",
          reportId: active.id,
          dealId: v.dealId,
        });
        await ctx.reply(
          [
            `⚖ Deal already has an open report (\`${active.reportCode}\`, ${active.status}).`,
            "Upload *additional evidence* (photos, videos, documents, .zip/.rar/.7z).",
            "",
            TELEGRAM_FOLDER_UPLOAD_EXPLANATION_PLAIN,
            "",
            "Send `/append_done` when you are finished so admins are notified.",
          ].join("\n"),
          { parse_mode: "Markdown" },
        );
        return;
      }
      await setWiz(BigInt(ctx.from.id), {
        step: "role",
        sessionId: v.sessionId,
        dealId: v.dealId,
        userId: v.userId,
      });
      await ctx.reply("Who are you in this deal?", {
        reply_markup: new InlineKeyboard()
          .text("Buyer", "rp:role:buyer")
          .text("Seller", "rp:role:seller"),
      });
    } catch (e) {
      await ctx.reply(replyTextForCaughtError(e));
    }
  });

  bot.callbackQuery(/^r:hint:main$/, async (ctx) => {
    await ctx.answerCallbackQuery({
      text: "Open the main OGMP MM bot and use Report from your deal. Set BOT_PUBLIC_USERNAME on the server for a quick link button.",
      show_alert: true,
    });
  });

  bot.callbackQuery(/^r:hint:evidence$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Add evidence when this bot asks during an open case. Clear screenshots and files help admins complete case review faster.",
    );
  });

  bot.callbackQuery(/^r:hint:sup$/, async (ctx) => {
    await ctx.answerCallbackQuery({
      text: "Set SUPPORT_USERNAME in server config for a Contact Support link, or reach staff through your OGMP community.",
      show_alert: true,
    });
  });

  bot.callbackQuery(/^rp:role:(buyer|seller)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const role = ctx.match[1] as ParticipantRole;
    const w = await getWiz(BigInt(ctx.from.id));
    if (!w || w.step !== "role") {
      await ctx.answerCallbackQuery({ text: "Session expired", show_alert: true });
      return;
    }
    await setWiz(BigInt(ctx.from.id), {
      step: "category",
      sessionId: w.sessionId,
      dealId: w.dealId,
      userId: w.userId,
      role,
    });
    await ctx.answerCallbackQuery();
    await ctx.reply("What is the issue?", {
      reply_markup: new InlineKeyboard()
        .text("Seller did not deliver", "rp:cat:seller_no_delivery")
        .row()
        .text("Buyer refusing to confirm", "rp:cat:buyer_no_confirm")
        .text("Wrong item/service", "rp:cat:wrong_item")
        .row()
        .text("Scam attempt", "rp:cat:scam_attempt")
        .text("Payment issue", "rp:cat:payment_issue")
        .row()
        .text("Fake proof", "rp:cat:fake_proof")
        .text("Other", "rp:cat:other"),
    });
  });

  bot.callbackQuery(/^rp:cat:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const cat = ctx.match[1] as ReportCategory;
    const w = await getWiz(BigInt(ctx.from.id));
    if (!w || w.step !== "category") {
      await ctx.answerCallbackQuery({ text: "Session expired", show_alert: true });
      return;
    }
    await setWiz(BigInt(ctx.from.id), {
      step: "describe",
      sessionId: w.sessionId,
      dealId: w.dealId,
      userId: w.userId,
      role: w.role,
      category: cat,
    });
    await ctx.answerCallbackQuery();
    await ctx.reply("Explain what happened (send one text message).");
  });

  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from || ctx.message.text.startsWith("/")) return next();
    const w = await getWiz(BigInt(ctx.from.id));
    if (!w) return next();
    if (w.step === "append_collect") {
      const u = await findUserByTelegramId(BigInt(ctx.from.id));
      if (!u) return;
      const body = ctx.message.text.trim().slice(0, 8000);
      if (!body) return next();
      await appendReportEvidence({
        reportId: w.reportId,
        uploaderId: u.id,
        evidenceType: "text",
        text: body,
      });
      await ctx.reply(
        [
          "✅ Text saved as evidence.",
          "",
          formatUploadContinuationPlain("type /append_done when you are finished"),
        ].join("\n"),
      );
      return;
    }
    if (w.step !== "describe") return next();
    const desc = ctx.message.text.trim().slice(0, 8000);
    const { id: reportId } = await createDraftReport({
      dealId: w.dealId,
      reporterId: w.userId,
      reporterRole: w.role,
      category: w.category,
      description: desc,
    });
    await markReportSessionUsed(w.sessionId);
    await setWiz(BigInt(ctx.from.id), { step: "collect", reportId, dealId: w.dealId });
    await ctx.reply(
      [
        "✅ Report draft created. Upload screenshots, videos, documents, or archives.",
        "",
        TELEGRAM_FOLDER_UPLOAD_EXPLANATION_PLAIN,
        "",
        "Send /report_done when you are finished.",
      ].join("\n"),
    );
  });

  async function saveEvidence(ctx: Context, type: string, parts: Record<string, unknown>) {
    if (!ctx.from) return;
    const w = await getWiz(BigInt(ctx.from.id));
    if (!w || (w.step !== "collect" && w.step !== "append_collect")) return;
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (!u) return;
    await appendReportEvidence({
      reportId: w.reportId,
      uploaderId: u.id,
      evidenceType: type,
      text: "",
      telegramFileId: parts.fileId as string | undefined,
      telegramFileUniqueId: parts.fileUniqueId as string | undefined,
      fileName: parts.fileName as string | undefined,
      mimeType: parts.mimeType as string | undefined,
      fileSize: parts.fileSize as number | undefined,
      caption: parts.caption as string | undefined,
    });
    const finish = w.step === "collect" ? "/report_done" : "/append_done";
    await ctx.reply(
      [
        "✅ Evidence attached.",
        "",
        formatUploadContinuationPlain(`type ${finish} when you are finished`),
      ].join("\n"),
    );
  }

  bot.on("message:photo", async (ctx) => {
    if (!ctx.from) return;
    const p = ctx.message.photo?.slice(-1)[0];
    try {
      assertFileAllowed({
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        fileSize: p?.file_size,
      });
    } catch (e) {
      await ctx.reply(replyTextForCaughtError(e));
      return;
    }
    await saveEvidence(ctx, "photo", {
      fileId: p?.file_id,
      fileUniqueId: p?.file_unique_id,
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      fileSize: p?.file_size,
      caption: ctx.message.caption,
    });
  });

  bot.on("message:document", async (ctx) => {
    if (!ctx.from) return;
    if (!("document" in ctx.message)) return;
    const doc = ctx.message.document;
    if (!doc) return;
    try {
      assertFileAllowed({
        fileName: doc.file_name,
        mimeType: doc.mime_type,
        fileSize: doc.file_size,
      });
    } catch (e) {
      await ctx.reply(replyTextForCaughtError(e));
      return;
    }
    await saveEvidence(ctx, "document", {
      fileId: doc.file_id,
      fileUniqueId: doc.file_unique_id,
      fileName: doc.file_name ?? "document",
      mimeType: doc.mime_type,
      fileSize: doc.file_size,
      caption: ctx.message.caption,
    });
  });

  bot.on("message:video", async (ctx) => {
    if (!ctx.from) return;
    const v = ctx.message.video;
    if (!v) return;
    try {
      assertFileAllowed({
        fileName: v.file_name ?? "video.mp4",
        mimeType: v.mime_type,
        fileSize: v.file_size,
      });
    } catch (e) {
      await ctx.reply(replyTextForCaughtError(e));
      return;
    }
    await saveEvidence(ctx, "video", {
      fileId: v.file_id,
      fileUniqueId: v.file_unique_id,
      fileName: v.file_name ?? "video.mp4",
      mimeType: v.mime_type,
      fileSize: v.file_size,
      caption: ctx.message.caption,
    });
  });

  bot.command("report_done", async (ctx) => {
    if (!ctx.from) return;
    const w = await getWiz(BigInt(ctx.from.id));
    if (!w || w.step !== "collect") {
      await ctx.reply("No active report collection.");
      return;
    }
    try {
      await submitReportAndFreezeDeal(w.reportId);
      await clearWiz(BigInt(ctx.from.id));
      await ctx.reply(
        "✅ Report submitted. The deal is frozen and admins have been notified. Do not send funds outside official instructions.",
      );
    } catch (e) {
      await ctx.reply(replyTextForCaughtError(e));
    }
  });

  bot.command("append_done", async (ctx) => {
    if (!ctx.from) return;
    const w = await getWiz(BigInt(ctx.from.id));
    if (!w || w.step !== "append_collect") {
      await ctx.reply("No append-evidence session. Open a fresh secure link from the main OGMP MM bot (Report deal).");
      return;
    }
    await clearWiz(BigInt(ctx.from.id));
    await enqueueAdminReportMoreEvidence(w.reportId);
    await ctx.reply("✅ Thanks — admins were notified that new evidence was added.");
  });

  bot.command("admin", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) {
      await ctx.reply("Forbidden");
      return;
    }
    await ctx.reply("Report admin:", {
      reply_markup: new InlineKeyboard()
        .text("Open reports", "rpa:list")
        .text("Help", "rpa:help"),
    });
  });

  bot.callbackQuery(/^rpa:list$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await sendActiveReportList(ctx);
  });

  bot.callbackQuery(/^rpa:v:(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id)) || !ctx.match) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    const rep = await loadReportForAdmin(ctx.match[1]!);
    if (!rep) {
      await ctx.answerCallbackQuery({ text: "Not found", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const lines = [
      `*${rep.reportCode}* (${rep.status})`,
      `Deal: ${rep.deal.dealCode} · ${rep.deal.status}`,
      `Reporter: ${rep.reporterRole} · ${rep.description.slice(0, 200)}`,
      `Evidence files: ${rep.evidence.length}`,
    ];
    await ctx.reply(lines.join("\n"), {
      parse_mode: "Markdown",
      reply_markup: reportAdminDetailKb(rep.id),
    });
  });

  bot.callbackQuery(/^rpa:ev:(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id)) || !ctx.match) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    const id = ctx.match[1]!;
    const rep = await loadReportForAdmin(id);
    if (!rep) {
      await ctx.answerCallbackQuery({ text: "Not found", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const digest = await buildAdminEvidenceDigest({ dealId: rep.dealId, reportId: rep.id });
    const max = 3900;
    for (let i = 0; i < digest.length; i += max) {
      await ctx.reply(digest.slice(i, i + max));
    }
  });

  bot.callbackQuery(/^rpa:under:(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id)) || !ctx.match) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    const id = ctx.match[1]!;
    const rep = await prisma.report.findUnique({ where: { id } });
    if (!rep) {
      await ctx.answerCallbackQuery({ text: "Not found", show_alert: true });
      return;
    }
    await prisma.report.update({
      where: { id },
      data: { status: "under_review", updatedAt: new Date() },
    });
    await addReportAdminNote(id, BigInt(ctx.from.id), "Marked under review (report bot)");
    await ctx.answerCallbackQuery({ text: "Status: under_review" });
    await ctx.reply(`Report ${rep.reportCode} marked under review.`);
  });

  bot.callbackQuery(/^rpa:more:(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id)) || !ctx.match) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    const id = ctx.match[1]!;
    const rep = await loadReportForAdmin(id);
    if (!rep) {
      await ctx.answerCallbackQuery({ text: "Not found", show_alert: true });
      return;
    }
    await prisma.report.update({
      where: { id },
      data: { status: "waiting_for_buyer", updatedAt: new Date() },
    });
    await addReportAdminNote(id, BigInt(ctx.from.id), "Admin requested more proof (report bot)");
    const line = `⚖ Admin requested *more proof* on deal \`${rep.deal.dealCode}\` (report \`${rep.reportCode}\`). Use **Report deal** in the main bot to open OGMP MM REPORT and finish with /append_done after uploads.`;
    for (const u of [rep.deal.buyer, rep.deal.seller]) {
      if (!u) continue;
      await enqueueDealParticipantNotify({
        targetTelegramId: u.telegramId,
        text: line,
        parseMode: "Markdown",
      });
    }
    await ctx.answerCallbackQuery({ text: "Parties notified" });
    await ctx.reply("Report set to waiting_for_buyer; buyer and seller were notified.");
  });

  bot.callbackQuery(/^rpa:cl:(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id)) || !ctx.match) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    const id = ctx.match[1]!;
    try {
      await adminResolveReport({
        reportId: id,
        adminTelegramId: BigInt(ctx.from.id),
        newStatus: "closed",
        note: "Report closed by admin (report bot)",
        dealAction: "unfreeze",
      });
      await ctx.answerCallbackQuery({ text: "Closed" });
      await ctx.reply("Report closed and deal unfrozen (if it was frozen).");
    } catch (e) {
      logger.error("report_bot_admin_close_failed", { err: String(e) });
      await ctx.answerCallbackQuery({ text: "Could not complete that. Try again or send /start.", show_alert: true });
    }
  });

  bot.callbackQuery(/^rpa:help$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "*Report bot admin*",
        "",
        "Commands: `/reports` · `/openreports` (same list) · `/deal DEAL_CODE` · `/user TELEGRAM_ID`",
        "",
        "Callbacks: View evidence (metadata digest), Mark under review, Request proof (notifies parties), Close report (unfreezes deal), Release / Refund.",
        "",
        "_Evidence digest lists filenames only — Telegram file\\_ids stay in the database._",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  bot.command("reports", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) {
      await ctx.reply("Forbidden");
      return;
    }
    await sendActiveReportList(ctx);
  });

  bot.command("openreports", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) {
      await ctx.reply("Forbidden");
      return;
    }
    await sendActiveReportList(ctx);
  });

  bot.command("deal", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) {
      await ctx.reply("Forbidden");
      return;
    }
    const code = commandArgs(ctx.message?.text ?? "")[0];
    if (!code) {
      await ctx.reply("Usage: /deal DEAL_CODE");
      return;
    }
    const deal = await prisma.deal.findUnique({ where: { dealCode: code } });
    if (!deal) {
      await ctx.reply("Deal not found.");
      return;
    }
    const reps = await prisma.report.findMany({
      where: { dealId: deal.id },
      orderBy: { createdAt: "desc" },
      take: 12,
    });
    const kb = new InlineKeyboard();
    for (const r of reps) kb.text(`${r.reportCode} (${r.status})`, `rpa:v:${r.id}`).row();
    await ctx.reply(
      reps.length
        ? `Reports for deal ${deal.dealCode} (${deal.status}):`
        : `No reports for deal ${deal.dealCode} (${deal.status}).`,
      { reply_markup: reps.length ? kb : undefined },
    );
  });

  bot.command("user", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) {
      await ctx.reply("Forbidden");
      return;
    }
    const raw = commandArgs(ctx.message?.text ?? "")[0];
    if (!raw) {
      await ctx.reply("Usage: /user TELEGRAM_ID");
      return;
    }
    let tg: bigint;
    try {
      tg = BigInt(raw);
    } catch {
      await ctx.reply("Invalid Telegram id.");
      return;
    }
    const user = await prisma.user.findUnique({
      where: { telegramId: tg },
      include: {
        dealsAsBuyer: { orderBy: { createdAt: "desc" }, take: 5, select: { dealCode: true, status: true } },
        dealsAsSeller: { orderBy: { createdAt: "desc" }, take: 5, select: { dealCode: true, status: true } },
      },
    });
    if (!user) {
      await ctx.reply("User not found.");
      return;
    }
    const buyerLines = user.dealsAsBuyer.map((d) => `• ${d.dealCode} (${d.status})`).join("\n") || "—";
    const sellerLines = user.dealsAsSeller.map((d) => `• ${d.dealCode} (${d.status})`).join("\n") || "—";
    await ctx.reply(
      [
        `User \`${user.telegramId.toString()}\` @${user.username ?? "n/a"}`,
        `Banned: ${user.banned}`,
        `Recent as buyer:\n${buyerLines}`,
        `Recent as seller:\n${sellerLines}`,
      ].join("\n\n"),
      { parse_mode: "Markdown" },
    );
  });

  bot.callbackQuery(/^rpa:rel:(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id)) || !ctx.match) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    const id = ctx.match[1]!;
    const rep = await prisma.report.findUnique({ where: { id } });
    if (!rep) {
      await ctx.answerCallbackQuery({ text: "Not found", show_alert: true });
      return;
    }
    await adminForceRelease(rep.dealId, BigInt(ctx.from.id));
    await addReportAdminNote(id, BigInt(ctx.from.id), "Released via report bot");
    await prisma.report.update({
      where: { id },
      data: { status: "resolved_release", resolvedAt: new Date() },
    });
    await prisma.deal.update({
      where: { id: rep.dealId },
      data: { frozen: false, frozenAt: null, frozenReason: null, activeReportId: null },
    });
    await ctx.answerCallbackQuery({ text: "Released" });
    await ctx.reply("Deal released; report marked resolved_release.");
  });

  bot.callbackQuery(/^rpa:ref:(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id)) || !ctx.match) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    const id = ctx.match[1]!;
    const rep = await prisma.report.findUnique({ where: { id } });
    if (!rep) {
      await ctx.answerCallbackQuery({ text: "Not found", show_alert: true });
      return;
    }
    await adminForceRefund(rep.dealId, BigInt(ctx.from.id));
    await addReportAdminNote(id, BigInt(ctx.from.id), "Refunded via report bot");
    await prisma.report.update({
      where: { id },
      data: { status: "resolved_refund", resolvedAt: new Date() },
    });
    await prisma.deal.update({
      where: { id: rep.dealId },
      data: { frozen: false, frozenAt: null, frozenReason: null, activeReportId: null },
    });
    await ctx.answerCallbackQuery({ text: "Refunded" });
    await ctx.reply("Deal refunded; report marked resolved_refund.");
  });

  bot.callbackQuery(/^rpa:note:(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply("Send /note REPORT_ID your note text");
  });

  return bot;
}
