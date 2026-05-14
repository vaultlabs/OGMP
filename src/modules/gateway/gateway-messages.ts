import { InlineKeyboard } from "grammy";
import { MAIN_UI_PARSE_MODE, RULER_HTML } from "../../bots/mainBot/trust-copy.js";

export { MAIN_UI_PARSE_MODE };

export const GATEWAY_ACCESS_REQUIRED_LONG = [
  `<b>OGMP MM</b> · <i>Gateway access</i>`,
  RULER_HTML,
  "",
  "To use this bot you first join the official <b>OGMP gateway</b>.",
  "",
  "<b>Steps</b>",
  "1. Tap <b>Join OGMP Gateway</b> below",
  "2. Return here and tap <b>I joined — Continue</b>",
  "",
  "<i>This helps keep spam and bad actors out of the marketplace.</i>",
].join("\n");

export const GATEWAY_ACCESS_REQUIRED_SHORT = [
  `<b>OGMP MM</b> · <i>Gateway required</i>`,
  RULER_HTML,
  "",
  "Join the OGMP Gateway, then come back and tap <b>Continue</b>.",
].join("\n");

export const GATEWAY_ACCESS_APPROVED = [
  `<b>Access approved</b>`,
  RULER_HTML,
  "",
  "You can use OGMP MM now.",
  "",
  "<b>Next</b>",
  "Send /start or use the menu to create or join a deal.",
].join("\n");

export const GATEWAY_NOT_CONFIRMED =
  "Not confirmed yet. Join the gateway, then tap <b>I joined — Continue</b> again.";

export function gatewayAccessKeyboard(joinUrl: string): InlineKeyboard {
  return new InlineKeyboard().url("Join OGMP Gateway", joinUrl).row().text("I joined — Continue", "gw:continue");
}
