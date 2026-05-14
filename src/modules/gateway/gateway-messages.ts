import { InlineKeyboard } from "grammy";

export const GATEWAY_DIV = "━━━━━━━━━━━━━━━━━━";

export const GATEWAY_ACCESS_REQUIRED_LONG = [
  GATEWAY_DIV,
  "OGMP MM — Access Required",
  GATEWAY_DIV,
  "",
  "To use OGMP MM, you must first join our official OGMP gateway.",
  "",
  "This helps us keep the marketplace safer, cleaner, and verified for all users.",
  "",
  "Step 1: Join the OGMP Gateway",
  "Step 2: Return here and tap “I Joined — Continue”",
].join("\n");

export const GATEWAY_ACCESS_REQUIRED_SHORT = [
  GATEWAY_DIV,
  "OGMP MM — Access Required",
  GATEWAY_DIV,
  "",
  "Please join the OGMP Gateway before using the escrow bot.",
  "",
  "After joining, come back and tap continue.",
].join("\n");

export const GATEWAY_ACCESS_APPROVED = [
  GATEWAY_DIV,
  "OGMP MM — Access Approved",
  GATEWAY_DIV,
  "",
  "You now have access to OGMP MM.",
  "",
  "Welcome to secure middleman deals.",
].join("\n");

export const GATEWAY_NOT_CONFIRMED =
  "Access not confirmed yet. Join the gateway, then tap “I Joined — Continue” again.";

export function gatewayAccessKeyboard(joinUrl: string): InlineKeyboard {
  return new InlineKeyboard().url("Join OGMP Gateway", joinUrl).row().text("I Joined — Continue", "gw:continue");
}
