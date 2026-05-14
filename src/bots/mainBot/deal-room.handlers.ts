import type { Bot, Context } from "grammy";
import {
  clearActiveDealRoom,
  getActiveDealRoom,
  setActiveDealRoom,
} from "../../modules/dealMessages/deal-room-session.service.js";
import { createWizardExpectsPlainText, getCreateWizard } from "./create-deal-wizard.js";
import { saveDealRoomMessage } from "../../modules/dealMessages/dealMessage.service.js";
import { findUserByTelegramId } from "../../modules/users/user.service.js";
import { prisma } from "../../db/prisma.js";
import type { DealMessageType } from "@prisma/client";
import {
  formatDealRoomTextSavedPlain,
  formatUploadContinuationPlain,
} from "../../utils/upload-guidance.js";
import { assertFileAllowed } from "../../utils/file-safety.js";
import { replyTextForCaughtError } from "../../utils/user-facing-errors.js";
import { redisIncrWithTtl } from "../../utils/redis.js";
import {
  notifyBuyerPaymentRequired,
  sellerFileSecuredKeyboard,
  sellerFileSecuredText,
} from "../../services/delivery.service.js";
import { formatDealRoomEntryPlain } from "./deal-room-welcome.js";
import { MAIN_UI_PARSE_MODE } from "./trust-copy.js";

async function resolveDealIdFromCode(code: string): Promise<string | null> {
  const d = await prisma.deal.findUnique({ where: { dealCode: code } });
  return d?.id ?? null;
}

export function registerDealRoomHandlers(bot: Bot<Context>): void {
  bot.callbackQuery(/^dr:enter:(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    const code = ctx.match![1]!;
    const dealId = await resolveDealIdFromCode(code);
    if (!dealId) {
      await ctx.answerCallbackQuery({ text: "Deal not found", show_alert: true });
      return;
    }
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (!u) return;
    const deal = await prisma.deal.findFirst({
      where: {
        id: dealId,
        OR: [{ buyerId: u.id }, { sellerId: u.id }],
      },
    });
    if (!deal) {
      await ctx.answerCallbackQuery({ text: "Forbidden", show_alert: true });
      return;
    }
    await setActiveDealRoom(BigInt(ctx.from.id), dealId);
    await ctx.answerCallbackQuery({ text: "Deal room active" });
    const banner = await formatDealRoomEntryPlain(dealId);
    await ctx.reply(banner);
  });

  bot.command("done_room", async (ctx) => {
    if (!ctx.from) return;
    await clearActiveDealRoom(BigInt(ctx.from.id));
    await ctx.reply(
      [
        "Deal room mode ended.",
        "",
        "What's next: open a deal from My deals / the menu, or start a new one with Create deal or /create.",
      ].join("\n"),
    );
  });

  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from || ctx.message.text?.startsWith("/")) return next();
    const tid = BigInt(ctx.from.id);
    const w = await getCreateWizard(tid);
    if (createWizardExpectsPlainText(w)) {
      return next();
    }
    const dealId = await getActiveDealRoom(tid);
    if (!dealId) return next();
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (!u) return;
    try {
      await saveDealRoomMessage({
        dealId,
        senderUserId: u.id,
        messageType: "text",
        text: ctx.message.text,
      });
      await ctx.reply(
        ["Message saved to this deal's Delivery log (Deal room).", "", formatDealRoomTextSavedPlain()].join("\n"),
      );
    } catch (e) {
      await ctx.reply(replyTextForCaughtError(e));
    }
  });

  const saveMedia = async (
    ctx: Context,
    type: DealMessageType,
    fileId: string | undefined,
    uniqueId: string | undefined,
    fileName: string | undefined,
    mimeType: string | undefined,
    fileSize: number | undefined,
    caption: string | undefined,
    textFallback: string,
  ) => {
    if (!ctx.from) return;
    const dealId = await getActiveDealRoom(BigInt(ctx.from.id));
    if (!dealId) return;
    const u = await findUserByTelegramId(BigInt(ctx.from.id));
    if (!u) return;
    const deal = await prisma.deal.findUnique({ where: { id: dealId } });
    if (!deal) return;
    const hasFile = !!fileId;
    if (hasFile) {
      const ul = await redisIncrWithTtl(`rl:ul:${dealId}`, 60);
      if (ul > 30) {
        await ctx.reply("Too many uploads for this deal in a short window. Please wait a minute.");
        return;
      }
    }
    const sellerLocked =
      deal.sellerId === u.id && hasFile && !deal.fundedAt;
    try {
      await saveDealRoomMessage({
        dealId,
        senderUserId: u.id,
        messageType: type,
        text: textFallback,
        telegramFileId: fileId,
        telegramFileUniqueId: uniqueId,
        fileName,
        mimeType,
        fileSize,
        caption,
        lockedForBuyer: sellerLocked,
        deliveryAsset: sellerLocked,
        skipCounterpartyNotification: sellerLocked,
      });
      if (sellerLocked) {
        const fn = fileName ?? type;
        await ctx.reply(sellerFileSecuredText(deal.dealCode, fn), {
          parse_mode: MAIN_UI_PARSE_MODE,
          reply_markup: sellerFileSecuredKeyboard(deal.dealCode),
        });
        await notifyBuyerPaymentRequired(dealId);
        return;
      }
      await ctx.reply(
        [
          "File saved.",
          "",
          formatUploadContinuationPlain("send another file or type /done_room when you are finished"),
        ].join("\n"),
      );
    } catch (e) {
      await ctx.reply(replyTextForCaughtError(e));
    }
  };

  bot.on("message:photo", async (ctx, next) => {
    if (!ctx.from || !(await getActiveDealRoom(BigInt(ctx.from.id)))) return next();
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
    await saveMedia(
      ctx,
      "photo",
      p?.file_id,
      p?.file_unique_id,
      "photo.jpg",
      "image/jpeg",
      p?.file_size,
      ctx.message.caption,
      "[photo]",
    );
  });

  bot.on("message:document", async (ctx, next) => {
    if (!ctx.from) return next();
    if (!("document" in ctx.message)) return next();
    if (!(await getActiveDealRoom(BigInt(ctx.from.id)))) return next();
    const doc = ctx.message.document;
    if (!doc) return next();
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
    await saveMedia(
      ctx,
      "document",
      doc.file_id,
      doc.file_unique_id,
      doc.file_name ?? "document",
      doc.mime_type,
      doc.file_size,
      ctx.message.caption,
      "[document]",
    );
  });

  bot.on("message:video", async (ctx, next) => {
    if (!ctx.from || !(await getActiveDealRoom(BigInt(ctx.from.id)))) return next();
    const v = ctx.message.video;
    if (!v) return next();
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
    await saveMedia(
      ctx,
      "video",
      v.file_id,
      v.file_unique_id,
      v.file_name ?? "video.mp4",
      v.mime_type,
      v.file_size,
      ctx.message.caption,
      "[video]",
    );
  });

  bot.on("message:animation", async (ctx, next) => {
    if (!ctx.from || !(await getActiveDealRoom(BigInt(ctx.from.id)))) return next();
    const a = ctx.message.animation;
    if (!a) return next();
    try {
      assertFileAllowed({
        fileName: a.file_name ?? "animation.mp4",
        mimeType: a.mime_type,
        fileSize: a.file_size,
      });
    } catch (e) {
      await ctx.reply(replyTextForCaughtError(e));
      return;
    }
    await saveMedia(
      ctx,
      "animation",
      a.file_id,
      a.file_unique_id,
      a.file_name ?? "animation.mp4",
      a.mime_type,
      a.file_size,
      ctx.message.caption,
      "[animation]",
    );
  });

  bot.on("message:voice", async (ctx, next) => {
    if (!ctx.from || !(await getActiveDealRoom(BigInt(ctx.from.id)))) return next();
    const v = ctx.message.voice;
    if (!v) return next();
    try {
      assertFileAllowed({
        fileName: "voice.ogg",
        mimeType: "audio/ogg",
        fileSize: v.file_size,
      });
    } catch (e) {
      await ctx.reply(replyTextForCaughtError(e));
      return;
    }
    await saveMedia(ctx, "voice", v.file_id, v.file_unique_id, "voice.ogg", "audio/ogg", v.file_size, undefined, "[voice]");
  });

  bot.on("message:audio", async (ctx, next) => {
    if (!ctx.from || !(await getActiveDealRoom(BigInt(ctx.from.id)))) return next();
    const a = ctx.message.audio;
    if (!a) return next();
    try {
      assertFileAllowed({
        fileName: a.file_name ?? "audio",
        mimeType: a.mime_type,
        fileSize: a.file_size,
      });
    } catch (e) {
      await ctx.reply(replyTextForCaughtError(e));
      return;
    }
    await saveMedia(
      ctx,
      "audio",
      a.file_id,
      a.file_unique_id,
      a.file_name ?? "audio",
      a.mime_type,
      a.file_size,
      ctx.message.caption,
      "[audio]",
    );
  });
}
