import type { Bot, Context } from "grammy";
import {
  clearActiveDealRoom,
  getActiveDealRoom,
  setActiveDealRoom,
} from "../../modules/dealMessages/deal-room-session.service.js";
import { saveDealRoomMessage } from "../../modules/dealMessages/dealMessage.service.js";
import { findUserByTelegramId } from "../../modules/users/user.service.js";
import { prisma } from "../../db/prisma.js";
import type { DealMessageType } from "@prisma/client";
import {
  TELEGRAM_FOLDER_UPLOAD_EXPLANATION_PLAIN,
  formatUploadContinuationPlain,
} from "../../utils/upload-guidance.js";

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
    await ctx.reply(
      [
        `💬 Deal room active for ${deal.dealCode}.`,
        "",
        "Send messages or upload proof (photos, videos, documents, voice, audio).",
        "",
        TELEGRAM_FOLDER_UPLOAD_EXPLANATION_PLAIN,
        "",
        "Use /done_room when you are finished.",
        "Everything here is stored privately for this deal.",
      ].join("\n"),
    );
  });

  bot.command("done_room", async (ctx) => {
    if (!ctx.from) return;
    await clearActiveDealRoom(BigInt(ctx.from.id));
    await ctx.reply("✅ Left deal room mode.");
  });

  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from || ctx.message.text?.startsWith("/")) return next();
    const dealId = await getActiveDealRoom(BigInt(ctx.from.id));
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
      await ctx.reply("✅ Message saved to the deal record.");
    } catch (e) {
      await ctx.reply(`❌ ${String((e as Error).message)}`);
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
      });
      await ctx.reply(
        [
          "✅ File saved to the deal evidence log.",
          "",
          formatUploadContinuationPlain("type /done_room when you are finished"),
        ].join("\n"),
      );
    } catch (e) {
      await ctx.reply(`❌ ${String((e as Error).message)}`);
    }
  };

  bot.on("message:photo", async (ctx, next) => {
    if (!ctx.from || !(await getActiveDealRoom(BigInt(ctx.from.id)))) return next();
    const p = ctx.message.photo?.slice(-1)[0];
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
    if (!ctx.from || !(await getActiveDealRoom(BigInt(ctx.from.id)))) return next();
    const d = ctx.message.document;
    if (!d) return next();
    await saveMedia(
      ctx,
      "document",
      d.file_id,
      d.file_unique_id,
      d.file_name ?? "document",
      d.mime_type,
      d.file_size,
      ctx.message.caption,
      "[document]",
    );
  });

  bot.on("message:video", async (ctx, next) => {
    if (!ctx.from || !(await getActiveDealRoom(BigInt(ctx.from.id)))) return next();
    const v = ctx.message.video;
    if (!v) return next();
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
    await saveMedia(ctx, "voice", v.file_id, v.file_unique_id, "voice.ogg", "audio/ogg", v.file_size, undefined, "[voice]");
  });

  bot.on("message:audio", async (ctx, next) => {
    if (!ctx.from || !(await getActiveDealRoom(BigInt(ctx.from.id)))) return next();
    const a = ctx.message.audio;
    if (!a) return next();
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
