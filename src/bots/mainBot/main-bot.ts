import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { loadConfig, isAdminTelegramId, getMainBotToken, getReportBotToken } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import { redisIncrWithTtl } from "../../utils/redis.js";
import { prisma } from "../../db/prisma.js";
import { registerDealRoomHandlers } from "./deal-room.handlers.js";
import { getActiveDealRoom } from "../../modules/dealMessages/deal-room-session.service.js";
import { listDealMessages } from "../../modules/dealMessages/dealMessage.service.js";
import { createReportSession } from "../../modules/reports/report-session.service.js";
import { assertCanOpenNewReport } from "../../modules/reports/report.service.js";
import { TERMS_TEXT, WELCOME, SAFETY_FOOTER } from "./messages.js";
import {
  acceptTerms,
  buyerConfirmRelease,
  cancelDeal,
  createDeal,
  joinDealByToken,
  markDelivered,
  openDispute,
} from "../../modules/deals/deal.service.js";
import {
  upsertTelegramUser,
  acceptTermsForUser,
  findUserByTelegramId,
  banUserByTelegramId,
  unbanUserByTelegramId,
} from "../../modules/users/user.service.js";
import { createSupportTicket } from "../../modules/support/support.service.js";
import {
  clearCreateWizard,
  getCreateWizard,
  setCreateWizard,
  toCreateDealInput,
} from "./create-deal-wizard.js";
import { supportTicketSchema } from "../../modules/deals/deal.validation.js";
import {
  adminCancelDeal,
  adminForceRefund,
  adminForceRelease,
  exportDealsCsv,
} from "../../modules/admin/admin.service.js";
import { applyReview } from "../../services/reputation.service.js";
import { reviewSchema } from "../../modules/deals/deal.validation.js";
import type { CreateDealInput } from "../../modules/deals/deal.service.js";
import type { ParticipantRole } from "@prisma/client";

function startArg(ctx: Context): string | undefined {
  const t = ctx.message?.text;
  if (!t) return;
  const m = /^\/start(?:@\w+)?(?:\s+(.+))?$/i.exec(t);
  return m?.[1]?.trim();
}

function mainMenuKb(isAdmin: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("➕ Create Deal", "m:create")
    .text("📂 My Deals", "m:deals")
    .row()
    .text("👤 Profile", "m:profile")
    .text("🤝 Join Deal", "m:join")
    .row()
    .text("🛟 Support", "m:support")
    .text("📜 Terms", "m:terms")
    .row();
  if (isAdmin) kb.text("🛡 Admin Panel", "m:admin");
  return kb;
}

function fmtUser(u: { telegramId: bigint; username: string | null; firstName: string | null }): string {
  const un = u.username ? `@${u.username}` : "no username";
  return `${u.firstName ?? "User"} (${un}, id \`${u.telegramId.toString()}\`)`;
}

async function fmtDealCard(dealId: string): Promise<string> {
  const d = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true, seller: true, activeReport: true },
  });
  if (!d) return "Deal not found.";
  const buyer = d.buyer ? fmtUser(d.buyer) : "_pending_";
  const seller = d.seller ? fmtUser(d.seller) : "_pending_";
  const [msgCount, lastEv, pay] = await Promise.all([
    prisma.dealMessage.count({ where: { dealId } }),
    prisma.dealTimelineEvent.findFirst({
      where: { dealId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } }),
  ]);
  const delivery =
    d.status === "item_delivered" || d.status === "buyer_confirmed" || d.status === "release_requested"
      ? "Seller marked delivered"
      : d.status === "funded"
        ? "Awaiting seller delivery"
        : "—";
  const reportLine = d.activeReport
    ? `Report: \`${d.activeReport.reportCode}\` (${d.activeReport.status})`
    : "Report: _none active_";
  return [
    `🔷 *Deal ${d.dealCode}*`,
    `Status: \`${d.status}\`${d.frozen ? " 🧊 *FROZEN*" : ""}`,
    `Buyer: ${buyer}`,
    `Seller: ${seller}`,
    `Amount: *${d.amount.toString()} ${d.currency}* (${d.network})`,
    `Fee: ${d.feeAmount.toString()} (${d.feePayer})`,
    `Payment: ${pay ? `\`${pay.status}\`` : "—"}`,
    `Delivery: ${delivery}`,
    reportLine,
    `Files in deal room: ${msgCount}`,
    "Folders: send .zip / .rar / .7z or one file per message (no folder upload).",
    `Last activity: ${d.lastActivityAt.toISOString().slice(0, 19)}Z`,
    `Created: ${d.createdAt.toISOString().slice(0, 10)}`,
    `Terms: ${d.dealTerms.slice(0, 300)}${d.dealTerms.length > 300 ? "…" : ""}`,
    lastEv ? `Latest event: \`${lastEv.eventType}\`` : "",
    d.paymentAddress && d.status !== "pending_acceptance"
      ? `\n💳 *Payment address*\n\`${d.paymentAddress}\`\nExact amount: *${d.amount.toString()} ${d.currency}* on *${d.network}*${SAFETY_FOOTER}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function createMainBot(): Bot<Context> {
  const cfg = loadConfig();
  const bot = new Bot<Context>(getMainBotToken());

  bot.catch((err) => {
    const ctx = err.ctx;
    logger.error("bot_error", {
      update_id: ctx.update.update_id,
      err: String(err.error),
    });
    void err.ctx.reply("Something went wrong. Our team has been notified.").catch(() => {});
  });

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id) return;
    const win = Math.ceil(cfg.RATE_LIMIT_WINDOW_MS / 1000);
    const n = await redisIncrWithTtl(`rl:cmd:${id}`, win);
    if (n > cfg.RATE_LIMIT_MAX) {
      await ctx.reply("⏳ Rate limit reached. Please wait a moment.");
      return;
    }
    await next();
  });

  bot.use(async (ctx, next) => {
    if (!ctx.from) return;
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (u?.banned) {
      await ctx.reply("⛔ Your access to OGMP MM has been restricted.");
      return;
    }
    await next();
  });

  registerDealRoomHandlers(bot);

  async function requireUser(ctx: Context) {
    if (!ctx.from) return null;
    return upsertTelegramUser({
      telegramId: BigInt(ctx.from.id),
      username: ctx.from.username,
      firstName: ctx.from.first_name,
    });
  }

  bot.command("start", async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    const arg = startArg(ctx);
    if (arg?.startsWith("join_")) {
      const token = arg.slice("join_".length);
      try {
        const deal = await joinDealByToken(user, token);
        await ctx.reply(`✅ You joined deal *${deal.dealCode}*. Review terms and accept when ready.`, {
          parse_mode: "Markdown",
        });
        await ctx.reply(await fmtDealCard(deal.id), { parse_mode: "Markdown" });
      } catch (e) {
        await ctx.reply(`❌ ${String((e as Error).message)}`);
      }
      return;
    }
    if (!user.termsAcceptedAt) {
      await ctx.reply(WELCOME, { parse_mode: "Markdown" });
      await ctx.reply(TERMS_TEXT, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("✅ I agree to the Terms", "terms:ok"),
      });
      return;
    }
    if (!ctx.from) return;
    await ctx.reply(WELCOME, {
      parse_mode: "Markdown",
      reply_markup: mainMenuKb(isAdminTelegramId(BigInt(ctx.from.id))),
    });
  });

  bot.callbackQuery(/^terms:ok$/, async (ctx) => {
    if (!ctx.from) return;
    await acceptTermsForUser(BigInt(ctx.from.id));
    await ctx.answerCallbackQuery({ text: "Terms accepted" });
    await ctx.editMessageText("✅ Terms accepted. You may now use OGMP MM.");
    await ctx.reply(WELCOME, {
      parse_mode: "Markdown",
      reply_markup: mainMenuKb(isAdminTelegramId(BigInt(ctx.from.id))),
    });
  });

  bot.callbackQuery(/^m:create$/, async (ctx) => {
    if (!ctx.from) return;
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (!u?.termsAcceptedAt) {
      await ctx.answerCallbackQuery({ text: "Accept terms first", show_alert: true });
      return;
    }
    await setCreateWizard(BigInt(ctx.from.id), { step: "role" });
    await ctx.answerCallbackQuery();
    await ctx.reply("Select your role in this deal:", {
      reply_markup: new InlineKeyboard()
        .text("I am the Buyer", "w:role:buyer")
        .text("I am the Seller", "w:role:seller"),
    });
  });

  bot.callbackQuery(/^w:role:(buyer|seller)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const role = ctx.match[1] as ParticipantRole;
    await setCreateWizard(BigInt(ctx.from.id), { step: "title", creatorRole: role });
    await ctx.answerCallbackQuery();
    await ctx.reply("Enter a short *deal title* (plain text).", { parse_mode: "Markdown" });
  });

  bot.callbackQuery(/^m:deals$/, async (ctx) => {
    if (!ctx.from) return;
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (!u) return;
    const deals = await prisma.deal.findMany({
      where: { OR: [{ buyerId: u.id }, { sellerId: u.id }, { creatorId: u.id }] },
      orderBy: { createdAt: "desc" },
      take: 15,
    });
    await ctx.answerCallbackQuery();
    if (!deals.length) {
      await ctx.reply("You have no deals yet.");
      return;
    }
    const kb = new InlineKeyboard();
    for (const d of deals) {
      kb.text(`${d.dealCode} (${d.status})`, `d:v:${d.dealCode}`).row();
    }
    await ctx.reply("Your recent deals:", { reply_markup: kb });
  });

  bot.callbackQuery(/^d:v:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const code = ctx.match[1];
    const deal = await prisma.deal.findUnique({ where: { dealCode: code } });
    if (!deal) {
      await ctx.answerCallbackQuery({ text: "Not found", show_alert: true });
      return;
    }
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (!u) return;
    const allowed =
      deal.buyerId === u.id || deal.sellerId === u.id || deal.creatorId === u.id;
    if (!allowed) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const text = await fmtDealCard(deal.id);
    const kb = new InlineKeyboard();
    if (deal.status === "pending_acceptance") {
      kb.text("✅ Accept deal terms", `d:a:${deal.dealCode}`);
    }
    if (deal.status === "funded") {
      kb.text("📦 Mark delivered (seller)", `d:del:${deal.dealCode}`);
    }
    if (deal.status === "item_delivered") {
      kb.text("✅ Confirm receipt & release", `d:rel:${deal.dealCode}`);
    }
    if (
      deal.status === "waiting_payment" ||
      deal.status === "payment_detected" ||
      deal.status === "funded" ||
      deal.status === "item_delivered" ||
      deal.status === "buyer_confirmed" ||
      deal.status === "release_requested"
    ) {
      kb.text("⚖ Open dispute", `d:dp:${deal.dealCode}`);
    }
    if (deal.status === "pending_acceptance" || deal.status === "waiting_payment") {
      kb.text("🛑 Request cancel", `d:cx:${deal.dealCode}`);
    }
    kb.text("💬 Send msg / upload proof", `dr:enter:${deal.dealCode}`).row();
    kb.text("📅 Timeline", `d:tl:${deal.dealCode}`).text("📎 Uploaded proof", `d:pr:${deal.dealCode}`).row();
    kb.text("📝 Report deal", `d:rp:${deal.dealCode}`);
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  });

  bot.callbackQuery(/^d:tl:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const code = ctx.match[1];
    const deal = await prisma.deal.findUnique({ where: { dealCode: code } });
    if (!deal) {
      await ctx.answerCallbackQuery({ text: "Not found", show_alert: true });
      return;
    }
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (!u || (deal.buyerId !== u.id && deal.sellerId !== u.id && deal.creatorId !== u.id)) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    const evs = await prisma.dealTimelineEvent.findMany({
      where: { dealId: deal.id },
      orderBy: { createdAt: "asc" },
      take: 80,
    });
    await ctx.answerCallbackQuery();
    const lines = evs.map((e) => `• ${e.createdAt.toISOString().slice(0, 16)} — ${e.eventType}`);
    await ctx.reply(lines.length ? lines.join("\n") : "No timeline events yet.");
  });

  bot.callbackQuery(/^d:pr:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const code = ctx.match[1];
    const deal = await prisma.deal.findUnique({ where: { dealCode: code } });
    if (!deal) {
      await ctx.answerCallbackQuery({ text: "Not found", show_alert: true });
      return;
    }
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (!u) return;
    try {
      const msgs = await listDealMessages(deal.id, u.id);
      await ctx.answerCallbackQuery();
      const lines = msgs.map(
        (m) =>
          `• ${m.createdAt.toISOString().slice(0, 16)} ${m.messageType}${m.fileName ? ` (${m.fileName})` : ""}`,
      );
      await ctx.reply(
        lines.length
          ? `*Deal proof log* (${msgs.length})\n${lines.join("\n")}\n\n_File IDs are stored privately for admins._`
          : "No files or messages in the deal room yet.\n\nTelegram cannot take a real folder: send a .zip/.rar/.7z archive or upload files one message at a time.",
        { parse_mode: "Markdown" },
      );
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String((e as Error).message), show_alert: true });
    }
  });

  bot.callbackQuery(/^d:rp:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const code = ctx.match[1];
    const deal = await prisma.deal.findUnique({ where: { dealCode: code } });
    if (!deal) {
      await ctx.answerCallbackQuery({ text: "Not found", show_alert: true });
      return;
    }
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (!u) return;
    const cfg = loadConfig();
    if (!getReportBotToken()) {
      await ctx.answerCallbackQuery({ text: "Report bot not configured", show_alert: true });
      return;
    }
    try {
      await assertCanOpenNewReport(deal.id, u.id);
      const { rawToken } = await createReportSession({ dealId: deal.id, userId: u.id });
      const rb = cfg.REPORT_BOT_USERNAME ?? "OGMP_MM_REPORT_BOT";
      const url = `https://t.me/${rb}?start=report_${rawToken}`;
      await ctx.answerCallbackQuery({ text: "Opening report flow" });
      await ctx.reply(
        `📝 *Report this deal*\n\nOpen **OGMP MM REPORT** to continue (secure, time-limited link):\n${url}\n\nDo not share this link.`,
        { parse_mode: "Markdown" },
      );
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String((e as Error).message), show_alert: true });
    }
  });

  bot.callbackQuery(/^d:a:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const u = await requireUser(ctx);
    if (!u) return;
    const deal = await prisma.deal.findUnique({ where: { dealCode: ctx.match[1] } });
    if (!deal) {
      await ctx.answerCallbackQuery({ text: "Not found", show_alert: true });
      return;
    }
    try {
      const updated = await acceptTerms(u.id, deal.id);
      await ctx.answerCallbackQuery({ text: "Accepted" });
      await ctx.reply(await fmtDealCard(updated.id), { parse_mode: "Markdown" });
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String((e as Error).message), show_alert: true });
    }
  });

  bot.callbackQuery(/^d:del:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const u = await requireUser(ctx);
    if (!u) return;
    const deal = await prisma.deal.findUnique({ where: { dealCode: ctx.match[1] } });
    if (!deal) return;
    try {
      const d = await markDelivered(u.id, deal.id);
      await ctx.answerCallbackQuery({ text: "Marked delivered" });
      await ctx.reply(await fmtDealCard(d.id), { parse_mode: "Markdown" });
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String((e as Error).message), show_alert: true });
    }
  });

  bot.callbackQuery(/^d:rel:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const u = await requireUser(ctx);
    if (!u) return;
    const deal = await prisma.deal.findUnique({ where: { dealCode: ctx.match[1] } });
    if (!deal) return;
    try {
      const d = await buyerConfirmRelease(u.id, deal.id);
      await ctx.answerCallbackQuery({ text: "Processed" });
      await ctx.reply(await fmtDealCard(d.id), { parse_mode: "Markdown" });
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String((e as Error).message), show_alert: true });
    }
  });

  bot.callbackQuery(/^d:dp:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const u = await requireUser(ctx);
    if (!u) return;
    const deal = await prisma.deal.findUnique({ where: { dealCode: ctx.match[1] } });
    if (!deal) return;
    try {
      await openDispute(u.id, deal.id);
      await ctx.answerCallbackQuery({ text: "Dispute opened" });
      await ctx.reply(
        "⚖ Dispute recorded. Please submit evidence with /dispute and follow prompts. Admins have been notified.",
      );
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String((e as Error).message), show_alert: true });
    }
  });

  bot.callbackQuery(/^d:cx:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const u = await requireUser(ctx);
    if (!u) return;
    const deal = await prisma.deal.findUnique({ where: { dealCode: ctx.match[1] } });
    if (!deal) return;
    try {
      const d = await cancelDeal(u.id, deal.id);
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await ctx.reply(`Deal ${d.dealCode} is now *${d.status}*.`, { parse_mode: "Markdown" });
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String((e as Error).message), show_alert: true });
    }
  });

  bot.callbackQuery(/^m:profile$/, async (ctx) => {
    if (!ctx.from) return;
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    await ctx.answerCallbackQuery();
    if (!u) return;
    const flags = JSON.stringify(u.suspiciousFlags);
    await ctx.reply(
      [
        `👤 *Your OGMP MM profile*`,
        `Completed deals: ${u.completedDeals}`,
        `Disputed deals: ${u.disputedDeals}`,
        `Cancelled deals: ${u.cancelledDeals}`,
        `Reputation: ${u.reputationScore.toString()} ⭐`,
        `Total volume (USD field): ${u.totalVolumeUsd.toString()}`,
        `Flags: \`${flags}\``,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  bot.callbackQuery(/^m:join$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Ask your counterparty for the invite link, or send:\n`/join <invite_token>`");
  });

  bot.callbackQuery(/^m:support$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Send `/support <issue_type> | <message> | optional_deal_code` (pipe-separated).\nYou may reply with a photo after.",
    );
  });

  bot.callbackQuery(/^m:terms$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(TERMS_TEXT, { parse_mode: "Markdown" });
  });

  bot.callbackQuery(/^m:admin$/, async (ctx) => {
    if (!ctx.from) return;
    if (!isAdminTelegramId(BigInt(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text("Active deals", "a:act")
      .text("Funded", "a:fnd")
      .row()
      .text("Disputed", "a:dis")
      .text("Export CSV", "a:csv")
      .row()
      .text("Force release (reply deal id next)", "a:fr")
      .text("Force refund", "a:fref");
    await ctx.reply("🛡 *Admin panel*", { parse_mode: "Markdown", reply_markup: kb });
  });

  bot.callbackQuery(/^a:act$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const deals = await prisma.deal.findMany({
      where: { status: { notIn: ["released", "refunded", "cancelled"] } },
      take: 20,
      orderBy: { createdAt: "desc" },
    });
    await ctx.answerCallbackQuery();
    await ctx.reply(deals.map((d) => `${d.dealCode} ${d.status}`).join("\n") || "None");
  });

  bot.callbackQuery(/^a:fnd$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const deals = await prisma.deal.findMany({
      where: { status: "funded" },
      take: 20,
    });
    await ctx.answerCallbackQuery();
    await ctx.reply(deals.map((d) => `${d.dealCode}`).join("\n") || "None");
  });

  bot.callbackQuery(/^a:dis$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const deals = await prisma.deal.findMany({
      where: { status: "disputed" },
      take: 20,
    });
    await ctx.answerCallbackQuery();
    await ctx.reply(deals.map((d) => `${d.dealCode}`).join("\n") || "None");
  });

  bot.callbackQuery(/^a:csv$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const csv = await exportDealsCsv();
    await ctx.answerCallbackQuery();
    await ctx.replyWithDocument(new InputFile(Buffer.from(csv, "utf8"), "deals-export.csv"));
  });

  bot.command("join", async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    const parts = ctx.message?.text?.split(/\s+/) ?? [];
    const token = parts[1];
    if (!token) {
      await ctx.reply("Usage: `/join <invite_token>`");
      return;
    }
    try {
      const deal = await joinDealByToken(user, token);
      await ctx.reply(`✅ Joined *${deal.dealCode}*`, { parse_mode: "Markdown" });
      await ctx.reply(await fmtDealCard(deal.id), { parse_mode: "Markdown" });
    } catch (e) {
      await ctx.reply(`❌ ${String((e as Error).message)}`);
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "*Commands*",
        "/start — onboarding & menu",
        "/create — start deal wizard",
        "/deals — list your deals",
        "/profile — reputation & stats",
        "/terms — legal terms",
        "/support — contact admins",
        "/join \u003ctoken\u003e — join counterparty deal",
        "/cancel — cancel eligible deal (reply to deal card or pass deal code)",
        "/dispute — dispute help",
        "/admin — admin panel (admins only)",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  bot.command("create", async (ctx) => {
    if (!ctx.from) return;
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (!u?.termsAcceptedAt) {
      await ctx.reply("Please /start and accept terms first.");
      return;
    }
    await setCreateWizard(BigInt(ctx.from.id), { step: "role" });
    await ctx.reply("Select your role:", {
      reply_markup: new InlineKeyboard()
        .text("I am the Buyer", "w:role:buyer")
        .text("I am the Seller", "w:role:seller"),
    });
  });

  bot.command("deals", async (ctx) => {
    if (!ctx.from) return;
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (!u) return;
    const deals = await prisma.deal.findMany({
      where: { OR: [{ buyerId: u.id }, { sellerId: u.id }, { creatorId: u.id }] },
      orderBy: { createdAt: "desc" },
      take: 15,
    });
    if (!deals.length) {
      await ctx.reply("No deals.");
      return;
    }
    const kb = new InlineKeyboard();
    for (const d of deals) kb.text(`${d.dealCode}`, `d:v:${d.dealCode}`).row();
    await ctx.reply("Tap a deal:", { reply_markup: kb });
  });

  bot.command("profile", async (ctx) => {
    if (!ctx.from) return;
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (!u) return;
    await ctx.reply(
      `⭐ Reputation ${u.reputationScore.toString()} · Completed ${u.completedDeals} · Disputes ${u.disputedDeals}`,
    );
  });

  bot.command("terms", async (ctx) => {
    await ctx.reply(TERMS_TEXT, { parse_mode: "Markdown" });
  });

  bot.command("support", async (ctx) => {
    if (!ctx.from) return;
    const u = await requireUser(ctx);
    if (!u) return;
    const raw = ctx.message?.text?.replace(/^\/support(@\w+)?\s*/i, "") ?? "";
    const parsed = supportTicketSchema.safeParse({
      issueType: raw.split("|")[0]?.trim() ?? "general",
      message: raw.split("|")[1]?.trim() ?? raw,
      dealCode: raw.split("|")[2]?.trim(),
    });
    if (!parsed.success) {
      await ctx.reply("Usage: `/support issue | message | optional_deal_code`");
      return;
    }
    await createSupportTicket({
      userId: u.id,
      issueType: parsed.data.issueType,
      message: parsed.data.message,
      dealCode: parsed.data.dealCode,
    });
    await ctx.reply("✅ Support ticket submitted. An admin will review it.");
  });

  bot.command("cancel", async (ctx) => {
    if (!ctx.from) return;
    const u = await requireUser(ctx);
    if (!u) return;
    const parts = ctx.message?.text?.split(/\s+/) ?? [];
    const code = parts[1];
    if (!code) {
      await ctx.reply("Usage: `/cancel DEALCODE`");
      return;
    }
    const deal = await prisma.deal.findUnique({ where: { dealCode: code } });
    if (!deal) {
      await ctx.reply("Deal not found");
      return;
    }
    try {
      const d = await cancelDeal(u.id, deal.id);
      await ctx.reply(`Deal ${d.dealCode} → ${d.status}`);
    } catch (e) {
      await ctx.reply(String((e as Error).message));
    }
  });

  bot.command("dispute", async (ctx) => {
    await ctx.reply(
      "Open a dispute from the deal card (button), then add evidence here as replies with text or attachments (handled in future iterations via deal context). For now, email-style evidence can be sent through /support with deal code.",
    );
  });

  bot.command("admin", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) {
      await ctx.reply("Forbidden");
      return;
    }
    await ctx.reply("Admin:", {
      reply_markup: new InlineKeyboard()
        .text("Active deals", "a:act")
        .text("Disputed", "a:dis")
        .row()
        .text("Export CSV", "a:csv"),
    });
  });

  /** Network presets for wizard */
  bot.callbackQuery(/^w:net:(USDT|BTC|ETH|LTC):(TRC20|ERC20|BTC|ETH|LTC)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const cur = ctx.match[1] as CreateDealInput["currency"];
    const net = ctx.match[2]!;
    const w = await getCreateWizard(BigInt(ctx.from.id));
    if (!w || w.step !== "network") {
      await ctx.answerCallbackQuery({ text: "Wizard expired — /create", show_alert: true });
      return;
    }
    await setCreateWizard(BigInt(ctx.from.id), {
      step: "fee_payer",
      creatorRole: w.creatorRole,
      title: w.title,
      description: w.description,
      amount: w.amount,
      currency: cur,
      network: net === "BTC" ? "BTC" : net,
    });
    await ctx.answerCallbackQuery();
    await ctx.reply("Who pays the escrow fee?", {
      reply_markup: new InlineKeyboard()
        .text("Buyer", "w:fee:buyer")
        .text("Seller", "w:fee:seller")
        .text("Split", "w:fee:split"),
    });
  });

  bot.callbackQuery(/^w:fee:(buyer|seller|split)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const fp = ctx.match[1] as CreateDealInput["feePayer"];
    const w = await getCreateWizard(BigInt(ctx.from.id));
    if (!w || w.step !== "fee_payer") {
      await ctx.answerCallbackQuery({ text: "Wizard expired — /create", show_alert: true });
      return;
    }
    const draft = toCreateDealInput(w, fp);
    await setCreateWizard(BigInt(ctx.from.id), { step: "confirm", draft });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "*Confirm deal*",
        `Role: ${draft.creatorRole}`,
        `Title: ${draft.title}`,
        `Amount: ${draft.amount} ${draft.currency} (${draft.network})`,
        `Fee payer: ${draft.feePayer}`,
      ].join("\n"),
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("✅ Create deal", "w:go").text("❌ Abort", "w:abort"),
      },
    );
  });

  bot.callbackQuery(/^w:go$/, async (ctx) => {
    if (!ctx.from) return;
    const w = await getCreateWizard(BigInt(ctx.from.id));
    if (!w || w.step !== "confirm") {
      await ctx.answerCallbackQuery({ text: "Nothing to confirm", show_alert: true });
      return;
    }
    const u = await requireUser(ctx);
    if (!u) return;
    try {
      const deal = await createDeal(u, w.draft);
      await clearCreateWizard(BigInt(ctx.from.id));
      await ctx.answerCallbackQuery({ text: "Created" });
      const cfg = loadConfig();
      const me = cfg.BOT_PUBLIC_USERNAME ?? (await ctx.api.getMe()).username;
      const link = me ? `https://t.me/${me}?start=join_${deal.inviteToken}` : `Invite token:\n\`${deal.inviteToken}\``;
      await ctx.reply(
        `✅ Deal *${deal.dealCode}* created.\nShare this invite with your counterparty:\n${link}`,
        { parse_mode: "Markdown" },
      );
      await ctx.reply(await fmtDealCard(deal.id), { parse_mode: "Markdown" });
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String((e as Error).message), show_alert: true });
    }
  });

  bot.callbackQuery(/^w:abort$/, async (ctx) => {
    if (!ctx.from) return;
    await clearCreateWizard(BigInt(ctx.from.id));
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await ctx.editMessageText("Wizard cancelled.");
  });

  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from || ctx.message.text.startsWith("/")) return next();
    if (await getActiveDealRoom(BigInt(ctx.from.id))) return next();
    const w = await getCreateWizard(BigInt(ctx.from.id));
    if (!w) return next();
    const text = ctx.message.text.trim();
    if (w.step === "title") {
      await setCreateWizard(BigInt(ctx.from.id), {
        step: "description",
        creatorRole: w.creatorRole,
        title: text.slice(0, 120),
      });
      await ctx.reply("Describe the goods/services (this also becomes baseline deal terms):");
      return;
    }
    if (w.step === "description") {
      await setCreateWizard(BigInt(ctx.from.id), {
        step: "amount",
        creatorRole: w.creatorRole,
        title: w.title,
        description: text.slice(0, 4000),
      });
      await ctx.reply("Enter numeric deal amount (crypto units, e.g. `100.5`):", { parse_mode: "Markdown" });
      return;
    }
    if (w.step === "amount") {
      if (!/^\d+(\.\d+)?$/.test(text)) {
        await ctx.reply("Invalid amount. Try again.");
        return;
      }
      await setCreateWizard(BigInt(ctx.from.id), {
        step: "network",
        creatorRole: w.creatorRole,
        title: w.title,
        description: w.description,
        amount: text,
      });
      await ctx.reply("Choose network:", {
        reply_markup: new InlineKeyboard()
          .text("USDT TRC20", "w:net:USDT:TRC20")
          .text("USDT ERC20", "w:net:USDT:ERC20")
          .row()
          .text("BTC", "w:net:BTC:BTC")
          .text("ETH", "w:net:ETH:ETH")
          .row()
          .text("LTC", "w:net:LTC:LTC"),
      });
      return;
    }
    return next();
  });

  bot.command("rate", async (ctx) => {
    if (!ctx.from) return;
    const u = await requireUser(ctx);
    if (!u) return;
    const parts = ctx.message?.text?.split(/\s+/) ?? [];
    const code = parts[1];
    const stars = Number(parts[2]);
    const text = parts.slice(3).join(" ");
    const parsed = reviewSchema.safeParse({ stars, text });
    if (!code || !parsed.success) {
      await ctx.reply("Usage: `/rate DEALCODE STARS [optional text]`");
      return;
    }
    const deal = await prisma.deal.findUnique({
      where: { dealCode: code },
      include: { buyer: true, seller: true },
    });
    if (!deal || deal.status !== "released") {
      await ctx.reply("Deal not found or not completed.");
      return;
    }
    if (deal.buyerId !== u.id && deal.sellerId !== u.id) {
      await ctx.reply("You were not part of this deal.");
      return;
    }
    const toId = deal.buyerId === u.id ? deal.sellerId! : deal.buyerId!;
    try {
      await applyReview({
        dealId: deal.id,
        fromUserId: u.id,
        toUserId: toId,
        stars: parsed.data.stars,
        text: parsed.data.text,
      });
    } catch (e) {
      const msg = String((e as Error).message);
      if (msg.includes("Unique constraint")) {
        await ctx.reply("You already left a review for this deal.");
        return;
      }
      throw e;
    }
    await ctx.reply("✅ Review saved. Thank you for helping keep OGMP MM trusted.");
  });

  bot.command("admin_release", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const code = ctx.message?.text?.split(/\s+/)[1];
    if (!code) {
      await ctx.reply("Usage: `/admin_release DEALCODE`");
      return;
    }
    const deal = await prisma.deal.findUnique({ where: { dealCode: code } });
    if (!deal) {
      await ctx.reply("Not found");
      return;
    }
    try {
      await adminForceRelease(deal.id, BigInt(ctx.from.id));
      await ctx.reply("✅ Force release executed.");
    } catch (e) {
      await ctx.reply(String((e as Error).message));
    }
  });

  bot.command("admin_refund", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const code = ctx.message?.text?.split(/\s+/)[1];
    if (!code) {
      await ctx.reply("Usage: `/admin_refund DEALCODE`");
      return;
    }
    const deal = await prisma.deal.findUnique({ where: { dealCode: code } });
    if (!deal) {
      await ctx.reply("Not found");
      return;
    }
    try {
      await adminForceRefund(deal.id, BigInt(ctx.from.id));
      await ctx.reply("✅ Force refund executed.");
    } catch (e) {
      await ctx.reply(String((e as Error).message));
    }
  });

  bot.command("admin_cancel", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const code = ctx.message?.text?.split(/\s+/)[1];
    if (!code) {
      await ctx.reply("Usage: `/admin_cancel DEALCODE`");
      return;
    }
    const deal = await prisma.deal.findUnique({ where: { dealCode: code } });
    if (!deal) {
      await ctx.reply("Not found");
      return;
    }
    try {
      await adminCancelDeal(deal.id, BigInt(ctx.from.id));
      await ctx.reply("✅ Admin-cancelled.");
    } catch (e) {
      await ctx.reply(String((e as Error).message));
    }
  });

  bot.command("admin_ban", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const parts = ctx.message?.text?.trim().split(/\s+/) ?? [];
    const tid = parts[1];
    const reason = parts.slice(2).join(" ") || "banned_by_admin";
    if (!tid) {
      await ctx.reply("Usage: `/admin_ban TELEGRAM_ID reason...`");
      return;
    }
    try {
      const id = BigInt(tid);
      await banUserByTelegramId(id, reason);
      await ctx.reply("✅ User banned.");
    } catch {
      await ctx.reply("Invalid id");
    }
  });

  bot.command("admin_unban", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const parts = ctx.message?.text?.trim().split(/\s+/) ?? [];
    const tid = parts[1];
    if (!tid) {
      await ctx.reply("Usage: `/admin_unban TELEGRAM_ID`");
      return;
    }
    try {
      const id = BigInt(tid);
      await unbanUserByTelegramId(id);
      await ctx.reply("✅ User unbanned.");
    } catch {
      await ctx.reply("Invalid id");
    }
  });

  return bot;
}
