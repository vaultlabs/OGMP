import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { loadConfig, isAdminTelegramId, getMainBotToken, getReportBotToken } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import { redisIncrWithTtl } from "../../utils/redis.js";
import { prisma } from "../../db/prisma.js";
import type { ParticipantRole, User } from "@prisma/client";
import { gatewayAccessMiddleware } from "./gatewayAccess.middleware.js";
import {
  deleteGatewaySetting,
  GATEWAY_SETTING_KEYS,
  getEffectiveGatewayConfig,
  getGatewayAdminSnapshot,
  setGatewaySetting,
} from "../../modules/gateway/gateway-settings.service.js";
import {
  clearPendingJoinInvite,
  getPendingJoinInvite,
  setPendingJoinInvite,
} from "../../modules/gateway/pending-join.service.js";
import {
  GATEWAY_ACCESS_APPROVED,
  GATEWAY_ACCESS_REQUIRED_LONG,
  GATEWAY_NOT_CONFIRMED,
  gatewayAccessKeyboard,
} from "../../modules/gateway/gateway-messages.js";
import {
  logGatewayVerificationSkipped,
  verifyGatewayChatMembership,
} from "../../modules/gateway/gateway-verify.service.js";
import {
  clearAdminGatewayExpect,
  getAdminGatewayExpect,
  setAdminGatewayExpect,
} from "../../modules/gateway/admin-gateway-prompt.service.js";
import { registerDealRoomHandlers } from "./deal-room.handlers.js";
import { getActiveDealRoom } from "../../modules/dealMessages/deal-room-session.service.js";
import { listDealMessages } from "../../modules/dealMessages/dealMessage.service.js";
import { createReportSession } from "../../modules/reports/report-session.service.js";
import { assertCanOpenNewReport, findSubmittedReviewReportForDeal } from "../../modules/reports/report.service.js";
import { TERMS_TEXT, WELCOME, SAFETY_FOOTER_PLAIN } from "./messages.js";
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
  markUserGatewayAccess,
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
import { userFacingDealStatus } from "../../modules/deals/user-facing-status.js";
import {
  createDealSuccessKeyboard,
  joinSuccessKeyboard,
  nextStepForActorReply,
  notifyBothAfterPaymentLive,
  notifyCounterpartyAfterTermsAccept,
} from "../../modules/deals/deal-next-step-guide.service.js";

function startArg(ctx: Context): string | undefined {
  const t = ctx.message?.text;
  if (!t) return;
  const m = /^\/start(?:@\w+)?(?:\s+(.+))?$/i.exec(t);
  return m?.[1]?.trim();
}

function mainMenuKb(isAdmin: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("Create deal", "m:create")
    .text("My deals", "m:deals")
    .row()
    .text("Join deal", "m:join")
    .row()
    .text("Support", "m:support")
    .text("Terms", "m:terms")
    .row()
    .text("Profile", "m:profile");
  if (isAdmin) kb.row().text("Admin", "m:admin");
  return kb;
}

function fmtUserLine(u: { telegramId: bigint; username: string | null; firstName: string | null }): string {
  const un = u.username ? `@${u.username}` : "no username";
  return `${u.firstName ?? "User"} (${un}, id ${u.telegramId.toString()})`;
}

/** Plain text only — safe for Telegram without parse_mode (no Markdown entity errors). */
async function fmtDealCard(dealId: string): Promise<string> {
  const d = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true, seller: true, activeReport: true },
  });
  if (!d) return "Deal not found.";
  const buyer = d.buyer ? fmtUserLine(d.buyer) : "(pending)";
  const seller = d.seller ? fmtUserLine(d.seller) : "(pending)";
  const [lockedCount, msgCount, lastEv, pay] = await Promise.all([
    prisma.dealMessage.count({ where: { dealId, lockedForBuyer: true } }),
    prisma.dealMessage.count({ where: { dealId } }),
    prisma.dealTimelineEvent.findFirst({
      where: { dealId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } }),
  ]);
  const displayStatus = userFacingDealStatus(d, {
    hasLockedDelivery: lockedCount > 0,
    paymentStatus: pay?.status ?? null,
  });
  const delivery =
    d.status === "item_delivered" || d.status === "buyer_confirmed" || d.status === "release_requested"
      ? "Buyer Reviewing / Release"
      : d.status === "funded"
        ? "Payment Confirmed"
        : "—";
  const termsPreview = `${d.dealTerms.slice(0, 300)}${d.dealTerms.length > 300 ? "…" : ""}`;
  const reportLine = d.activeReport
    ? `Report: ${d.activeReport.reportCode} (${d.activeReport.status})`
    : "Report: none active";
  return [
    `━━━━━━━━━━━━━━━━━━`,
    `OGMP MM — Deal`,
    `━━━━━━━━━━━━━━━━━━`,
    "",
    `Deal: ${d.dealCode}`,
    `Status: ${displayStatus}${d.frozen ? " (frozen)" : ""}`,
    `Internal status: ${d.status}`,
    `Buyer: ${buyer}`,
    `Seller: ${seller}`,
    `Amount: ${d.amount.toString()} ${d.currency} (${d.network})`,
    `Fee: ${d.feeAmount.toString()} (${d.feePayer})`,
    `Payment: ${pay ? pay.status : "—"}`,
    `Delivery: ${delivery}`,
    reportLine,
    `Files submitted: ${msgCount}`,
    "Folders: send .zip / .rar / .7z or one file per message (no folder upload).",
    `Last activity: ${d.lastActivityAt.toISOString().slice(0, 19)}Z`,
    `Created: ${d.createdAt.toISOString().slice(0, 10)}`,
    `Terms: ${termsPreview}`,
    lastEv ? `Latest event: ${lastEv.eventType}` : "",
    d.paymentAddress && d.status !== "pending_acceptance"
      ? `\nPayment address:\n${d.paymentAddress}\nExact amount: ${d.amount.toString()} ${d.currency} on ${d.network}${SAFETY_FOOTER_PLAIN}`
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

  bot.use(gatewayAccessMiddleware);

  registerDealRoomHandlers(bot);

  async function requireUser(ctx: Context) {
    if (!ctx.from) return null;
    return upsertTelegramUser({
      telegramId: BigInt(ctx.from.id),
      username: ctx.from.username,
      firstName: ctx.from.first_name,
    });
  }

  async function processMainOnboarding(ctx: Context, user: User): Promise<void> {
    if (!ctx.from) return;
    const tid = BigInt(ctx.from.id);
    const arg = startArg(ctx);
    let joinTok: string | null = null;
    if (arg?.startsWith("join_")) joinTok = arg.slice("join_".length);
    else joinTok = await getPendingJoinInvite(tid);

    if (joinTok) {
      await clearPendingJoinInvite(tid);
      try {
        const deal = await joinDealByToken(user, joinTok);
        await ctx.reply(`Joined deal ${deal.dealCode}.`);
        await ctx.reply(await fmtDealCard(deal.id));
        await ctx.reply("Next: both sides accept terms.", {
          reply_markup: joinSuccessKeyboard(deal.dealCode),
        });
      } catch (e) {
        await ctx.reply(`❌ ${String((e as Error).message)}`);
      }
      return;
    }

    if (!user.termsAcceptedAt) {
      await ctx.reply(WELCOME, { parse_mode: "Markdown" });
      await ctx.reply(TERMS_TEXT, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("I agree to the Terms", "terms:ok"),
      });
      return;
    }

    await ctx.reply(WELCOME, {
      parse_mode: "Markdown",
      reply_markup: mainMenuKb(isAdminTelegramId(tid)),
    });
    await ctx.reply(
      "Use the menu when you need it — the bot also nudges you after each deal step.",
      {
        reply_markup: new InlineKeyboard().text("Create deal", "m:create").text("My deals", "m:deals"),
      },
    );
  }

  bot.command("start", async (ctx) => {
    const user = await requireUser(ctx);
    if (!user || !ctx.from) return;
    const tid = BigInt(ctx.from.id);
    const eff = await getEffectiveGatewayConfig();
    const isAdmin = isAdminTelegramId(tid);
    const needGw = eff.requireGatewayJoin && !isAdmin && !user.gatewayAcceptedAt;

    if (needGw) {
      const arg = startArg(ctx);
      if (arg?.startsWith("join_")) await setPendingJoinInvite(tid, arg.slice("join_".length));
      await ctx.reply(GATEWAY_ACCESS_REQUIRED_LONG, {
        reply_markup: gatewayAccessKeyboard(eff.joinUrl),
      });
      return;
    }

    await processMainOnboarding(ctx, user);
  });

  bot.callbackQuery(/^gw:continue$/, async (ctx) => {
    if (!ctx.from) return;
    const tid = BigInt(ctx.from.id);
    const isAdmin = isAdminTelegramId(tid);
    const eff = await getEffectiveGatewayConfig();

    if (!eff.requireGatewayJoin || isAdmin) {
      await ctx.answerCallbackQuery({ text: "No gateway step needed." });
      return;
    }

    let u = await requireUser(ctx);
    if (!u) {
      await ctx.answerCallbackQuery({ text: "Try /start", show_alert: true });
      return;
    }

    if (u.gatewayAcceptedAt) {
      await ctx.answerCallbackQuery({ text: "Already approved" });
      await ctx.reply(GATEWAY_ACCESS_APPROVED);
      const fresh = await findUserByTelegramId(tid);
      if (fresh) await processMainOnboarding(ctx, fresh);
      return;
    }

    let verified = false;
    let allowProceed = true;

    if (eff.chatId) {
      const v = await verifyGatewayChatMembership(ctx.api, eff.chatId, tid);
      if (v.ok) verified = true;
      else if (v.reason === "not_member") {
        allowProceed = false;
      } else {
        logGatewayVerificationSkipped(v.description, {
          telegram_user_id: tid.toString(),
          gateway_chat_id: eff.chatId,
        });
        verified = false;
        allowProceed = true;
      }
    }

    if (!allowProceed) {
      await ctx.answerCallbackQuery({ text: "Not confirmed", show_alert: true });
      await ctx.reply(GATEWAY_NOT_CONFIRMED, {
        reply_markup: gatewayAccessKeyboard(eff.joinUrl),
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Welcome" });

    u = await markUserGatewayAccess({ userId: u.id, verified });
    await ctx.reply(GATEWAY_ACCESS_APPROVED);

    await processMainOnboarding(ctx, u);
  });

  bot.callbackQuery(/^terms:ok$/, async (ctx) => {
    if (!ctx.from) return;
    await acceptTermsForUser(BigInt(ctx.from.id));
    await ctx.answerCallbackQuery({ text: "Terms accepted" });
    await ctx.editMessageText("Terms accepted. You're ready to use OGMP MM.");
    await ctx.reply(WELCOME, {
      parse_mode: "Markdown",
      reply_markup: mainMenuKb(isAdminTelegramId(BigInt(ctx.from.id))),
    });
    await ctx.reply("Start a deal or open one you were invited to.", {
      reply_markup: new InlineKeyboard().text("Create deal", "m:create").text("My deals", "m:deals"),
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
      await ctx.reply("No deals yet — create one or use an invite from your counterparty.", {
        reply_markup: new InlineKeyboard().text("Create deal", "m:create"),
      });
      return;
    }
    const kb = new InlineKeyboard();
    for (const d of deals) {
      kb.text(`${d.dealCode} (${d.status})`, `d:v:${d.dealCode}`).row();
    }
    await ctx.reply("Pick a deal to see status and the next action:", { reply_markup: kb });
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
    const lockedPre = await prisma.dealMessage.count({
      where: { dealId: deal.id, lockedForBuyer: true },
    });
    let hint = "";
    if (deal.status === "pending_acceptance") {
      hint =
        "\n\nNext: both parties accept terms. The buyer will then receive the escrow payment address.";
    } else if (deal.status === "waiting_payment" || deal.status === "payment_detected") {
      if (deal.buyerId === u.id) {
        hint = lockedPre
          ? "\n\nDelivery is locked. Send the exact amount on the correct network, then use I Have Paid or Check Payment."
          : "\n\nWaiting for the seller to upload delivery. You will get a payment notice when files are locked.";
      } else if (deal.sellerId === u.id) {
        hint =
          "\n\nUpload delivery first: open Upload / Deal room and send files (.pdf, .txt, .zip, images, video). The buyer pays after your delivery is locked.";
      } else {
        hint = "\n\nWait for both sides to accept terms and complete delivery / payment.";
      }
    } else if (deal.status === "funded") {
      if (deal.sellerId === u.id) {
        hint =
          "\n\nFunds are in escrow. Add more in Upload / Deal room if needed, or use Mark delivered if the buyer is not yet in review.";
      } else if (deal.buyerId === u.id) {
        hint = "\n\nCheck recent OGMP MM messages for files, or tap Download Files.";
      }
    } else if (deal.status === "item_delivered" && deal.buyerId === u.id) {
      hint = "\n\nReview the delivery, then confirm release or open a dispute.";
    } else if (deal.status === "item_delivered" && deal.sellerId === u.id) {
      hint = "\n\nWaiting for buyer confirmation.";
    }
    const kb = new InlineKeyboard();
    if (deal.status === "pending_acceptance") {
      kb.text("Accept terms", `d:a:${deal.dealCode}`).row();
    }
    if (deal.buyerId === u.id && (deal.status === "waiting_payment" || deal.status === "payment_detected")) {
      kb.text("I Have Paid", `bx:pay:${deal.dealCode}`).text("Check Payment", `bx:cp:${deal.dealCode}`).row();
    }
    if (deal.buyerId === u.id && deal.status === "item_delivered") {
      kb.text("Download Files", `bx:dl:${deal.dealCode}`).row();
    }
    if (deal.status === "funded" && deal.sellerId === u.id) {
      kb.text("Mark delivered", `d:del:${deal.dealCode}`).row();
    }
    if (deal.status === "item_delivered") {
      kb.text("Confirm received", `d:rel:${deal.dealCode}`).row();
    }
    if (
      deal.status === "waiting_payment" ||
      deal.status === "payment_detected" ||
      deal.status === "funded" ||
      deal.status === "item_delivered" ||
      deal.status === "buyer_confirmed" ||
      deal.status === "release_requested"
    ) {
      kb.text("Open dispute", `d:dp:${deal.dealCode}`).row();
    }
    if (deal.status === "pending_acceptance" || deal.status === "waiting_payment") {
      kb.text("Request cancel", `d:cx:${deal.dealCode}`).row();
    }
    kb.row().text("Upload / Deal room", `dr:enter:${deal.dealCode}`).row();
    kb.text("Timeline", `d:tl:${deal.dealCode}`).text("Delivery log", `d:pr:${deal.dealCode}`).row();
    kb.text("Report deal", `d:rp:${deal.dealCode}`);
    await ctx.reply(text + hint, { reply_markup: kb });
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
    if (deal.buyerId !== u.id && deal.sellerId !== u.id) {
      await ctx.answerCallbackQuery({ text: "Only buyer or seller can use report flow.", show_alert: true });
      return;
    }
    const cfg = loadConfig();
    if (!getReportBotToken()) {
      await ctx.answerCallbackQuery({ text: "Report bot not configured", show_alert: true });
      return;
    }
    try {
      const activeRep = await findSubmittedReviewReportForDeal(deal.id);
      const rb = cfg.REPORT_BOT_USERNAME ?? "OGMP_MM_REPORT_BOT";
      if (activeRep) {
        const { rawToken } = await createReportSession({ dealId: deal.id, userId: u.id });
        const url = `https://t.me/${rb}?start=report_${rawToken}`;
        await ctx.answerCallbackQuery({ text: "Deal under review — add evidence" });
        await ctx.reply(
          [
            "⚖ *This deal is already under admin review.*",
            `Report: \`${activeRep.reportCode}\` (${activeRep.status})`,
            "",
            "You can still *add screenshots, videos, documents, or archives* in **OGMP MM REPORT** using this secure, time-limited link:",
            url,
            "",
            "Upload what you need, then send `/append_done` in the report bot so admins are notified.",
            "",
            "_Do not share this link._",
          ].join("\n"),
          { parse_mode: "Markdown" },
        );
        return;
      }
      await assertCanOpenNewReport(deal.id, u.id);
      const { rawToken } = await createReportSession({ dealId: deal.id, userId: u.id });
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

  bot.callbackQuery(/^dl:sub:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const u = await requireUser(ctx);
    if (!u) return;
    const deal = await prisma.deal.findUnique({ where: { dealCode: ctx.match[1] } });
    if (!deal || deal.sellerId !== u.id) {
      await ctx.answerCallbackQuery({ text: "Seller only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Buyer notified" });
    const { resubmitSellerDeliveryNotify } = await import("../../services/delivery.service.js");
    await resubmitSellerDeliveryNotify(deal.id);
    await ctx.reply("The buyer was reminded to complete payment.");
  });

  bot.callbackQuery(/^bx:pay:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const code = ctx.match[1];
    const deal = await prisma.deal.findUnique({ where: { dealCode: code } });
    if (!deal) {
      await ctx.answerCallbackQuery({ text: "Not found", show_alert: true });
      return;
    }
    const { runBuyerPaymentCheck } = await import("../../modules/payments/buyer-payment-check.service.js");
    const msg = await runBuyerPaymentCheck(deal.id, BigInt(ctx.from.id));
    await ctx.answerCallbackQuery();
    await ctx.reply(msg);
  });

  bot.callbackQuery(/^bx:cp:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const code = ctx.match[1];
    const deal = await prisma.deal.findUnique({ where: { dealCode: code } });
    if (!deal) {
      await ctx.answerCallbackQuery({ text: "Not found", show_alert: true });
      return;
    }
    const { runBuyerPaymentCheck } = await import("../../modules/payments/buyer-payment-check.service.js");
    const msg = await runBuyerPaymentCheck(deal.id, BigInt(ctx.from.id));
    await ctx.answerCallbackQuery();
    await ctx.reply(msg);
  });

  bot.callbackQuery(/^bx:dl:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const u = await requireUser(ctx);
    if (!u) return;
    const deal = await prisma.deal.findUnique({ where: { dealCode: ctx.match[1] } });
    if (!deal || deal.buyerId !== u.id) {
      await ctx.answerCallbackQuery({ text: "Buyer only", show_alert: true });
      return;
    }
    if (deal.status !== "funded" && deal.status !== "item_delivered") {
      await ctx.answerCallbackQuery({ text: "Not available yet", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const { sendBuyerDeliveryBundleToChat } = await import("../../services/buyer-delivery-send.service.js");
    const r = await sendBuyerDeliveryBundleToChat({ buyerTelegramId: BigInt(ctx.from.id), dealId: deal.id });
    if (r.skipped) {
      await ctx.reply("Files were already sent. Scroll up in this chat for OGMP MM delivery messages.");
    } else {
      await ctx.reply(`Sent ${r.sent} file(s). Review carefully before confirming release.`);
    }
    const fresh = await prisma.deal.findUnique({ where: { id: deal.id } });
    if (fresh) {
      const ns = nextStepForActorReply(fresh, u.id);
      if (ns) await ctx.reply(ns.text, { reply_markup: ns.kb });
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
      await ctx.reply(await fmtDealCard(updated.id));
      if (updated.status === "pending_acceptance") {
        await notifyCounterpartyAfterTermsAccept(updated.id, u.id);
      } else if (updated.status === "waiting_payment" && updated.paymentAddress) {
        await notifyBothAfterPaymentLive(updated.id);
      }
      const ns = nextStepForActorReply(updated, u.id);
      if (ns) await ctx.reply(ns.text, { reply_markup: ns.kb });
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
      await ctx.reply(await fmtDealCard(d.id));
      const ns = nextStepForActorReply(d, u.id);
      if (ns) await ctx.reply(ns.text, { reply_markup: ns.kb });
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
      await ctx.reply(await fmtDealCard(d.id));
      const ns = nextStepForActorReply(d, u.id);
      if (ns) await ctx.reply(ns.text, { reply_markup: ns.kb });
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
      await ctx.reply(`Deal ${d.dealCode} is now ${d.status}.`);
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
    await ctx.reply(
      "Paste the invite link from your counterparty in this chat, or send:\n`/join <token>`",
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("My deals", "m:deals") },
    );
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
      .text("Force refund", "a:fref")
      .row()
      .text("Gateway settings", "a:gw:menu");
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

  bot.callbackQuery(/^a:gw:menu$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text("View gateway settings", "a:gw:view")
      .row()
      .text("Set join URL", "a:gw:prompt:url")
      .text("Set @ label", "a:gw:prompt:user")
      .row()
      .text("Set chat ID (verify)", "a:gw:prompt:chat")
      .text("Clear chat ID ov.", "a:gw:clearchat")
      .row()
      .text("Toggle requirement", "a:gw:toggle")
      .text("Clear DB overrides", "a:gw:clearall")
      .row()
      .text("« Admin panel", "m:admin");
    await ctx.reply("*Gateway (admin)*", { parse_mode: "Markdown", reply_markup: kb });
  });

  bot.callbackQuery(/^a:gw:view$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    await ctx.answerCallbackQuery();
    const snap = await getGatewayAdminSnapshot();
    const lines = [
      "*Effective*",
      `require: \`${String(snap.effective.requireGatewayJoin)}\``,
      `join URL: \`${snap.effective.joinUrl}\``,
      `label: \`${snap.effective.usernameLabel}\``,
      `chat id (verify): \`${snap.effective.chatId ?? "—"}\``,
      "",
      "*Env defaults*",
      `REQUIRE_GATEWAY_JOIN: \`${String(snap.env.REQUIRE_GATEWAY_JOIN)}\``,
      `GATEWAY_JOIN_URL: \`${snap.env.GATEWAY_JOIN_URL}\``,
      `GATEWAY_USERNAME: \`${snap.env.GATEWAY_USERNAME}\``,
      `GATEWAY_CHAT_ID: \`${snap.env.GATEWAY_CHAT_ID || "—"}\``,
      "",
      "*DB overrides (empty = inherit)*",
      `require override: \`${snap.overrides.requireJoin ?? "—"}\``,
      `join URL: \`${snap.overrides.joinUrl ?? "—"}\``,
      `username: \`${snap.overrides.username ?? "—"}\``,
      `chat id: \`${snap.overrides.chatId ?? "—"}\``,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.callbackQuery(/^a:gw:prompt:(url|user|chat)$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id)) || !ctx.match) return;
    const kind = ctx.match[1] as "url" | "user" | "chat";
    const field = kind === "user" ? "username" : kind === "chat" ? "chat_id" : "url";
    await setAdminGatewayExpect(BigInt(ctx.from.id), field);
    await ctx.answerCallbackQuery();
    if (field === "url") {
      await ctx.reply("Send the new *Join OGMP Gateway* URL as your next message (https://…). Send `cancel` to abort.", {
        parse_mode: "Markdown",
      });
    } else if (field === "username") {
      await ctx.reply("Send the display label (e.g. `@MyChannel`). Send `cancel` to abort.", { parse_mode: "Markdown" });
    } else {
      await ctx.reply(
        "Send the numeric *gateway chat/channel id* for membership checks (e.g. `-100…`). The main bot must be able to `getChatMember` there. Send `cancel` to abort.",
        { parse_mode: "Markdown" },
      );
    }
  });

  bot.callbackQuery(/^a:gw:clearchat$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    await deleteGatewaySetting(GATEWAY_SETTING_KEYS.CHAT_ID);
    await ctx.answerCallbackQuery({ text: "Cleared" });
    await ctx.reply("Gateway chat id override removed (falls back to env if set).");
  });

  bot.callbackQuery(/^a:gw:toggle$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const snap = await getGatewayAdminSnapshot();
    const next = !snap.effective.requireGatewayJoin;
    await setGatewaySetting(GATEWAY_SETTING_KEYS.REQUIRE_OVERRIDE, next ? "true" : "false");
    await ctx.answerCallbackQuery({ text: next ? "ON" : "OFF" });
    await ctx.reply(`Gateway requirement is now *${next ? "enabled" : "disabled"}* (DB override).`, {
      parse_mode: "Markdown",
    });
  });

  bot.callbackQuery(/^a:gw:clearall$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    await Promise.all([
      deleteGatewaySetting(GATEWAY_SETTING_KEYS.REQUIRE_OVERRIDE),
      deleteGatewaySetting(GATEWAY_SETTING_KEYS.JOIN_URL),
      deleteGatewaySetting(GATEWAY_SETTING_KEYS.USERNAME),
      deleteGatewaySetting(GATEWAY_SETTING_KEYS.CHAT_ID),
    ]);
    await ctx.answerCallbackQuery({ text: "Cleared" });
    await ctx.reply("All gateway DB overrides removed. Env values apply.");
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
      await ctx.reply(`Joined deal ${deal.dealCode}.`);
      await ctx.reply(await fmtDealCard(deal.id));
      await ctx.reply("Next: both sides accept terms.", {
        reply_markup: joinSuccessKeyboard(deal.dealCode),
      });
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
        .text("Export CSV", "a:csv")
        .text("Gateway settings", "a:gw:menu"),
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
      const link = me ? `https://t.me/${me}?start=join_${deal.inviteToken}` : `Invite token:\n${deal.inviteToken}`;
      await ctx.reply(`Deal ${deal.dealCode} is ready.\nSend this invite to your counterparty:`);
      await ctx.reply(link);
      await ctx.reply(await fmtDealCard(deal.id));
      await ctx.reply("Next: they join, then both sides accept terms.", {
        reply_markup: createDealSuccessKeyboard(deal.dealCode),
      });
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
    if (!isAdminTelegramId(BigInt(ctx.from.id))) return next();

    const exp = await getAdminGatewayExpect(BigInt(ctx.from.id));
    if (!exp) return next();

    const raw = ctx.message.text.trim();
    if (raw.toLowerCase() === "cancel") {
      await clearAdminGatewayExpect(BigInt(ctx.from.id));
      await ctx.reply("Cancelled.");
      return;
    }

    if (exp === "url") {
      let ok = false;
      try {
        const u = new URL(raw);
        ok = u.protocol === "http:" || u.protocol === "https:";
      } catch {
        ok = false;
      }
      if (!ok) {
        await ctx.reply("Invalid URL. Try again or send cancel.");
        return;
      }
      await setGatewaySetting(GATEWAY_SETTING_KEYS.JOIN_URL, raw);
      await clearAdminGatewayExpect(BigInt(ctx.from.id));
      await ctx.reply(`Saved join URL:\n\`${raw}\``, { parse_mode: "Markdown" });
      return;
    }
    if (exp === "username") {
      const label = raw.startsWith("@") ? raw : `@${raw.replace(/^@+/, "")}`;
      await setGatewaySetting(GATEWAY_SETTING_KEYS.USERNAME, label);
      await clearAdminGatewayExpect(BigInt(ctx.from.id));
      await ctx.reply(`Saved gateway label: \`${label}\``, { parse_mode: "Markdown" });
      return;
    }
    if (exp === "chat_id") {
      if (!/^-?\d+$/.test(raw)) {
        await ctx.reply("Chat ID must be numeric (e.g. -100…). Try again or send cancel.");
        return;
      }
      await setGatewaySetting(GATEWAY_SETTING_KEYS.CHAT_ID, raw);
      await clearAdminGatewayExpect(BigInt(ctx.from.id));
      await ctx.reply(`Saved gateway chat id: \`${raw}\``, { parse_mode: "Markdown" });
      return;
    }
    return next();
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
