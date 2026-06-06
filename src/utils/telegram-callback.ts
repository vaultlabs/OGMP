import type { Context, InlineKeyboard } from "grammy";

type ReplyExtra = {
  parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
  reply_markup?: InlineKeyboard;
};

/** Update the inline-keyboard message when possible; otherwise send one new reply (avoids chat spam). */
export async function replyOrEditCallbackMessage(
  ctx: Context,
  text: string,
  extra?: ReplyExtra,
): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  if (msg && ("text" in msg || "caption" in msg)) {
    try {
      await ctx.editMessageText(text, extra);
      return;
    } catch {
      /* message too old, unchanged text, or not editable — fall through */
    }
  }
  await ctx.reply(text, extra);
}
