import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";

const DEFAULT_API_BASE = "https://api.nowpayments.io";
const TOKEN_TTL_MS = 4 * 60 * 1000;

let cachedToken: { token: string; expiresAt: number } | null = null;

function apiBase(): string {
  const cfg = loadConfig();
  return (cfg.NOWPAYMENTS_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, "");
}

/**
 * JWT for mass payouts (POST /v1/payout). Cached ~4 minutes.
 * Dashboard "Sign in with Google" still uses an account email — set an API password via Reset password (see docs/ENV_SETUP.md).
 */
export async function getNowpaymentsBearerToken(): Promise<string> {
  const cfg = loadConfig();
  const preset = cfg.NOWPAYMENTS_BEARER_TOKEN?.trim();
  if (preset) {
    return preset;
  }

  const email = cfg.NOWPAYMENTS_EMAIL?.trim();
  const password = cfg.NOWPAYMENTS_PASSWORD?.trim();
  if (!email || !password) {
    throw new Error(
      "NOWPayments payouts need NOWPAYMENTS_EMAIL + NOWPAYMENTS_PASSWORD (API password, not your Google login). " +
        "If you only use Google on the website: login page → Reset password → set a password for your account email, then put that email and password in .env. See docs/ENV_SETUP.md.",
    );
  }

  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.token;
  }

  const res = await fetch(`${apiBase()}/v1/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`NOWPayments auth: non-JSON (${res.status})`);
  }
  if (!res.ok) {
    const msg =
      (typeof data.message === "string" && data.message) ||
      (typeof data.error === "string" && data.error) ||
      text.slice(0, 300);
    logger.error("nowpayments_auth_failed", { status: res.status, message: msg });
    throw new Error(`NOWPayments auth failed (${res.status}): ${msg}`);
  }
  const token = typeof data.token === "string" ? data.token : undefined;
  if (!token) throw new Error("NOWPayments auth response missing token");

  cachedToken = { token, expiresAt: now + TOKEN_TTL_MS };
  return token;
}

/** Vitest only */
export function resetNowpaymentsAuthCacheForTests(): void {
  cachedToken = null;
}
