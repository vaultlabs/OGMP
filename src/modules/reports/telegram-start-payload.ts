/**
 * Extract Telegram deep-link payload after /start (handles /start@BotUsername payload).
 * @see https://core.telegram.org/bots/features#deep-linking
 */
export function extractTelegramStartPayload(messageText: string | undefined): string | undefined {
  const raw = messageText?.trim();
  if (!raw || !raw.toLowerCase().startsWith("/start")) return undefined;
  const m = raw.match(/^\/start(@\S+)?(?:\s+(.*))?$/is);
  const payload = (m?.[2] ?? "").trim();
  return payload.length > 0 ? payload : undefined;
}
