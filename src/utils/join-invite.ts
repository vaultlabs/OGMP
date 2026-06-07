/** Pull invite token from pasted t.me link, /start join_ payload, or raw token. */
export function extractJoinTokenFromText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) return null;

  const deep = trimmed.match(/join_([A-Za-z0-9_-]+)/i);
  if (deep?.[1]) return deep[1];

  if (/^[A-Za-z0-9_-]{16,64}$/.test(trimmed)) return trimmed;
  return null;
}
