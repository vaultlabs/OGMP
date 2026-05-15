import { AppError } from "./errors.js";

/** Generic reply when an unexpected error is caught (no stack, paths, or secrets). */
export const GENERIC_TRY_AGAIN =
  "Something went wrong on our side. Please try again in a moment. If it keeps happening, open My deals or use /support with your deal code. Do not share passwords, seed phrases, or API keys in chat.";

/**
 * Map caught errors to text safe to show in Telegram.
 * Only {@link AppError} subclasses expose user-written messages; everything else is generic.
 */
export function replyTextForCaughtError(e: unknown): string {
  if (e instanceof AppError) return e.message;
  return GENERIC_TRY_AGAIN;
}

/** Buyer DM when escrow payment address could not be created (one clear next step). */
export function paymentAddressSetupFailedBuyerMessage(dealCode: string): string {
  return `Deal ${dealCode}: pay address is not ready yet. Next: wait 1 minute → View deal again. Do not send crypto until the deal card shows the pay address. If it repeats: /support with this deal code only.`;
}

/** Seller DM when payment address creation failed (one clear next step). */
export function paymentAddressSetupFailedSellerMessage(dealCode: string): string {
  return `Deal ${dealCode}: buyer pay address did not issue yet (our side). Next: wait 1 minute → View deal. Do not ask the buyer to send crypto until a pay address appears on the deal card. If it repeats: /support with this deal code only.`;
}
