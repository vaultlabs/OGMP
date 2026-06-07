import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "../../db/prisma.js";
import { ensurePaymentInstruction } from "../../modules/deals/deal.service.js";
import { notifyBothAfterPaymentLive } from "../../modules/deals/deal-next-step-guide.service.js";
import {
  clearSellerPayoutDraft,
  confirmSellerPayoutForDeal,
  getSellerPayoutDraft,
  sellerPayoutReady,
  setSellerPayoutDraft,
} from "../../modules/deals/seller-payout.service.js";
import { maskPayoutAddress } from "../../services/payout.service.js";
import { ensureTelegramMember } from "../../modules/users/user.service.js";

async function requireUser(ctx: Context) {
  if (!ctx.from) return null;
  return ensureTelegramMember({
    telegramId: BigInt(ctx.from.id),
    username: ctx.from.username,
    firstName: ctx.from.first_name,
    bot: "main",
  });
}

export function registerSellerPayoutHandlers(bot: Bot<Context>): void {
  bot.callbackQuery(/^spw:start:(.+)$/, async (ctx) => {
    const u = await requireUser(ctx);
    if (!u || !ctx.match) return;
    const code = ctx.match[1];
    const deal = await prisma.deal.findUnique({ where: { dealCode: code } });
    if (!deal || deal.sellerId !== u.id) {
      await ctx.answerCallbackQuery({ text: "Only the seller can set payout wallet", show_alert: true });
      return;
    }
    await clearSellerPayoutDraft(BigInt(ctx.from!.id));
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "━━━━━━━━━━━━━━━━━━",
        "OGMP MM — Payout wallet",
        "━━━━━━━━━━━━━━━━━━",
        "",
        `Deal: ${deal.dealCode}`,
        `Coin: ${deal.currency} on ${deal.network}`,
        `Deal price: ${deal.amount.toString()} ${deal.currency}`,
        "",
        `Send your ${deal.currency} wallet address (${deal.network} network).`,
        "Wrong network = lost funds.",
      ].join("\n"),
    );
    await setSellerPayoutDraft(BigInt(ctx.from!.id), deal.dealCode, "__awaiting__");
  });

  bot.callbackQuery(/^spw:ok:(.+)$/, async (ctx) => {
    const u = await requireUser(ctx);
    if (!u || !ctx.match) return;
    const code = ctx.match[1];
    const deal = await prisma.deal.findUnique({ where: { dealCode: code } });
    if (!deal || deal.sellerId !== u.id) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    const draft = await getSellerPayoutDraft(BigInt(ctx.from!.id));
    if (!draft || draft.dealCode !== code || draft.address === "__awaiting__") {
      await ctx.answerCallbackQuery({ text: "Send your wallet address first", show_alert: true });
      return;
    }
    try {
      const updated = await confirmSellerPayoutForDeal(u.id, deal.id, draft.address);
      await clearSellerPayoutDraft(BigInt(ctx.from!.id));
      await ctx.answerCallbackQuery({ text: "Wallet saved" });
      await ctx.reply(
        [
          "Payout wallet confirmed.",
          `Address: ${maskPayoutAddress(draft.address)}`,
          "",
          updated.status === "waiting_payment" && !updated.paymentAddress
            ? "Next: payment address will open for the buyer shortly — tap View deal."
            : "Next: continue in the deal card.",
        ].join("\n"),
        {
          reply_markup: new InlineKeyboard().text("View deal", `d:v:${code}`),
        },
      );
      if (updated.status === "waiting_payment" && !updated.paymentAddress) {
        try {
          const withPay = await ensurePaymentInstruction(updated.id);
          if (withPay.paymentAddress) {
            const locked = withPay.sellerId
              ? await prisma.dealMessage.count({
                  where: { dealId: withPay.id, lockedForBuyer: true, senderId: withPay.sellerId },
                })
              : 0;
            if (locked > 0) {
              const { notifyBuyerPaymentRequired } = await import("../../services/delivery.service.js");
              await notifyBuyerPaymentRequired(withPay.id, { force: true });
            } else {
              await notifyBothAfterPaymentLive(withPay.id);
            }
          }
        } catch {
          /* payment setup errors handled elsewhere */
        }
      }
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String((e as Error).message), show_alert: true });
    }
  });

  bot.callbackQuery(/^spw:cancel:(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    await clearSellerPayoutDraft(BigInt(ctx.from.id));
    await ctx.answerCallbackQuery({ text: "Cancelled" });
  });
}

/** Handle seller payout address text when draft is awaiting. */
export async function handleSellerPayoutAddressMessage(
  ctx: Context,
  telegramId: bigint,
  text: string,
): Promise<boolean> {
  const draft = await getSellerPayoutDraft(telegramId);
  if (!draft || draft.address !== "__awaiting__") return false;

  const addr = text.trim();
  if (addr.length < 8) {
    await ctx.reply("Address too short. Send a valid wallet address.");
    return true;
  }

  await setSellerPayoutDraft(telegramId, draft.dealCode, addr);
  const kb = new InlineKeyboard()
    .text("Confirm wallet", `spw:ok:${draft.dealCode}`)
    .text("Cancel", `spw:cancel:${draft.dealCode}`);
  await ctx.reply(
    [
      "Confirm this payout wallet:",
      maskPayoutAddress(addr),
      "",
      "Wrong network = lost funds. Tap Confirm only if this is correct.",
    ].join("\n"),
    { reply_markup: kb },
  );
  return true;
}

export function sellerPayoutDealButton(
  deal: { dealCode: string; sellerId: string | null },
  actorUserId: string,
): { text: string; cb: string } | null {
  if (deal.sellerId !== actorUserId) return null;
  return { text: "Set payout wallet", cb: `spw:start:${deal.dealCode}` };
}

export { sellerPayoutReady };
