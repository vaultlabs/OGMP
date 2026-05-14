/**
 * Escape dynamic text for Telegram Bot API legacy "Markdown" parse_mode.
 * Prevents 400 "can't parse entities" when user/deal content contains _ * ` [
 * @see https://core.telegram.org/bots/api#markdown-style
 */
export function escapeTelegramLegacyMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[");
}
