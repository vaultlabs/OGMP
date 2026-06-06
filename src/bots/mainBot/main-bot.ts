import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { loadConfig, isAdminTelegramId, getMainBotToken, getReportBotToken, getReportBotUsernameForDeepLinks } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import { replyTextForCaughtError } from "../../utils/user-facing-errors.js";
import { replyOrEditCallbackMessage } from "../../utils/telegram-callback.js";
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
import { GATEWAY_ACCESS_APPROVED } from "../../modules/gateway/gateway-messages.js";
import {
  clearGatewayPromptDedup,
  replyGatewayAccessPrompt,
} from "../../modules/gateway/gateway-prompt.service.js";
import { PAYMENT_EXACT_AMOUNT_WARNING_HTML } from "./payment-copy.js";
import {
  clearAdminGatewayExpect,
  getAdminGatewayExpect,
  setAdminGatewayExpect,
} from "../../modules/gateway/admin-gateway-prompt.service.js";
import { registerDealRoomHandlers } from "./deal-room.handlers.js";
import {
  handleSellerPayoutAddressMessage,
  registerSellerPayoutHandlers,
  sellerPayoutDealButton,
  sellerPayoutReady,
} from "./seller-payout.handlers.js";
import {
  clearActiveDealRoom,
  getActiveDealRoom,
} from "../../modules/dealMessages/deal-room-session.service.js";
import { listDealMessages } from "../../modules/dealMessages/dealMessage.service.js";
import { createReportSession } from "../../modules/reports/report-session.service.js";
import { assertCanOpenNewReport, findSubmittedReviewReportForDeal } from "../../modules/reports/report.service.js";
import { TERMS_TEXT } from "./messages.js";
import {
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
  adminMarkPayoutCompleted,
  adminRetryPayout,
  exportDealsCsv,
} from "../../modules/admin/admin.service.js";
import {
  addExtraAdmin,
  getAllAdminTelegramIds,
  removeExtraAdmin,
} from "../../modules/admin/admin-ids.service.js";
import {
  formatAdminPayoutList,
  listAdminPayoutQueue,
} from "../../modules/admin/admin-payouts.service.js";
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
import { escapeTelegramHtml } from "../../utils/telegram-html.js";
import {
  createDealSuccessKeyboard,
  joinSuccessKeyboard,
  notifyBothAfterPaymentLive,
  notifyCounterpartyAfterTermsAccept,
} from "../../modules/deals/deal-next-step-guide.service.js";
import { ADMIN_PANEL_INTRO, adminMenuKeyboard } from "./admin-panel.js";
import { caseReviewOpenMessage } from "./case-review-copy.js";
import {
  computeProcessorInvoiceAmount,
  formatCryptoAmount,
  formatFeeBreakdownLines,
  quoteDealPaymentTotals,
  resolveDealPaymentAmounts,
} from "../../services/fee.service.js";
import { maskPayoutAddress } from "../../services/payout.service.js";
import { formatDealCardHtml, loadDealCardContext } from "./deal-card.js";
import {
  amountPromptMessage,
  amountTooSmallMessage,
  coinChoiceKeyboard,
  coinChoiceMessage,
  confirmDealHeader,
  feePayerPrompt,
  invalidAmountMessage,
  payoutWalletPrompt,
} from "./wizard-copy.js";

function startArg(ctx: Context): string | undefined {
  const t = ctx.message?.text;
  if (!t) return;
  const m = /^\/start(?:@\w+)?(?:\s+(.+))?$/i.exec(t);
  return m?.[1]?.trim();
}

function createDealRoleKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("I am the Buyer", "w:role:buyer")
    .text("I am the Seller", "w:role:seller");
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

async function replyJoinDealSuccess(
  ctx: Context,
  user: User,
  deal: { id: string; dealCode: string },
): Promise<void> {
  const card = await fmtDealCard(deal.id, user.id);
  await ctx.reply(
    [`✅ Joined deal <b>${escapeTelegramHtml(deal.dealCode)}</b>`, "", card].join("\n"),
    { parse_mode: "HTML", reply_markup: joinSuccessKeyboard(deal.dealCode) },
  );
}

async function tryJoinDealByToken(ctx: Context, user: User, token: string): Promise<void> {
  try {
    const deal = await joinDealByToken(user, token);
    await replyJoinDealSuccess(ctx, user, deal);
  } catch (e) {
    await ctx.reply(`❌ ${String((e as Error).message)}`);
  }
}

async function replyMyDealsList(ctx: Context, u: User, brief = false): Promise<void> {
  const deals = await prisma.deal.findMany({
    where: { OR: [{ buyerId: u.id }, { sellerId: u.id }, { creatorId: u.id }] },
    orderBy: { createdAt: "desc" },
    take: 15,
  });
  if (!deals.length) {
    await ctx.reply(
      brief
        ? "No deals."
        : "No deals yet — create one or use an invite from your counterparty.",
      {
        reply_markup: brief ? undefined : new InlineKeyboard().text("Create deal", "m:create"),
      },
    );
    return;
  }
  const kb = new InlineKeyboard();
  for (const d of deals) {
    kb.text(brief ? d.dealCode : `${d.dealCode} (${d.status})`, `d:v:${d.dealCode}`).row();
  }
  await ctx.reply(brief ? "Tap a deal:" : "Pick a deal to see status and the next action:", {
    reply_markup: kb,
  });
}

async function startCreateDealFlow(ctx: Context, telegramId: bigint): Promise<void> {
  await clearActiveDealRoom(telegramId);
  await setCreateWizard(telegramId, { step: "role" });
  await ctx.reply("Select your role in this deal:", { reply_markup: createDealRoleKeyboard() });
}

async function replyUserProfile(ctx: Context, u: User): Promise<void> {
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
}

/** Compact HTML deal card with built-in next step for the viewer. */
async function fmtDealCard(dealId: string, viewerUserId: string | null = null): Promise<string> {
  const loaded = await loadDealCardContext(dealId, viewerUserId);
  if (!loaded) return escapeTelegramHtml("Deal not found.");
  return formatDealCardHtml(loaded.deal, loaded.ctx, viewerUserId);
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
    void err.ctx
      .reply(
        [
          "Something went wrong while handling that.",
          "",
          "What to try: open My deals from the menu, or send /start. If it keeps happening, wait a few minutes and try again.",
          "",
          "Do not paste API keys, bot tokens, wallet seeds, or payment provider secrets in this chat.",
        ].join("\n"),
      )
      .catch(() => {});
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
  registerSellerPayoutHandlers(bot);

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
      await tryJoinDealByToken(ctx, user, joinTok);
      return;
    }

    if (!user.termsAcceptedAt) {
      await ctx.reply(PREMIUM_WELCOME, { parse_mode: "HTML" });
      await ctx.reply(TERMS_TEXT, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("✅ I agree to the Terms", "terms:ok"),
      });
      return;
    }

    await ctx.reply(PREMIUM_WELCOME, {
      parse_mode: "HTML",
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
      await replyGatewayAccessPrompt(ctx, tid);
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
      await ctx.answerCallbackQuery({ text: "Already in" });
      await replyOrEditCallbackMessage(ctx, GATEWAY_ACCESS_APPROVED, { parse_mode: "HTML" });
      const fresh = await findUserByTelegramId(tid);
      if (fresh) await processMainOnboarding(ctx, fresh);
      return;
    }

    await ctx.answerCallbackQuery({ text: "Welcome!" });
    await clearGatewayPromptDedup(tid);
    u = await markUserGatewayAccess({ userId: u.id, verified: false });

    const fresh = await findUserByTelegramId(tid);
    if (!fresh?.termsAcceptedAt) {
      await replyOrEditCallbackMessage(ctx, GATEWAY_ACCESS_APPROVED, { parse_mode: "HTML" });
      await ctx.reply(TERMS_TEXT, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("✅ I agree to the Terms", "terms:ok"),
      });
      return;
    }

    await replyOrEditCallbackMessage(ctx, `${GATEWAY_ACCESS_APPROVED}\n\n${PREMIUM_WELCOME}`, {
      parse_mode: "HTML",
      reply_markup: mainMenuKb(isAdmin),
    });
  });

  bot.callbackQuery(/^terms:ok$/, async (ctx) => {
    if (!ctx.from) return;
    await acceptTermsForUser(BigInt(ctx.from.id));
    await ctx.answerCallbackQuery({ text: "Welcome!" });
    await ctx.editMessageText("✅ Terms accepted — you're ready to use OGMP MM.");
    await ctx.reply(PREMIUM_WELCOME, {
      parse_mode: "HTML",
      reply_markup: mainMenuKb(isAdminTelegramId(BigInt(ctx.from.id))),
    });
  });

  bot.callbackQuery(/^m:menu$/, async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();
    await replyOrEditCallbackMessage(ctx, PREMIUM_WELCOME, {
      parse_mode: "HTML",
      reply_markup: mainMenuKb(isAdminTelegramId(BigInt(ctx.from.id))),
    });
  });

  bot.callbackQuery(/^m:how$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await replyOrEditCallbackMessage(ctx, HOW_IT_WORKS_PAGE, {
      reply_markup: new InlineKeyboard()
        .text("Create Deal", "m:create")
        .text("Join Deal", "m:join")
        .row()
        .text("Back", "m:menu"),
    });
  });

  bot.callbackQuery(/^m:why$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await replyOrEditCallbackMessage(ctx, WHY_TRUST_PAGE, {
      reply_markup: new InlineKeyboard()
        .text("Create Deal", "m:create")
        .text("How It Works", "m:how")
        .row()
        .text("Back", "m:menu"),
    });
  });

  bot.callbackQuery(/^m:safety$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await replyOrEditCallbackMessage(ctx, SAFETY_RULES_PAGE, {
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
    await ctx.answerCallbackQuery();
    await startCreateDealFlow(ctx, BigInt(ctx.from.id));
  });

  bot.callbackQuery(/^w:role:(buyer|seller)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const role = ctx.match[1] as ParticipantRole;
    await clearActiveDealRoom(BigInt(ctx.from.id));
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
      step: "network",
      creatorRole: w.creatorRole,
      title: w.title,
      description: w.description,
      partyTermsExtra: "",
    });
    await ctx.answerCallbackQuery();
    await ctx.reply(coinChoiceMessage(), { parse_mode: "HTML", reply_markup: coinChoiceKeyboard() });
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
    await ctx.answerCallbackQuery();
    await replyMyDealsList(ctx, u);
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
    const loaded = await loadDealCardContext(deal.id, u.id);
    const text = loaded ? formatDealCardHtml(loaded.deal, loaded.ctx, u.id) : await fmtDealCard(deal.id, u.id);
    const lockedPre = loaded?.ctx.sellerLockedCount ?? 0;
    const buyerCanPay = loaded?.ctx.buyerCanPay ?? false;
    const kb = new InlineKeyboard();
    if (deal.status === "pending_acceptance") {
      const part = await prisma.dealParticipant.findUnique({
        where: { dealId_userId: { dealId: deal.id, userId: u.id } },
      });
      if (!part?.termsAcceptedAt) {
        kb.text("Accept terms", `d:a:${deal.dealCode}`).row();
      }
    }
    const spwBtn = sellerPayoutDealButton(deal, u.id);
    if (spwBtn && !sellerPayoutReady(deal) && deal.status !== "released" && deal.status !== "cancelled") {
      kb.text(spwBtn.text, spwBtn.cb).row();
    }
    if (deal.sellerId === u.id && lockedPre > 0 && (deal.status === "waiting_payment" || deal.status === "payment_detected")) {
      kb.text("Submit Delivery", `dl:sub:${deal.dealCode}`).row();
    }
    if (deal.buyerId === u.id && buyerCanPay) {
      kb.text("Show payment details", `bx:pd:${deal.dealCode}`).row();
      kb.text("I Have Paid", `bx:pay:${deal.dealCode}`).text("Check Payment", `bx:cp:${deal.dealCode}`).row();
      if (deal.paymentAddress) {
        kb.text("Copy address", `bx:addr:${deal.dealCode}`).row();
      }
    }
    if (deal.buyerId === u.id && deal.status === "item_delivered") {
      kb.text("Download Files", `bx:dl:${deal.dealCode}`).row();
    }
    if (deal.status === "funded" && deal.sellerId === u.id) {
      kb.text("Mark delivered", `d:del:${deal.dealCode}`).row();
    }
    if (deal.status === "item_delivered" && deal.buyerId === u.id) {
      kb.text("Release to seller", `d:rel:${deal.dealCode}`).row();
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
    if (deal.sellerId === u.id) {
      kb.row().text("Upload delivery / Deal room", `dr:enter:${deal.dealCode}`).row();
    } else if (deal.buyerId === u.id) {
      kb.row().text("Deal room (chat)", `dr:enter:${deal.dealCode}`).row();
    } else {
      kb.row().text("Deal room", `dr:enter:${deal.dealCode}`).row();
    }
    kb.text("Timeline", `d:tl:${deal.dealCode}`).text("Delivery log", `d:pr:${deal.dealCode}`).row();
    kb.text("Open Case", `d:rp:${deal.dealCode}`);
    await replyOrEditCallbackMessage(ctx, text, { parse_mode: "HTML", reply_markup: kb });
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
    if (!getReportBotToken()) {
      await ctx.answerCallbackQuery({ text: "Report bot not configured", show_alert: true });
      return;
    }
    const rb = getReportBotUsernameForDeepLinks();
    if (!rb) {
      await ctx.answerCallbackQuery({
        text: "Report bot username missing. Set REPORT_BOT_USERNAME (no @) in .env, restart, or wait until the REPORT bot has finished starting.",
        show_alert: true,
      });
      return;
    }
    try {
      const activeRep = await findSubmittedReviewReportForDeal(deal.id);
      if (activeRep) {
        const { rawToken } = await createReportSession({ dealId: deal.id, userId: u.id });
        const url = `https://t.me/${rb}?start=report_${rawToken}`;
        const kb = new InlineKeyboard().url("Open REPORT bot (add evidence)", url);
        await ctx.answerCallbackQuery({ text: "Case Review — add evidence" });
        await ctx.reply(
          caseReviewOpenMessage({
            mode: "append",
            reportCode: activeRep.reportCode,
            status: activeRep.status,
          }),
          { parse_mode: "Markdown", reply_markup: kb },
        );
        return;
      }
      await assertCanOpenNewReport(deal.id, u.id);
      const { rawToken } = await createReportSession({ dealId: deal.id, userId: u.id });
      const url = `https://t.me/${rb}?start=report_${rawToken}`;
      const kb = new InlineKeyboard().url("Open REPORT bot (submit evidence)", url);
      await ctx.answerCallbackQuery({ text: "Case Review opening" });
      await ctx.reply(caseReviewOpenMessage({ mode: "new" }), {
        parse_mode: "Markdown",
        reply_markup: kb,
      });
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
    const { resubmitSellerDeliveryNotify } = await import("../../services/delivery.service.js");
    const locked = await prisma.dealMessage.count({
      where: { dealId: deal.id, lockedForBuyer: true, senderId: deal.sellerId },
    });
    if (locked === 0) {
      await ctx.answerCallbackQuery({
        text: "Upload at least one file in Deal room first (photo/doc/zip). Text alone does not lock the vault.",
        show_alert: true,
      });
      return;
    }
    const notified = await resubmitSellerDeliveryNotify(deal.id);
    await ctx.answerCallbackQuery({
      text: notified
        ? "Buyer sent Payment Required"
        : "Not ready — set payout wallet or wait for pay address",
      show_alert: !notified,
    });
  });

  bot.callbackQuery(/^bx:(?:pay|cp):(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const code = ctx.match[1];
    const deal = await prisma.deal.findUnique({ where: { dealCode: code } });
    if (!deal) {
      await ctx.answerCallbackQuery({ text: "Not found", show_alert: true });
      return;
    }
    const { runBuyerPaymentCheck } = await import("../../modules/payments/buyer-payment-check.service.js");
    await ctx.answerCallbackQuery({ text: "Checking payment…" });
    const msg = await runBuyerPaymentCheck(deal.id, BigInt(ctx.from.id));
    await ctx.reply(msg);
  });

  bot.callbackQuery(/^bx:pd:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const u = await requireUser(ctx);
    if (!u) return;
    const deal = await prisma.deal.findUnique({ where: { dealCode: ctx.match[1] } });
    if (!deal || deal.buyerId !== u.id) {
      await ctx.answerCallbackQuery({ text: "Buyer only", show_alert: true });
      return;
    }
    const { notifyBuyerPaymentRequired, isBuyerPaymentReady } = await import(
      "../../services/delivery.service.js"
    );
    if (!(await isBuyerPaymentReady(deal.id))) {
      await ctx.answerCallbackQuery({
        text: "Not ready — seller must lock delivery and set payout wallet first.",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Sending…" });
    const ok = await notifyBuyerPaymentRequired(deal.id, { force: true });
    await replyOrEditCallbackMessage(
      ctx,
      ok
        ? `✅ <b>Payment details sent above</b>\n\n${PAYMENT_EXACT_AMOUNT_WARNING_HTML}`
        : "Could not send payment details yet. Try again in a minute or /support with your deal code.",
      ok ? { parse_mode: "HTML" } : undefined,
    );
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
    const amounts = resolveDealPaymentAmounts(deal);
    await replyOrEditCallbackMessage(
      ctx,
      [
        "<b>Escrow address</b> (long-press to copy):",
        "",
        `<code>${escapeTelegramHtml(addr)}</code>`,
        "",
        `<b>Send exactly</b> ${escapeTelegramHtml(formatCryptoAmount(amounts.buyerPays))} ${escapeTelegramHtml(deal.currency)}`,
        "",
        PAYMENT_EXACT_AMOUNT_WARNING_HTML,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
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
    await ctx.answerCallbackQuery({
      text: r.skipped ? "Already sent — scroll up" : `Sent ${r.sent} file(s)`,
    });
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
      const part = await prisma.dealParticipant.findUnique({
        where: { dealId_userId: { dealId: deal.id, userId: u.id } },
      });
      const alreadyAccepted = Boolean(part?.termsAcceptedAt);
      const updated = await acceptTerms(u.id, deal.id);
      await ctx.answerCallbackQuery({ text: alreadyAccepted ? "Already accepted" : "Accepted" });
      const card = await fmtDealCard(updated.id, u.id);
      const kb = new InlineKeyboard().text("View deal", `d:v:${updated.dealCode}`);
      await replyOrEditCallbackMessage(ctx, card, { parse_mode: "HTML", reply_markup: kb });
      if (!alreadyAccepted) {
        if (updated.status === "pending_acceptance") {
          await notifyCounterpartyAfterTermsAccept(updated.id, u.id);
        } else if (updated.status === "waiting_payment" && updated.paymentAddress) {
          await notifyBothAfterPaymentLive(updated.id);
        }
      }
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
      const card = await fmtDealCard(d.id, u.id);
      const kb = new InlineKeyboard().text("View deal", `d:v:${d.dealCode}`);
      await replyOrEditCallbackMessage(ctx, card, { parse_mode: "HTML", reply_markup: kb });
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String((e as Error).message), show_alert: true });
    }
  });

  bot.callbackQuery(/^d:rel:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const u = await requireUser(ctx);
    if (!u) return;
    const deal = await prisma.deal.findUnique({ where: { dealCode: ctx.match[1] } });
    if (!deal || deal.buyerId !== u.id) {
      await ctx.answerCallbackQuery({ text: "Only the buyer can release", show_alert: true });
      return;
    }
    if (deal.status !== "item_delivered") {
      await ctx.answerCallbackQuery({ text: "Not ready for release", show_alert: true });
      return;
    }
    const amounts = resolveDealPaymentAmounts(deal);
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text("Yes — release funds", `d:relok:${deal.dealCode}`)
      .row()
      .text("Cancel", `d:v:${deal.dealCode}`);
    await ctx.reply(
      [
        "━━━━━━━━━━━━━━━━━━",
        "OGMP MM — Release escrow",
        "━━━━━━━━━━━━━━━━━━",
        "",
        `Deal: ${deal.dealCode}`,
        `Seller receives: ${formatCryptoAmount(amounts.sellerReceives)} ${deal.currency}`,
        "",
        "What: this sends crypto to the seller's wallet and closes the deal.",
        "Safe: only confirm if you received everything as agreed.",
        "Next: tap Yes — release funds, or Cancel.",
      ].join("\n"),
      { reply_markup: kb },
    );
  });

  bot.callbackQuery(/^d:relok:(.+)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const u = await requireUser(ctx);
    if (!u) return;
    const deal = await prisma.deal.findUnique({ where: { dealCode: ctx.match[1] } });
    if (!deal) return;
    try {
      const d = await buyerConfirmRelease(u.id, deal.id);
      await ctx.answerCallbackQuery({ text: "Funds released" });
      const card = await fmtDealCard(d.id, u.id);
      await replyOrEditCallbackMessage(ctx, card, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("View deal", `d:v:${d.dealCode}`),
      });
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
    await replyUserProfile(ctx, u);
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
    await ctx.reply(ADMIN_PANEL_INTRO, { reply_markup: adminMenuKeyboard() });
  });

  bot.callbackQuery(/^a:fr$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Force release: `/admin_release DEALCODE`\n\nUse when escrow should pay out despite a stuck Buyer Review (document in admin notes).",
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("« Admin", "m:admin") },
    );
  });

  bot.callbackQuery(/^a:fref$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Force refund: `/admin_refund DEALCODE`\n\nUse when funds should return to the buyer per your policy.",
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("« Admin", "m:admin") },
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
        `Pending payouts: ${s.pendingPayouts}`,
        "",
        TRUST_OPS_FOOTER,
      ].join("\n"),
      {
        reply_markup: new InlineKeyboard()
          .text("Active deals", "a:act")
          .text("Open cases", "a:oc")
          .row()
          .text("Release requests", "a:relq")
          .text("Pending payouts", "a:pay")
          .row()
          .text("Broadcast", "a:bc:help")
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

  bot.callbackQuery(/^a:pay$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const rows = await listAdminPayoutQueue(15);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "━━━━━━━━━━━━━━━━━━",
        "OGMP MM — Payout queue",
        "━━━━━━━━━━━━━━━━━━",
        "",
        formatAdminPayoutList(rows),
        "",
        "Commands:",
        "`/admin_retry_payout DEALCODE` — resend NOWPayments payout",
        "`/admin_payout_update PAYOUT_UUID [tx_hash]` — mark completed manually",
        "",
        "Auto-release is on by default; this queue is for failures or manual fixes.",
      ].join("\n"),
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("« Admin", "m:admin"),
      },
    );
  });

  bot.callbackQuery(/^a:adm$/, async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const ids = getAllAdminTelegramIds();
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "━━━━━━━━━━━━━━━━━━",
        "OGMP MM — Admins",
        "━━━━━━━━━━━━━━━━━━",
        "",
        ids.length ? ids.map((id) => `• ${id}`).join("\n") : "(none configured)",
        "",
        "Env (restart required): `ADMIN_IDS=123,456`",
        "Bot (instant):",
        "`/admin_add TELEGRAM_ID`",
        "`/admin_remove TELEGRAM_ID`",
        "`/admin_list`",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("« Admin", "m:admin") },
    );
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
    await tryJoinDealByToken(ctx, user, token);
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
    await startCreateDealFlow(ctx, BigInt(ctx.from.id));
  });

  bot.command("deals", async (ctx) => {
    if (!ctx.from) return;
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (!u) return;
    await replyMyDealsList(ctx, u, true);
  });

  bot.command("profile", async (ctx) => {
    if (!ctx.from) return;
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (!u) return;
    await replyUserProfile(ctx, u);
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
      await ctx.reply(replyTextForCaughtError(e));
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
    await ctx.reply(ADMIN_PANEL_INTRO, { reply_markup: adminMenuKeyboard() });
  });

  /** Coin/network presets for wizard — pick coin before typing amount. */
  bot.callbackQuery(/^w:net:(USDT|BTC|ETH|LTC):(TRC20|ERC20|BTC|ETH|LTC)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const cur = ctx.match[1] as CreateDealInput["currency"];
    const net = ctx.match[2]!;
    const network = net === "BTC" ? "BTC" : net;
    const w = await getCreateWizard(BigInt(ctx.from.id));
    if (!w || w.step !== "network") {
      await ctx.answerCallbackQuery({ text: "Wizard expired — /create", show_alert: true });
      return;
    }
    await setCreateWizard(BigInt(ctx.from.id), {
      step: "amount",
      creatorRole: w.creatorRole,
      title: w.title,
      description: w.description,
      currency: cur,
      network,
      partyTermsExtra: w.partyTermsExtra ?? "",
    });
    await ctx.answerCallbackQuery({ text: `${cur} selected` });
    await ctx.reply(amountPromptMessage(cur, network), { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^w:pw:(yes|redo)$/, async (ctx) => {
    if (!ctx.from || !ctx.match) return;
    const w = await getCreateWizard(BigInt(ctx.from.id));
    if (!w || w.step !== "payout_wallet" || w.creatorRole !== "seller") {
      await ctx.answerCallbackQuery({ text: "Wizard expired — /create", show_alert: true });
      return;
    }
    if (ctx.match[1] === "redo") {
      await setCreateWizard(BigInt(ctx.from.id), { ...w, payoutAddressDraft: undefined });
      await ctx.answerCallbackQuery({ text: "Send a new address" });
      await ctx.reply("Send your payout wallet address in one message.");
      return;
    }
    const addr = w.payoutAddressDraft?.trim();
    if (!addr || addr.length < 8) {
      await ctx.answerCallbackQuery({ text: "Send wallet address first", show_alert: true });
      return;
    }
    await setCreateWizard(BigInt(ctx.from.id), {
      step: "fee_payer",
      creatorRole: "seller",
      title: w.title,
      description: w.description,
      amount: w.amount,
      currency: w.currency,
      network: w.network,
      partyTermsExtra: w.partyTermsExtra ?? "",
      sellerPayoutAddress: addr,
    });
    await ctx.answerCallbackQuery({ text: "Wallet saved" });
    await ctx.reply(feePayerPrompt(w.currency), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("Buyer pays fee", "w:fee:buyer")
        .text("Seller pays fee", "w:fee:seller")
        .row()
        .text("Split fee 50/50", "w:fee:split"),
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
    const preview = await quoteDealPaymentTotals({
      amount: draft.amount,
      currency: draft.currency,
      network: draft.network,
      feePayer: draft.feePayer,
    });
    const feeLines = formatFeeBreakdownLines({
      currency: draft.currency,
      network: draft.network,
      amounts: preview,
    });
    let minLine = "";
    if (loadConfig().PAYMENT_PROVIDER === "nowpayments") {
      const { fetchNowpaymentsMinPaymentAmount, formatNowpaymentsMinimumHint, validateInvoiceMeetsNowpaymentsMinimum } =
        await import("../../payments/nowpayments-min-amount.js");
      const invoice = computeProcessorInvoiceAmount({
        amount: new Prisma.Decimal(draft.amount),
        feeAmount: preview.escrowFee,
        feePayer: draft.feePayer,
      });
      const minCheck = await validateInvoiceMeetsNowpaymentsMinimum({
        currency: draft.currency,
        network: draft.network,
        invoiceAmount: invoice.toString(),
      });
      const minInfo = await fetchNowpaymentsMinPaymentAmount({
        currency: draft.currency,
        network: draft.network,
      });
      if (minInfo) {
        minLine = formatNowpaymentsMinimumHint(minInfo, draft.currency, draft.network);
        if (!minCheck.ok) minLine = `⚠️ ${minCheck.message}`;
      }
    }
    await setCreateWizard(BigInt(ctx.from.id), { step: "confirm", draft });
    await ctx.answerCallbackQuery();
    const feeLinesHtml = feeLines.map((l) => escapeTelegramHtml(l));
    const minLineHtml = minLine ? escapeTelegramHtml(minLine) : "";
    await ctx.reply(
      [
        confirmDealHeader(draft.currency, draft.network),
        `<b>Role:</b> ${escapeTelegramHtml(draft.creatorRole)}`,
        `<b>Title:</b> ${escapeTelegramHtml(draft.title)}`,
        "",
        ...feeLinesHtml,
        ...(minLineHtml ? ["", minLineHtml] : []),
        "",
        `<b>Custom terms:</b> ${customTerms ? "Yes" : "No — standard escrow only"}`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("✅ Create deal", "w:go").text("❌ Cancel", "w:abort"),
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
      if (loadConfig().PAYMENT_PROVIDER === "nowpayments") {
        const { validateInvoiceMeetsNowpaymentsMinimum } = await import("../../payments/nowpayments-min-amount.js");
        const totals = await quoteDealPaymentTotals({
          amount: w.draft.amount,
          currency: w.draft.currency,
          network: w.draft.network,
          feePayer: w.draft.feePayer,
        });
        const invoice = computeProcessorInvoiceAmount({
          amount: new Prisma.Decimal(w.draft.amount),
          feeAmount: totals.escrowFee,
          feePayer: w.draft.feePayer,
        });
        const minCheck = await validateInvoiceMeetsNowpaymentsMinimum({
          currency: w.draft.currency,
          network: w.draft.network,
          invoiceAmount: invoice.toString(),
        });
        if (!minCheck.ok) {
          await ctx.answerCallbackQuery({ text: minCheck.message.slice(0, 180), show_alert: true });
          return;
        }
      }
      const deal = await createDeal(u, w.draft);
      await clearCreateWizard(BigInt(ctx.from.id));
      await ctx.answerCallbackQuery({ text: "Created" });
      const cfg = loadConfig();
      const me = cfg.BOT_PUBLIC_USERNAME ?? (await ctx.api.getMe()).username;
      const link = me ? `https://t.me/${me}?start=join_${deal.inviteToken}` : `Invite token:\n${deal.inviteToken}`;
      const card = await fmtDealCard(deal.id, u.id);
      await ctx.reply(
        [
          `✅ Deal <b>${escapeTelegramHtml(deal.dealCode)}</b> created`,
          "",
          "Send this invite to your counterparty:",
          link,
          "",
          card,
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: createDealSuccessKeyboard(deal.dealCode) },
      );
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
    if (await handleSellerPayoutAddressMessage(ctx, BigInt(ctx.from.id), ctx.message.text)) return;
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
        step: "network",
        creatorRole: w.creatorRole,
        title: w.title,
        description: w.description,
        partyTermsExtra: text.slice(0, 4000),
      });
      await ctx.reply(coinChoiceMessage(), { parse_mode: "HTML", reply_markup: coinChoiceKeyboard() });
      return;
    }
    if (w.step === "amount") {
      if (!/^\d+(\.\d+)?$/.test(text)) {
        await ctx.reply(invalidAmountMessage(w.currency), { parse_mode: "HTML" });
        return;
      }
      const { getActiveFeeSettings, computeFeeBreakdown } = await import("../../services/fee.service.js");
      const { validateInvoiceMeetsNowpaymentsMinimum } = await import("../../payments/nowpayments-min-amount.js");
      const feeRow = await getActiveFeeSettings();
      const breakdown = computeFeeBreakdown({
        dealAmount: new Prisma.Decimal(text),
        amountUsdForCaps: new Prisma.Decimal(text),
        networkFeeEstimate: new Prisma.Decimal(0),
        feePayer: "buyer",
        percentage: feeRow.percentage,
        minimumUsd: feeRow.minimumUsd,
        maximumUsd: feeRow.maximumUsd,
        fixedUsd: feeRow.fixedUsd,
      });
      const invoice = computeProcessorInvoiceAmount({
        amount: new Prisma.Decimal(text),
        feeAmount: breakdown.escrowFee,
        feePayer: "buyer",
      });
      const minCheck = await validateInvoiceMeetsNowpaymentsMinimum({
        currency: w.currency,
        network: w.network,
        invoiceAmount: invoice.toString(),
      });
      if (!minCheck.ok) {
        await ctx.reply(
          amountTooSmallMessage(w.currency, w.network, minCheck.message),
          { parse_mode: "HTML" },
        );
        return;
      }
      if (w.creatorRole === "seller") {
        await setCreateWizard(BigInt(ctx.from.id), {
          step: "payout_wallet",
          creatorRole: "seller",
          title: w.title,
          description: w.description,
          amount: text,
          currency: w.currency,
          network: w.network,
          partyTermsExtra: w.partyTermsExtra ?? "",
        });
        await ctx.reply(payoutWalletPrompt(w.currency, w.network), { parse_mode: "HTML" });
        return;
      }
      await setCreateWizard(BigInt(ctx.from.id), {
        step: "fee_payer",
        creatorRole: w.creatorRole,
        title: w.title,
        description: w.description,
        amount: text,
        currency: w.currency,
        network: w.network,
        partyTermsExtra: w.partyTermsExtra ?? "",
      });
      await ctx.reply(feePayerPrompt(w.currency), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("Buyer pays fee", "w:fee:buyer")
          .text("Seller pays fee", "w:fee:seller")
          .row()
          .text("Split fee 50/50", "w:fee:split"),
      });
      return;
    }
    if (w.step === "payout_wallet" && w.creatorRole === "seller") {
      if (text.length < 8) {
        await ctx.reply("Address too short. Send a valid wallet address.");
        return;
      }
      await setCreateWizard(BigInt(ctx.from.id), { ...w, payoutAddressDraft: text.slice(0, 256) });
      await ctx.reply(
        [
          "Confirm payout wallet:",
          maskPayoutAddress(text.trim()),
          "",
          "Wrong network = lost funds.",
        ].join("\n"),
        {
          reply_markup: new InlineKeyboard()
            .text("Confirm wallet", "w:pw:yes")
            .text("Re-enter", "w:pw:redo"),
        },
      );
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

  bot.command("admin_add", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const tid = ctx.message?.text?.split(/\s+/)[1];
    if (!tid || !/^\d+$/.test(tid)) {
      await ctx.reply("Usage: `/admin_add TELEGRAM_ID`", { parse_mode: "Markdown" });
      return;
    }
    try {
      await addExtraAdmin(BigInt(ctx.from.id), BigInt(tid));
      await ctx.reply(`✅ Added admin: \`${tid}\``, { parse_mode: "Markdown" });
    } catch (e) {
      await ctx.reply(replyTextForCaughtError(e));
    }
  });

  bot.command("admin_remove", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const tid = ctx.message?.text?.split(/\s+/)[1];
    if (!tid || !/^\d+$/.test(tid)) {
      await ctx.reply("Usage: `/admin_remove TELEGRAM_ID`", { parse_mode: "Markdown" });
      return;
    }
    try {
      await removeExtraAdmin(BigInt(ctx.from.id), BigInt(tid));
      await ctx.reply(`✅ Removed bot admin: \`${tid}\``, { parse_mode: "Markdown" });
    } catch (e) {
      await ctx.reply(replyTextForCaughtError(e));
    }
  });

  bot.command("admin_list", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const ids = getAllAdminTelegramIds();
    await ctx.reply(
      ids.length ? `Admins:\n${ids.map((id) => `• ${id}`).join("\n")}` : "No admins configured.",
    );
  });

  bot.command("admin_retry_payout", async (ctx) => {
    if (!ctx.from) return;
    const tid = BigInt(ctx.from.id);
    if (!isAdminTelegramId(tid)) {
      await ctx.reply(
        "This command is admin-only. Set your Telegram numeric id in ADMIN_IDS in .env, restart the bot, and use the main escrow bot (not the report bot).",
      );
      return;
    }
    const code = ctx.message?.text?.split(/\s+/)[1];
    if (!code) {
      await ctx.reply("Usage: `/admin_retry_payout DEALCODE`", { parse_mode: "Markdown" });
      return;
    }
    try {
      const { logger } = await import("../../utils/logger.js");
      logger.warn("admin_retry_payout_command", { dealCode: code, adminId: tid.toString() });
      const msg = await adminRetryPayout(code, tid);
      await ctx.reply(`✅ ${msg}`);
    } catch (e) {
      const { logger } = await import("../../utils/logger.js");
      logger.warn("admin_retry_payout_command_failed", { dealCode: code, err: String(e) });
      await ctx.reply(replyTextForCaughtError(e));
    }
  });

  bot.command("admin_payout_update", async (ctx) => {
    if (!ctx.from || !isAdminTelegramId(BigInt(ctx.from.id))) return;
    const parts = ctx.message?.text?.trim().split(/\s+/) ?? [];
    const payoutId = parts[1];
    const txHash = parts[2];
    if (!payoutId) {
      await ctx.reply("Usage: `/admin_payout_update PAYOUT_UUID [tx_hash]`");
      return;
    }
    try {
      await adminMarkPayoutCompleted({
        adminTelegramId: BigInt(ctx.from.id),
        payoutId,
        txHash: txHash && !txHash.startsWith("/") ? txHash : undefined,
      });
      await ctx.reply("✅ Payout marked completed.");
    } catch (e) {
      await ctx.reply(replyTextForCaughtError(e));
    }
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
      await ctx.reply(replyTextForCaughtError(e));
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
      await ctx.reply(replyTextForCaughtError(e));
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
      await ctx.reply(replyTextForCaughtError(e));
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
