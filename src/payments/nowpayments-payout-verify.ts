import { createGuardrails, generate } from "otplib";
import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";

/** NOWPayments issues 15-character base32 keys; otplib default minimum is 16 bytes. */
const NOWPAYMENTS_TOTP_GUARDRAILS = createGuardrails({ MIN_SECRET_BYTES: 9 });

/** Normalize Google Authenticator base32 secret (spaces, dashes, lowercase). */
export function normalizeTotpSecret(raw: string): string {
  return raw.replace(/\s+/g, "").replace(/-/g, "").toUpperCase();
}

/** Decoded byte length of a base32 secret (Authenticator / NOWPayments setup key). */
export function totpSecretDecodedByteLength(normalizedBase32: string): number {
  return Math.floor((normalizedBase32.length * 5) / 8);
}

/** NOWPayments 2FA setup keys are 15 base32 characters (not the 6-digit login code). */
export const NOWPAYMENTS_TOTP_SECRET_LENGTH = 15;

/**
 * Validates NOWPayments / Google Authenticator setup key (not the 6-digit login code).
 */
export function assertTotpSecretValid(raw: string): string {
  const s = normalizeTotpSecret(raw);
  if (!s) {
    throw new Error("NOWPAYMENTS_2FA_SECRET is empty.");
  }
  if (!/^[A-Z2-7]+$/.test(s)) {
    throw new Error(
      "NOWPAYMENTS_2FA_SECRET must be the base32 setup key (A–Z, 2–7 only). " +
        "Do not paste the 6-digit Authenticator code or your NOWPayments password.",
    );
  }
  if (s.length < NOWPAYMENTS_TOTP_SECRET_LENGTH) {
    throw new Error(
      `NOWPAYMENTS_2FA_SECRET is too short (${s.length} characters; NOWPayments keys are ${NOWPAYMENTS_TOTP_SECRET_LENGTH}). ` +
        "Copy the full Key from 2FA setup — all 15 characters, no spaces.",
    );
  }
  return s;
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
      const normalized = assertTotpSecretValid(secret);
      const code = await generate({
        secret: normalized,
        guardrails: NOWPAYMENTS_TOTP_GUARDRAILS,
      });
      if (code && /^\d{6}$/.test(code)) return code;
      logger.error("nowpayments_totp_invalid_code_shape", { code: code?.slice(0, 8) });
    } catch (e) {
      logger.error("nowpayments_totp_generate_failed", { err: String(e) });
    }
  }
  const manual = cfg.NOWPAYMENTS_PAYOUT_VERIFY_CODE?.trim();
  if (manual) {
    if (/^\d{6}$/.test(manual)) return manual;
    logger.error("nowpayments_payout_verify_code_invalid", { hint: "must be exactly 6 digits" });
    return undefined;
  }
  if (secret) {
    logger.error("nowpayments_payout_verify_empty_code", {
      hint:
        "Fix NOWPAYMENTS_2FA_SECRET (full 15-character NOWPayments 2FA key) or set NOWPAYMENTS_PAYOUT_VERIFY_CODE from email, then restart bot.",
    });
  }
  return undefined;
}

export function isPayoutVerifyConfigured(): boolean {
  const cfg = loadConfig();
  return Boolean(cfg.NOWPAYMENTS_2FA_SECRET?.trim() || cfg.NOWPAYMENTS_PAYOUT_VERIFY_CODE?.trim());
}
