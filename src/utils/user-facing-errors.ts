import { AppError } from "./errors.js";

/** Generic reply when an unexpected error is caught (no stack, paths, or secrets). */
export const GENERIC_TRY_AGAIN =
  "Something went wrong. Your deal is still safe. Please try again or contact support.";

/**
 * Map caught errors to text safe to show in Telegram.
 * Only {@link AppError} subclasses expose user-written messages; everything else is generic.
 */
export function replyTextForCaughtError(e: unknown): string {
  if (e instanceof AppError) return e.message;
  return GENERIC_TRY_AGAIN;
}

/** When escrow payment address could not be created (server logs retain details). */
export function paymentAddressSetupFailedUserMessage(dealCode: string): string {
  return [
    `Deal ${dealCode}: we could not finish payment setup yet (no pay address was issued).`,
    "",
    "What you can do:",
    "• Wait one minute, open the deal from My deals, and check again.",
    "• If you are still setting the deal up, follow the bot’s steps in order (terms, delivery lock for seller, then pay for buyer).",
    "• If this keeps happening, use Request cancel on the deal card, or /support with this deal code only.",
    "",
    "Stay safe: do not send crypto until this bot shows a pay address on the deal screen. Never paste API keys, IPN secrets, or wallet seeds here.",
  ].join("\n");
}
