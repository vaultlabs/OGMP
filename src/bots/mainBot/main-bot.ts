import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { loadConfig, isAdminTelegramId, getMainBotToken, getReportBotToken } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import { redisIncrWithTtl } from "../../utils/redis.js";
import { prisma } from "../../db/prisma.js";
import type { ParticipantRole, User } from "@prisma/client";
import { Prisma } from "@prisma/client";
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
  gatewayAccessKeyboard,
} from "../../modules/gateway/gateway-messages.js";
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
import { TERMS_TEXT } from "./messages.js";
import {
  COMMUNITY_TRUST_LINE,
  HOW_IT_WORKS_PAGE,
  PREMIUM_WELCOME,
  SAFETY_RULES_PAGE,
  TRUST_OPS_FOOTER,
  WHY_TRUST_PAGE,
  supportPageText,
} from "./trust-copy.js";
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
import { applyReview, appendReviewOptionalText } from "../../services/reputation.service.js";
import { formatReceiptPlain, rateButtons } from "../../services/deal-completion-notify.service.js";
import { getAdminDashboardSnapshot } from "../../modules/admin/admin-dashboard.service.js";
import {
  clearBroadcastDraft,
  clearBroadcastPhotoWait,
  getBroadcastDraft,
  parseBroadcastCommandBody,
  runBroadcastFanout,
  setBroadcastDraft,
  setBroadcastPhotoWait,
  peekBroadcastPhotoWait,
} from "../../modules/admin/admin-broadcast.service.js";
import {
  clearReviewTextWait,
  peekReviewTextWait,
  setReviewTextWait,
} from "../../modules/users/review-optional-text.service.js";
import { computeCommunityBadge } from "../../modules/users/user-trust-badge.js";
import { reviewSchema } from "../../modules/deals/deal.validation.js";
import type { CreateDealInput } from "../../modules/deals/deal.service.js";
import { userFacingDealStatus, userFacingDeliveryState } from "../../modules/deals/user-facing-status.js";
import { escapeTelegramHtml } from "../../utils/telegram-html.js";
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
    .text("Create Deal", "m:create")
    .text("My Deals", "m:deals")
    .row()
    .text("Join Deal", "m:join")
    .row()
    .text("How It Works", "m:how")
    .text("Why Trust OGMP MM", "m:why")
    .row()
    .text("Profile", "m:profile")
    .text("Support", "m:support")
    .row()
    .text("Safety Rules", "m:safety")
    .text("Terms", "m:terms");
  if (isAdmin) kb.row().text("Admin", "m:admin");
  return kb;
}

function fmtUserLine(u: { telegramId: bigint; username: string | null; firstName: string | null }): string {
  const un = u.username ? `@${u.username}` : "no username";
  return `${u.firstName ?? "User"} (${un}, id ${u.telegramId.toString()})`;
}

/**
 * HTML for Telegram <code>parse_mode: "HTML"</code> — user/deal text is escaped; line breaks use newlines.
 * @param viewerUserId Prisma user id of the reader (hides raw escrow address from buyer until seller locks delivery).
 */
async function fmtDealCard(dealId: string, viewerUserId: string | null = null): Promise<string> {
  const e = escapeTelegramHtml;
  const d = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true, seller: true, activeReport: true },
  });
  if (!d) return e("Deal not found.");
  const buyer = d.buyer ? fmtUserLine(d.buyer) : "(pending)";
  const seller = d.seller ? fmtUserLine(d.seller) : "(pending)";
  const [sellerLockedCount, msgCount, lastEv, pay] = await Promise.all([
    d.sellerId
      ? prisma.dealMessage.count({
          where: { dealId, lockedForBuyer: true, senderId: d.sellerId },
        })
      : Promise.resolve(0),
    prisma.dealMessage.count({ where: { dealId } }),
    prisma.dealTimelineEvent.findFirst({
      where: { dealId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } }),
  ]);
  const displayStatus = userFacingDealStatus(d, {
    hasLockedDelivery: sellerLockedCount > 0,
    paymentStatus: pay?.status ?? null,
  });
  const delivery = userFacingDeliveryState(d.status, sellerLockedCount > 0);
  const termsPreview = `${d.dealTerms.slice(0, 300)}${d.dealTerms.length > 300 ? "…" : ""}`;
  const hideEscrowFromBuyer =
    !!viewerUserId &&
    d.buyerId === viewerUserId &&
    (d.status === "waiting_payment" || d.status === "payment_detected") &&
    sellerLockedCount === 0;

  const lines: string[] = [
    "━━━━━━━━━━━━━━━━━━",
    "OGMP MM — Deal Room",
    "━━━━━━━━━━━━━━━━━━",
    "",
    `<b>Deal ID</b>: ${e(d.dealCode)}`,
    `<b>Status</b>: ${e(displayStatus)}${d.frozen ? " (frozen)" : ""}`,
    `<b>Buyer</b>: ${e(buyer)}`,
    `<b>Seller</b>: ${e(seller)}`,
    `<b>Amount</b>: ${e(d.amount.toString())} ${e(d.currency)} (${e(d.network)})`,
    `<b>Fee</b>: ${e(d.feeAmount.toString())} (${e(String(d.feePayer))})`,
    `<b>Escrow step</b>: ${pay ? e(pay.status.replace(/_/g, " ")) : "—"}`,
    `<b>Delivery Vault</b>: ${e(delivery)}`,
    `<b>Deal Protection</b>: ${d.frozen ? e("paused — Case Review") : e("on")}`,
    d.activeReport
      ? `<b>Case Review</b>: ${e(d.activeReport.reportCode)} (${e(d.activeReport.status.replace(/_/g, " "))})`
      : "<b>Case Review</b>: none open",
    `<b>Files submitted</b>: ${String(msgCount)}`,
    "Folders: send .zip / .rar / .7z or one file per message (no folder upload).",
    `<b>Last activity</b>: ${e(d.lastActivityAt.toISOString().slice(0, 19))}Z`,
    `<b>Created</b>: ${e(d.createdAt.toISOString().slice(0, 10))}`,
    `<b>Terms</b>:
${e(termsPreview)}`,
  ];
  if (lastEv) lines.push(`<b>Latest event</b>: ${e(lastEv.eventType)}`);
  if (d.paymentAddress && d.status !== "pending_acceptance") {
    if (hideEscrowFromBuyer) {
      lines.push(
        "",
        `<b>Escrow pay</b>: After the Delivery Vault locks, you’ll get a DM with the address. Until then, no payment.`,
        `<i>${e("Never use an address from outside this bot.")}</i>`,
      );
    } else {
      lines.push(
        "",
        `<b>Escrow pay</b>:`,
        `<code>${e(d.paymentAddress)}</code>`,
        `<b>Exact amount</b>: ${e(d.amount.toString())} ${e(d.currency)} on ${e(d.network)}`,
        `<i>${e("Wrong network = loss. Never pay outside OGMP MM.")}</i>`,
      );
    }
  }
  lines.push("", `<i>${e(TRUST_OPS_FOOTER)}</i>`, `<i>${e(COMMUNITY_TRUST_LINE)}</i>`);
  return lines.join("\n");
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
        await ctx.reply(await fmtDealCard(deal.id, user.id), { parse_mode: "HTML" });
        await ctx.reply("Next: both sides accept terms.", {
          reply_markup: joinSuccessKeyboard(deal.dealCode),
        });
      } catch (e) {
        await ctx.reply(`❌ ${String((e as Error).message)}`);
      }
      return;
    }

    if (!user.termsAcceptedAt) {
      await ctx.reply(PREMIUM_WELCOME);
      await ctx.reply(TERMS_TEXT, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("I agree to the Terms", "terms:ok"),
      });
      return;
    }

    await ctx.reply(PREMIUM_WELCOME, {
      reply_markup: mainMenuKb(isAdminTelegramId(tid)),
    });
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

    // Show gateway join UX, but do not enforce real membership (no getChatMember gate).
    await ctx.answerCallbackQuery({ text: "Welcome" });

    u = await markUserGatewayAccess({ userId: u.id, verified: false });
    await ctx.reply(GATEWAY_ACCESS_APPROVED);

    await processMainOnboarding(ctx, u);
  });

  bot.callbackQuery(/^terms:ok$/, async (ctx) => {
    if (!ctx.from) return;
    await acceptTermsForUser(BigInt(ctx.from.id));
    await ctx.answerCallbackQuery({ text: "Terms accepted" });
    await ctx.editMessageText("Terms accepted. You're ready to use OGMP MM.");
    await ctx.reply(PREMIUM_WELCOME, {
      reply_markup: mainMenuKb(isAdminTelegramId(BigInt(ctx.from.id))),
    });
  });

  bot.callbackQuery(/^m:menu$/, async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();
    await ctx.reply(PREMIUM_WELCOME, {
      reply_markup: mainMenuKb(isAdminTelegramId(BigInt(ctx.from.id))),
    });
  });

  bot.callbackQuery(/^m:how$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(HOW_IT_WORKS_PAGE, {
      reply_markup: new InlineKeyboard()
        .text("Create Deal", "m:create")
        .text("Join Deal", "m:join")
        .row()
        .text("Back", "m:menu"),
    });
  });

  bot.callbackQuery(/^m:why$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(WHY_TRUST_PAGE, {
      reply_markup: new InlineKeyboard()
        .text("Create Deal", "m:create")
        .text("How It Works", "m:how")
        .row()
        .text("Back", "m:menu"),
    });
  });

  bot.callbackQuery(/^m:safety$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(SAFETY_RULES_PAGE, {
      reply_markup: new InlineKeyboard().text("I Understand", "m:menu").row().text("Back", "m:menu"),
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

  bot.callbackQuery(/^w:party:skip$/, async (ctx) => {
    if (!ctx.from) return;
    const w = await getCreateWizard(BigInt(ctx.from.id));
    if (!w || w.step !== "party_terms") {
      await ctx.answerCallbackQuery({ text: "Wizard expired — /create", show_alert: true });
      return;
    }
    await setCreateWizard(BigInt(ctx.from.id), {
      step: "amount",
      creatorRole: w.creatorRole,
      title: w.title,
      description: w.description,
      partyTermsExtra: "",
    });
    await ctx.answerCallbackQuery();
    await ctx.reply("Enter numeric deal amount (crypto units, e.g. `100.5`):", { parse_mode: "Markdown" });
  });

  bot.callbackQuery(/^w:party:custom$/, async (ctx) => {
    if (!ctx.from) return;
    const w = await getCreateWizard(BigInt(ctx.from.id));
    if (!w || w.step !== "party_terms") {
      await ctx.answerCallbackQuery({ text: "Wizard expired — /create", show_alert: true });
      return;
    }
    await setCreateWizard(BigInt(ctx.from.id), {
      step: "party_terms_text",
      creatorRole: w.creatorRole,
      title: w.title,
      description: w.description,
    });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Send your additional terms in one message (minimum 10 characters). Examples: delivery deadline, warranty, refund conditions, or what each side guarantees.",
    );
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
    const text = await fmtDealCard(deal.id, u.id);
    const lockedPre = deal.sellerId
      ? await prisma.dealMessage.count({
          where: { dealId: deal.id, lockedForBuyer: true, senderId: deal.sellerId },
        })
      : 0;
    let hint = "";
    if (deal.status === "pending_acceptance") {
      hint =
        "\n\nWhat: terms step.\nSafe: no escrow pay until Delivery Vault locks.\nNext: both accept terms, then seller fills the vault.";
    } else if (deal.status === "waiting_payment" || deal.status === "payment_detected") {
      if (deal.buyerId === u.id) {
        hint = lockedPre
          ? "\n\nWhat: Deal Protection — vault locked.\nSafe: escrow address is valid only from this bot.\nNext: pay exact amount → I Have Paid / Check Payment."
          : "\n\nWhat: waiting on Delivery Vault.\nSafe: you are not asked to pay yet.\nNext: wait for Payment Required DM.";
      } else if (deal.sellerId === u.id) {
        hint =
          "\n\nWhat: your turn to fill the Delivery Vault.\nSafe: files stay locked until buyer pays.\nNext: Deal room → upload → Submit Delivery.";
      } else {
        hint = "\n\nWhat: deal is starting.\nSafe: follow in-bot steps only.\nNext: wait for participants.";
      }
    } else if (deal.status === "funded") {
      if (deal.sellerId === u.id) {
        hint =
          "\n\nWhat: buyer can access the vault.\nSafe: escrow still holds funds.\nNext: add files if needed, or Mark delivered.";
      } else if (deal.buyerId === u.id) {
        hint = "\n\nWhat: Delivery Vault unlocked.\nSafe: escrow until Buyer Review ends.\nNext: check DMs / Download Files.";
      }
    } else if (deal.status === "item_delivered" && deal.buyerId === u.id) {
      hint = "\n\nWhat: Buyer Review.\nSafe: escrow until you confirm.\nNext: Confirm Received — or Open Case if wrong.";
    } else if (deal.status === "item_delivered" && deal.sellerId === u.id) {
      hint = "\n\nWhat: Buyer Review.\nSafe: funds still in escrow.\nNext: wait for buyer confirm or Case Review.";
    }
    const kb = new InlineKeyboard();
    if (deal.status === "pending_acceptance") {
      kb.text("Accept terms", `d:a:${deal.dealCode}`).row();
    }
    if (
      deal.buyerId === u.id &&
      lockedPre > 0 &&
      (deal.status === "waiting_payment" || deal.status === "payment_detected")
    ) {
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
      kb.text("Hold deal", `d:dp:${deal.dealCode}`).row();
    }
    if (deal.status === "pending_acceptance" || deal.status === "waiting_payment") {
      kb.text("Request cancel", `d:cx:${deal.dealCode}`).row();
    }
    kb.row().text("Upload / Deal room", `dr:enter:${deal.dealCode}`).row();
    kb.text("Timeline", `d:tl:${deal.dealCode}`).text("Delivery log", `d:pr:${deal.dealCode}`).row();
    kb.text("Open Case", `d:rp:${deal.dealCode}`);
    await ctx.reply(text + hint, { parse_mode: "HTML", reply_markup: kb });
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
        await ctx.answerCallbackQuery({ text: "Case Review — add evidence" });
        await ctx.reply(
          [
            "━━━━━━━━━━━━━━━━━━",
            "OGMP MM — Case Review",
            "━━━━━━━━━━━━━━━━━━",
            "",
            "What: case already open — add evidence.",
            "Safe: keep using the linked REPORT bot session only.",
            "Next: upload files there, then `/append_done`.",
            "",
            `Code: \`${activeRep.reportCode}\` (${activeRep.status})`,
            "",
            url,
          ].join("\n"),
          { parse_mode: "Markdown" },
        );
        return;
      }
      await assertCanOpenNewReport(deal.id, u.id);
      const { rawToken } = await createReportSession({ dealId: deal.id, userId: u.id });
      const url = `https://t.me/${rb}?start=report_${rawToken}`;
      await ctx.answerCallbackQuery({ text: "Case Review opening" });
      await ctx.reply(
        [
          "━━━━━━━━━━━━━━━━━━",
          "OGMP MM — Case Review",
          "━━━━━━━━━━━━━━━━━━",
          "",
          "What: submit evidence in OGMP MM REPORT.",
          "Safe: deal stays linked; don’t move pay outside the bot.",
          "Next: open the link, upload proof, follow prompts.",
          "",
          url,
          "",
          "_Private link — don’t share._",
        ].join("\n"),
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
    await ctx.answerCallbackQuery();
    await ctx.reply("Checking payment status…");
    const msg = await runBuyerPaymentCheck(deal.id, BigInt(ctx.from.id));
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
    await ctx.answerCallbackQuery();
    await ctx.reply("Checking payment status…");
    const msg = await runBuyerPaymentCheck(deal.id, BigInt(ctx.from.id));
    await ctx.reply(msg);
  });

  bot.callbackQuery(/^bx:addr:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const u = await requireUser(ctx);
    if (!u) return;
    const deal = await prisma.deal.findUnique({ where: { dealCode: ctx.match[1] } });
    if (!deal || deal.buyerId !== u.id || !deal.paymentAddress) {
      await ctx.answerCallbackQuery({ text: "Unavailable", show_alert: true });
      return;
    }
    const locked = deal.sellerId
      ? await prisma.dealMessage.count({
          where: { dealId: deal.id, lockedForBuyer: true, senderId: deal.sellerId },
        })
      : 0;
    if (locked === 0) {
      await ctx.answerCallbackQuery({
        text: "Address is available after the seller locks delivery.",
        show_alert: true,
      });
      return;
    }
    const addr = deal.paymentAddress;
    const alertText = addr.length > 180 ? `${addr.slice(0, 160)}…` : addr;
    await ctx.answerCallbackQuery({ text: alertText, show_alert: true });
    await ctx.reply(`Escrow address (long-press to copy):\n\n${addr}`);
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
      await ctx.reply(await fmtDealCard(updated.id, u.id), { parse_mode: "HTML" });
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
      await ctx.reply(await fmtDealCard(d.id, u.id), { parse_mode: "HTML" });
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
      await ctx.reply(await fmtDealCard(d.id, u.id), { parse_mode: "HTML" });
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
      await ctx.answerCallbackQuery({ text: "Case opened" });
      await ctx.reply(
        [
          "━━━━━━━━━━━━━━━━━━",
          "OGMP MM — Case Review",
          "━━━━━━━━━━━━━━━━━━",
          "",
          "What: deal is on admin hold.",
          "Safe: funds/files stay under Deal Protection until admins decide.",
          "Next: open your deal card → Open Case (REPORT) to add evidence.",
          "",
          "Upload clear proof so Case Review moves faster.",
          "",
          TRUST_OPS_FOOTER,
        ].join("\n"),
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
    const community = computeCommunityBadge(u);
    const adminBadge = u.profileBadge?.trim() || "—";
    const un = u.username ? `@${u.username}` : "no username";
    await ctx.reply(
      [
        "━━━━━━━━━━━━━━━━━━",
        "OGMP MM — Profile",
        "━━━━━━━━━━━━━━━━━━",
        "",
        "What: your trading snapshot here.",
        "Safe: badges don’t move funds — Deal Protection rules still apply per deal.",
        "Next: My Deals to jump back in.",
        "",
        `User: ${u.firstName ?? "User"} (${un})`,
        `Status: ${u.banned ? "Restricted" : "Active"}`,
        `Completed deals: ${u.completedDeals}`,
        `Total volume (USD field): ${u.totalVolumeUsd.toString()}`,
        `Rating: ${u.reputationScore.toString()} ⭐`,
        `Case holds (lifetime): ${u.disputedDeals}`,
        `Joined: ${u.joinedAt.toISOString().slice(0, 10)}`,
        `Community tier: ${community}`,
        `Admin badge: ${adminBadge}`,
        "",
        "Community:",
        "Part of the 1,100+ member OGMP network",
        "",
        TRUST_OPS_FOOTER,
      ].join("\n"),
      { reply_markup: new InlineKeyboard().text("My Deals", "m:deals").text("Back", "m:menu") },
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
    const cfg = loadConfig();
    const kb = new InlineKeyboard().text("Open Case", "m:deals");
    const h = cfg.SUPPORT_USERNAME?.trim().replace(/^@+/, "");
    if (h) kb.url("Contact Support", `https://t.me/${h}`);
    else kb.text("Contact Support", "m:supportfmt");
    kb.row().text("View Safety Rules", "m:safety").text("Back", "m:menu");
    await ctx.reply(supportPageText(cfg.SUPPORT_USERNAME), { reply_markup: kb });
  });

  bot.callbackQuery(/^m:supportfmt$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Send `/support <issue_type> | <message> | optional_deal_code` (pipe-separated). You may attach a photo after sending the text.",
      { reply_markup: new InlineKeyboard().text("Back", "m:support") },
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
      .text("Dashboard", "a:dash")
      .row()
      .text("Active deals", "a:act")
      .text("Open cases", "a:oc")
      .row()
      .text("Release requests", "a:relq")
      .text("Disputed deals", "a:dis")
      .row()
      .text("Users", "a:users")
      .text("Broadcast", "a:bc:help")
      .row()
      .text("Export CSV", "a:csv")
      .text("Gateway", "a:gw:menu")
      .row()
      .text("Force release (reply id next)", "a:fr")
      .text("Force refund", "a:fref");
    await ctx.reply(
      [
        "━━━━━━━━━━━━━━━━━━",
        "OGMP MM — Admin Dashboard",
        "━━━━━━━━━━━━━━━━━━",
        "",
        "Pick a tool below. Dashboard shows live counters.",
        "",
        TRUST_OPS_FOOTER,
      ].join("\n"),
      { reply_markup: kb },
    );
  });

  bot.callbackQuery(/^a:dash$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const s = await getAdminDashboardSnapshot();
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "━━━━━━━━━━━━━━━━━━",
        "OGMP MM — Admin Dashboard",
        "━━━━━━━━━━━━━━━━━━",
        "",
        `Active deals: ${s.activeDeals}`,
        `Funded: ${s.fundedDeals}`,
        `Release requests: ${s.releaseRequested}`,
        `Open cases (reports): ${s.openReports}`,
        `Frozen deals: ${s.frozenDeals}`,
        `Disputed deals: ${s.disputedDeals}`,
        `Completed deals: ${s.completedDeals}`,
        `Users: ${s.totalUsers}`,
        `Fees (released deals, sum): ${s.feesEarnedApprox}`,
        "",
        TRUST_OPS_FOOTER,
      ].join("\n"),
      {
        reply_markup: new InlineKeyboard()
          .text("Active deals", "a:act")
          .text("Open cases", "a:oc")
          .row()
          .text("Release requests", "a:relq")
          .text("Broadcast", "a:bc:help")
          .row()
          .text("Export CSV", "a:csv")
          .text("Gateway", "a:gw:menu")
          .row()
          .text("Back", "m:admin"),
      },
    );
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

  bot.callbackQuery(/^a:oc$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const reps = await prisma.report.findMany({
      where: { status: { in: ["submitted", "under_review", "waiting_for_buyer", "waiting_for_seller"] } },
      take: 25,
      orderBy: { createdAt: "desc" },
    });
    await ctx.answerCallbackQuery();
    await ctx.reply(reps.length ? reps.map((r) => `${r.reportCode} — ${r.status}`).join("\n") : "No open cases.");
  });

  bot.callbackQuery(/^a:relq$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const deals = await prisma.deal.findMany({
      where: { status: "release_requested" },
      take: 25,
      orderBy: { updatedAt: "desc" },
    });
    await ctx.answerCallbackQuery();
    await ctx.reply(deals.length ? deals.map((d) => `${d.dealCode}`).join("\n") : "No release requests.");
  });

  bot.callbackQuery(/^a:users$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const active = await prisma.user.count({ where: { banned: false } });
    const banned = await prisma.user.count({ where: { banned: true } });
    await ctx.answerCallbackQuery();
    await ctx.reply(`Users (active): ${active}\nBanned: ${banned}`);
  });

  bot.callbackQuery(/^a:bc:help$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "Official broadcast (`/broadcast`):",
        "",
        "• Text: `/broadcast Your message here`",
        "• With URL button: message|||Button label|||https://example.com",
        "• Photo: `/broadcastphoto` then send a photo (caption optional) within 5 minutes.",
        "",
        "You will get Confirm / Cancel before anything is sent.",
      ].join("\n"),
      { reply_markup: new InlineKeyboard().text("« Admin", "m:admin") },
    );
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
      await ctx.reply(await fmtDealCard(deal.id, user.id), { parse_mode: "HTML" });
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
      [
        "What: admin hold on a live deal.",
        "Safe: use Deal Protection — don’t move pay outside the bot.",
        "Next: open the deal card → Hold deal, then Open Case to upload evidence in REPORT.",
        "",
        "General questions: `/support ...` with your deal code.",
      ].join("\n"),
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
      partyTermsExtra: w.partyTermsExtra ?? "",
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
    const customTerms = !draft.dealTerms.includes("Party-agreed additions: none");
    await setCreateWizard(BigInt(ctx.from.id), { step: "confirm", draft });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "*Confirm deal*",
        `Role: ${draft.creatorRole}`,
        `Title: ${draft.title}`,
        `Amount: ${draft.amount} ${draft.currency} (${draft.network})`,
        `Fee payer: ${draft.feePayer}`,
        `Written party terms / guarantees: ${customTerms ? "Yes (see Terms on the deal card)" : "No — standard escrow wording only"}`,
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
      await ctx.reply(await fmtDealCard(deal.id, u.id), { parse_mode: "HTML" });
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
    const tid = BigInt(ctx.from.id);
    const pendingDealId = await peekReviewTextWait(tid);
    if (!pendingDealId) return next();
    const u = await requireUser(ctx);
    if (!u) return next();
    const deal = await prisma.deal.findUnique({
      where: { id: pendingDealId },
      select: { id: true, buyerId: true, sellerId: true, status: true },
    });
    if (!deal || deal.status !== "released" || (deal.buyerId !== u.id && deal.sellerId !== u.id)) {
      await clearReviewTextWait(tid);
      return next();
    }
    const ok = await appendReviewOptionalText({
      dealId: deal.id,
      fromUserId: u.id,
      text: ctx.message.text.trim(),
    });
    if (ok) {
      await clearReviewTextWait(tid);
      await ctx.reply("Thanks — your optional review text is saved.");
      return;
    }
    await clearReviewTextWait(tid);
    return next();
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
        step: "party_terms",
        creatorRole: w.creatorRole,
        title: w.title,
        description: text.slice(0, 4000),
      });
      await ctx.reply(
        "Optional: add written guarantees, warranties, deadlines, or other conditions both sides should agree to (recommended for high-value trades).",
        {
          reply_markup: new InlineKeyboard()
            .text("Skip — summary only", "w:party:skip")
            .row()
            .text("Add custom terms…", "w:party:custom"),
        },
      );
      return;
    }
    if (w.step === "party_terms_text") {
      if (text.length < 10) {
        await ctx.reply("Too short — at least 10 characters, or send /create to restart.");
        return;
      }
      await setCreateWizard(BigInt(ctx.from.id), {
        step: "amount",
        creatorRole: w.creatorRole,
        title: w.title,
        description: w.description,
        partyTermsExtra: text.slice(0, 4000),
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
        partyTermsExtra: w.partyTermsExtra ?? "",
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

  bot.callbackQuery(/^rstar:(.+):(B|S):([1-5])$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const dealCode = ctx.match[1]!;
    const slot = ctx.match[2] as "B" | "S";
    const stars = Number(ctx.match[3]!);
    const me = await requireUser(ctx);
    if (!me) return;
    const deal = await prisma.deal.findUnique({
      where: { dealCode },
      include: { buyer: true, seller: true },
    });
    if (!deal || deal.status !== "released" || !deal.buyerId || !deal.sellerId) {
      await ctx.answerCallbackQuery({ text: "Not available", show_alert: true });
      return;
    }
    if (deal.buyerId !== me.id && deal.sellerId !== me.id) {
      await ctx.answerCallbackQuery({ text: "Not your deal", show_alert: true });
      return;
    }
    const toUserId = slot === "S" ? deal.sellerId : deal.buyerId;
    if (me.id === toUserId) {
      await ctx.answerCallbackQuery({ text: "Invalid action", show_alert: true });
      return;
    }
    try {
      await applyReview({
        dealId: deal.id,
        fromUserId: me.id,
        toUserId,
        stars,
      });
      await setReviewTextWait(BigInt(ctx.from.id), deal.id);
      await ctx.answerCallbackQuery({ text: "Saved — thanks" });
      await ctx.reply(
        "Optional: send one short message with extra feedback for your rating, or use /skipreview to skip.",
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        await ctx.answerCallbackQuery({ text: "You already rated this deal.", show_alert: true });
        return;
      }
      throw e;
    }
  });

  bot.callbackQuery(/^rcpt:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const dealCode = ctx.match[1]!;
    const me = await requireUser(ctx);
    if (!me) return;
    const deal = await prisma.deal.findUnique({
      where: { dealCode },
      include: { buyer: true, seller: true },
    });
    if (!deal || deal.status !== "released") {
      await ctx.answerCallbackQuery({ text: "Receipt not available", show_alert: true });
      return;
    }
    if (deal.buyerId !== me.id && deal.sellerId !== me.id) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(formatReceiptPlain(deal));
  });

  bot.callbackQuery(/^ropen:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const dealCode = ctx.match[1]!;
    const me = await requireUser(ctx);
    if (!me) return;
    const deal = await prisma.deal.findUnique({
      where: { dealCode },
      include: { buyer: true, seller: true },
    });
    if (!deal || deal.status !== "released" || !deal.buyerId || !deal.sellerId) {
      await ctx.answerCallbackQuery({ text: "Not available", show_alert: true });
      return;
    }
    if (deal.buyerId !== me.id && deal.sellerId !== me.id) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    const existing = await prisma.review.findUnique({
      where: { dealId_fromUserId: { dealId: deal.id, fromUserId: me.id } },
    });
    if (existing) {
      await ctx.answerCallbackQuery({ text: "You already rated this deal.", show_alert: true });
      return;
    }
    const targetSlot: "B" | "S" = me.id === deal.buyerId ? "S" : "B";
    const who = targetSlot === "S" ? "seller" : "buyer";
    await ctx.answerCallbackQuery();
    const rb = rateButtons(deal.dealCode, targetSlot);
    const kb = new InlineKeyboard();
    rb.forEach((row, i) => {
      for (const b of row) kb.text(b.text, b.cb);
      if (i < rb.length - 1) kb.row();
    });
    await ctx.reply(
      [
        "━━━━━━━━━━━━━━━━━━",
        "Rate this deal",
        "━━━━━━━━━━━━━━━━━━",
        "",
        `What: rate the ${who}.`,
        "Safe: deal already completed.",
        "Next: tap 1–5; optional one-line note after.",
        "",
        TRUST_OPS_FOOTER,
      ].join("\n"),
      { reply_markup: kb },
    );
  });

  bot.callbackQuery(/^bc:go$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const tid = BigInt(ctx.from.id);
    const d = await getBroadcastDraft(tid);
    if (!d) {
      await ctx.answerCallbackQuery({ text: "Draft expired — run /broadcast again", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Sending…" });
    await clearBroadcastDraft(tid);
    const r = await runBroadcastFanout(ctx.api, d);
    await ctx.reply(`Broadcast finished.\nSent: ${r.sent}\nErrors: ${r.errors}`);
  });

  bot.callbackQuery(/^bc:cx$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    await clearBroadcastDraft(BigInt(ctx.from.id));
    await ctx.answerCallbackQuery({ text: "Cancelled" });
  });

  bot.command("broadcast", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const raw = ctx.message?.text?.replace(/^\/broadcast(@\w+)?\s*/i, "").trim() ?? "";
    if (!raw) {
      await ctx.reply("Usage: `/broadcast your message` or `text|||Button|||https://example.com`");
      return;
    }
    let draft;
    try {
      draft = parseBroadcastCommandBody(raw);
    } catch {
      await ctx.reply("Could not parse broadcast. Use https URLs only for buttons.");
      return;
    }
    await setBroadcastDraft(BigInt(ctx.from.id), draft);
    await ctx.reply("Confirm official broadcast to all users?", {
      reply_markup: new InlineKeyboard().text("Confirm", "bc:go").text("Cancel", "bc:cx"),
    });
  });

  bot.command("broadcastphoto", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    await setBroadcastPhotoWait(BigInt(ctx.from.id));
    await ctx.reply("Send a photo in this chat within 5 minutes (optional caption).");
  });

  bot.on("message:photo", async (ctx, next) => {
    if (!ctx.from) return next();
    if (!isAdminTelegramId(BigInt(ctx.from.id))) return next();
    if (!(await peekBroadcastPhotoWait(BigInt(ctx.from.id)))) return next();
    await clearBroadcastPhotoWait(BigInt(ctx.from.id));
    const photos = ctx.message.photo;
    const fid = photos?.length ? photos[photos.length - 1]!.file_id : undefined;
    const cap = (ctx.message.caption ?? "").trim() || "Official announcement";
    if (!fid) return next();
    await setBroadcastDraft(BigInt(ctx.from.id), { text: cap.slice(0, 1024), photoFileId: fid });
    await ctx.reply("Confirm official photo broadcast to all users?", {
      reply_markup: new InlineKeyboard().text("Confirm", "bc:go").text("Cancel", "bc:cx"),
    });
  });

  bot.command("setbadge", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const parts = ctx.message?.text?.trim().split(/\s+/) ?? [];
    if (parts.length < 3) {
      await ctx.reply("Usage: `/setbadge @username Badge Name` or `/setbadge TELEGRAM_ID Badge Name`");
      return;
    }
    const target = parts[1]!;
    const badge = parts.slice(2).join(" ").slice(0, 64);
    let user: User | null = null;
    if (target.startsWith("@")) {
      const uname = target.replace(/^@+/, "").toLowerCase();
      user = await prisma.user.findFirst({
        where: { username: { equals: uname, mode: "insensitive" } },
      });
    } else if (/^\d+$/.test(target)) {
      try {
        user = await prisma.user.findUnique({ where: { telegramId: BigInt(target) } });
      } catch {
        user = null;
      }
    }
    if (!user) {
      await ctx.reply("User not found.");
      return;
    }
    await prisma.user.update({ where: { id: user.id }, data: { profileBadge: badge } });
    await ctx.reply(`Badge updated: ${badge}`);
  });

  bot.command("skipreview", async (ctx) => {
    if (!ctx.from) return;
    await clearReviewTextWait(BigInt(ctx.from.id));
    await ctx.reply("Okay — no optional review text will be added.");
  });

  return bot;
}
