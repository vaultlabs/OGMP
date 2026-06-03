import { generate } from "otplib";
import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";

/** Normalize Google Authenticator base32 secret (spaces, dashes, lowercase). */
export function normalizeTotpSecret(raw: string): string {
  return raw.replace(/\s+/g, "").replace(/-/g, "").toUpperCase();
}

/**
 * Code for POST /v1/payout/{id}/verify.
 * Prefer NOWPAYMENTS_2FA_SECRET (auto TOTP) — fully unattended.
 * Fallback: NOWPAYMENTS_PAYOUT_VERIFY_CODE (manual email code; expires).
 */
export async function resolvePayoutVerificationCode(): Promise<string | undefined> {
  const cfg = loadConfig();
  const secret = cfg.NOWPAYMENTS_2FA_SECRET?.trim();
  if (secret) {
    try {
      const code = await generate({ secret: normalizeTotpSecret(secret) });
      if (code && /^\d{6}$/.test(code)) return code;
      logger.error("nowpayments_totp_invalid_code_shape", { code: code?.slice(0, 8) });
    } catch (e) {
      logger.error("nowpayments_totp_generate_failed", { err: String(e) });
    }
    return undefined;
  }
  const manual = cfg.NOWPAYMENTS_PAYOUT_VERIFY_CODE?.trim();
  if (manual) return manual;
  return undefined;
}

export function isPayoutVerifyConfigured(): boolean {
  const cfg = loadConfig();
  return Boolean(cfg.NOWPAYMENTS_2FA_SECRET?.trim() || cfg.NOWPAYMENTS_PAYOUT_VERIFY_CODE?.trim());
}
