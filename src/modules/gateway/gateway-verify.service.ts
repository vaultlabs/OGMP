import { GrammyError } from "grammy";
import type { Api } from "grammy";
import { logger } from "../../utils/logger.js";

function isMemberStatusOk(status: string): boolean {
  return status === "creator" || status === "administrator" || status === "member";
}

/**
 * Returns whether the user is in the gateway chat/channel.
 * On API errors (bot not admin, wrong chat id), returns ok: false with api_error.
 */
export async function verifyGatewayChatMembership(
  api: Api,
  chatId: string,
  userTelegramId: bigint,
): Promise<
  | { ok: true }
  | { ok: false; reason: "not_member" }
  | { ok: false; reason: "api_error"; description: string }
> {
  try {
    const m = await api.getChatMember(chatId, Number(userTelegramId));
    const st = m.status;
    if (st === "restricted" && "is_member" in m && m.is_member) return { ok: true };
    if (isMemberStatusOk(st)) return { ok: true };
    return { ok: false, reason: "not_member" };
  } catch (e) {
    const desc = e instanceof GrammyError ? `${e.error_code}: ${e.description}` : String(e);
    return { ok: false, reason: "api_error", description: desc };
  }
}

export function logGatewayVerificationSkipped(description: string, meta: Record<string, string>): void {
  logger.warn("gateway_membership_check_skipped", { ...meta, description });
}
