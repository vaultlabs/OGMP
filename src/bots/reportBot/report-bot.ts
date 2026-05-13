import { Bot, Context, InlineKeyboard } from "grammy";
import { getReportBotToken, isAdminTelegramId } from "../../config/index.js";
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
} from "../../modules/reports/report.service.js";
import { assertFileAllowed } from "../../utils/file-safety.js";
import {
  TELEGRAM_FOLDER_UPLOAD_EXPLANATION_PLAIN,
  formatUploadContinuationPlain,
} from "../../utils/upload-guidance.js";
import type { ParticipantRole, ReportCategory } from "@prisma/client";
import { adminForceRefund, adminForceRelease } from "../../modules/admin/admin.service.js";

const WIZ = (id: bigint) => `ogmp:report_wiz:${id.toString()}`;

type Wiz =
  | { step: "role"; sessionId: string; dealId: string; userId: string }
  | { step: "category"; sessionId: string; dealId: string; userId: string; role: ParticipantRole }
  | { step: "describe"; sessionId: string; dealId: string; userId: string; role: ParticipantRole; category: ReportCategory }
  | { step: "collect"; reportId: string; dealId: string };

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

export function createReportBot(): Bot<Context> {
  const token = getReportBotToken();
  if (!token) {
    throw new Error("OGMP_MM_REPORT_BOT_TOKEN is not set");
  }
  const bot = new Bot<Context>(token);

  bot.catch((err) => {
    logger.error("report_bot_error", { err: String(err.error) });
  });

  bot.command("start", async (ctx) => {
    if (!ctx.from) return;
    const arg = startArg(ctx);
    if (!arg?.startsWith("report_")) {
      await ctx.reply("This is **OGMP MM REPORT**. Open a report link from your escrow deal in the main OGMP MM bot.", {
        parse_mode: "Markdown",
      });
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
      await ctx.reply(`❌ ${String((e as Error).message)}`);
    }
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
    if (!w || w.step !== "describe") return next();
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
    if (!w || w.step !== "collect") return;
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
    await ctx.reply(
      [
        "✅ Evidence attached.",
        "",
        formatUploadContinuationPlain("type /report_done when you are finished"),
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
      await ctx.reply(String((e as Error).message));
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
    const d = ctx.message.document;
    if (!d) return;
    try {
      assertFileAllowed({
        fileName: d.file_name,
        mimeType: d.mime_type,
        fileSize: d.file_size,
      });
    } catch (e) {
      await ctx.reply(String((e as Error).message));
      return;
    }
    await saveEvidence(ctx, "document", {
      fileId: d.file_id,
      fileUniqueId: d.file_unique_id,
      fileName: d.file_name ?? "document",
      mimeType: d.mime_type,
      fileSize: d.file_size,
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
      await ctx.reply(String((e as Error).message));
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
      await ctx.reply(`❌ ${String((e as Error).message)}`);
    }
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
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const reps = await prisma.report.findMany({
      where: { status: { in: ["submitted", "under_review", "waiting_for_buyer", "waiting_for_seller"] } },
      take: 20,
      orderBy: { createdAt: "desc" },
    });
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard();
    for (const r of reps) kb.text(r.reportCode, `rpa:v:${r.id}`).row();
    await ctx.reply(reps.length ? "Active reports:" : "No active reports.", { reply_markup: kb });
  });

  bot.callbackQuery(/^rpa:v:(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id)) || !ctx.match) return;
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
      reply_markup: new InlineKeyboard()
        .text("Release", `rpa:rel:${rep.id}`)
        .text("Refund", `rpa:ref:${rep.id}`)
        .row()
        .text("Note", `rpa:note:${rep.id}`),
    });
  });

  bot.callbackQuery(/^rpa:rel:(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id)) || !ctx.match) return;
    const id = ctx.match[1]!;
    const rep = await prisma.report.findUnique({ where: { id } });
    if (!rep) return;
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
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id)) || !ctx.match) return;
    const id = ctx.match[1]!;
    const rep = await prisma.report.findUnique({ where: { id } });
    if (!rep) return;
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
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    await ctx.answerCallbackQuery();
    await ctx.reply("Send /note REPORT_ID your note text");
  });

  return bot;
}
