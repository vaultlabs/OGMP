import { InlineKeyboard } from "grammy";

export const GATEWAY_DIV = "━━━━━━━━━━━━━━━━━━";

/** Single gateway prompt — used by /start and middleware (no LONG vs SHORT dupes). */
export const GATEWAY_ACCESS_PROMPT = [
  GATEWAY_DIV,
  "<b>OGMP MM</b> — Join Gateway First",
  GATEWAY_DIV,
  "",
  "<b>Step 1</b>  Tap <b>Join OGMP Gateway</b> below",
  "<b>Step 2</b>  Come back and tap <b>I Joined — Continue</b>",
  "",
  "This keeps the marketplace safer for everyone.",
].join("\n");

/** @deprecated Use GATEWAY_ACCESS_PROMPT — kept for imports during transition */
export const GATEWAY_ACCESS_REQUIRED_LONG = GATEWAY_ACCESS_PROMPT;

/** @deprecated Use GATEWAY_ACCESS_PROMPT */
export const GATEWAY_ACCESS_REQUIRED_SHORT = GATEWAY_ACCESS_PROMPT;

export const GATEWAY_ACCESS_APPROVED = [
  GATEWAY_DIV,
  "<b>OGMP MM</b> — You're In",
  GATEWAY_DIV,
  "",
  "Gateway step done. Welcome to secure middleman deals.",
].join("\n");

export const GATEWAY_NOT_CONFIRMED =
  "Not confirmed yet. Join the gateway, then tap <b>I Joined — Continue</b> again.";

export function gatewayAccessKeyboard(joinUrl: string): InlineKeyboard {
  return new InlineKeyboard()
    .url("Join OGMP Gateway", joinUrl)
    .row()
    .text("I Joined — Continue", "gw:continue");
}
