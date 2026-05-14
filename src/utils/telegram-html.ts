/** Escape text for Telegram HTML parse_mode. */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape dynamic text for Telegram legacy `parse_mode: "Markdown"` (Bot API “Markdown”, not MarkdownV2).
 * Prevents 400 entity parse errors from user-controlled fields (names, report text, etc.).
 */
export function escapeTelegramMarkdownLegacy(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[")
    .replace(/`/g, "\\`");
}
