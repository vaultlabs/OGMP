/** Pull invite token from pasted t.me link, /start join_ payload, or explicit "join TOKEN" paste. */
export function extractJoinTokenFromText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) return null;

  const deep = trimmed.match(/join_([A-Za-z0-9_-]+)/i);
  if (deep?.[1]) return deep[1];

  const explicit = trimmed.match(/^join[:\s]+([A-Za-z0-9_-]+)$/i);
  if (explicit?.[1]) return explicit[1];

  return null;
}
