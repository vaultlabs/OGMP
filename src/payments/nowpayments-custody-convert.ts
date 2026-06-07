import { loadConfig } from "../config/index.js";
import { getNowpaymentsBearerToken } from "./nowpayments-auth.js";
import { fetchNowpaymentsBalance, type NowpaymentsBalanceRow } from "./nowpayments-balance.js";
import { mapCurrencyNetworkToPayCurrency } from "./nowpayments.provider.js";
import { logger } from "../utils/logger.js";

const DEFAULT_API_BASE = "https://api.nowpayments.io";
const CONVERSION_POLL_MS = 2000;
const CONVERSION_POLL_MAX = 30;

function apiBase(): string {
  const cfg = loadConfig();
  return (cfg.NOWPAYMENTS_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, "");
}

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function isAutoCustodyConvertEnabled(): boolean {
  const cfg = loadConfig();
  if (cfg.PAYMENT_PROVIDER !== "nowpayments") return false;
  return cfg.NOWPAYMENTS_AUTO_CUSTODY_CONVERT !== false;
}

/** GET /v1/estimate — how much `to_currency` you receive for `amount` of `from_currency`. */
async function estimateReceiveAmount(
  apiKey: string,
  fromCurrency: string,
  toCurrency: string,
  fromAmount: number,
): Promise<number> {
  const url = new URL(`${apiBase()}/v1/estimate`);
  url.searchParams.set("amount", String(fromAmount));
  url.searchParams.set("currency_from", fromCurrency);
  url.searchParams.set("currency_to", toCurrency);
  const res = await fetch(url.toString(), { headers: { "x-api-key": apiKey } });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`NOWPayments estimate: non-JSON (${res.status})`);
  }
  if (!res.ok) {
    const msg = typeof data.message === "string" ? data.message : text.slice(0, 200);
    throw new Error(`NOWPayments estimate failed: ${msg}`);
  }
  return toNum(data.estimated_amount ?? data.amount);
}

/** Find smallest `fromAmount` (≤ maxFrom) that yields at least `targetReceive` in to_currency. */
async function solveFromAmountForTarget(
  apiKey: string,
  fromCurrency: string,
  toCurrency: string,
  targetReceive: number,
  maxFrom: number,
): Promise<number | null> {
  if (maxFrom <= 0 || targetReceive <= 0) return null;
  let lo = 0;
  let hi = maxFrom;
  let best: number | null = null;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (mid <= 0) break;
    let received = 0;
    try {
      received = await estimateReceiveAmount(apiKey, fromCurrency, toCurrency, mid);
    } catch {
      hi = mid;
      continue;
    }
    if (received >= targetReceive) {
      best = mid;
      hi = mid;
    } else {
      lo = mid;
    }
  }
  if (best) return best;
  try {
    const atMax = await estimateReceiveAmount(apiKey, fromCurrency, toCurrency, maxFrom);
    if (atMax >= targetReceive) return maxFrom;
  } catch {
    /* ignore */
  }
  return null;
}

async function createConversion(
  apiKey: string,
  bearer: string,
  fromCurrency: string,
  toCurrency: string,
  amount: number,
): Promise<string> {
  const res = await fetch(`${apiBase()}/v1/conversion`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      from_currency: fromCurrency,
      to_currency: toCurrency,
      amount,
    }),
  });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`NOWPayments conversion: non-JSON (${res.status})`);
  }
  if (!res.ok) {
    const msg =
      (typeof data.message === "string" && data.message) ||
      (typeof data.error === "string" && data.error) ||
      text.slice(0, 300);
    throw new Error(`NOWPayments conversion failed (${res.status}): ${msg}`);
  }
  const id = pickConversionId(data);
  if (!id) {
    logger.warn("custody_convert_bad_response", { status: res.status, body: text.slice(0, 400) });
    throw new Error("NOWPayments conversion response missing id/deposit_id");
  }
  return id;
}

/** NOWPayments wraps conversion id in `{ result: { id } }` on some accounts. */
export function pickConversionId(data: Record<string, unknown>): string | null {
  const nested =
    data.result && typeof data.result === "object" && data.result !== null
      ? (data.result as Record<string, unknown>)
      : null;
  for (const src of [nested, data]) {
    if (!src) continue;
    for (const key of ["deposit_id", "id", "conversion_id"] as const) {
      const v = src[key];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
    }
  }
  return null;
}

async function waitConversionFinished(
  apiKey: string,
  bearer: string,
  conversionId: string,
): Promise<boolean> {
  for (let i = 0; i < CONVERSION_POLL_MAX; i++) {
    const res = await fetch(`${apiBase()}/v1/conversion/${encodeURIComponent(conversionId)}`, {
      headers: { "x-api-key": apiKey, Authorization: `Bearer ${bearer}` },
    });
    const text = await res.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      await sleep(CONVERSION_POLL_MS);
      continue;
    }
    const status = String(data.status ?? data.state ?? "").toUpperCase();
    if (status === "FINISHED" || status === "COMPLETED" || status === "SUCCESS") return true;
    if (status === "FAILED" || status === "REJECTED" || status === "ERROR") return false;
    await sleep(CONVERSION_POLL_MS);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Before payout: if Custody lacks the deal coin, swap from another Custody balance via NOWPayments API.
 * Buyer pay-in still lands per coin; this covers paying sellers when float is in other coins.
 */
export async function ensureCustodyBalanceForPayout(params: {
  currency: string;
  network: string;
  amountNeeded: string;
}): Promise<{ ok: boolean; detail?: string }> {
  if (!isAutoCustodyConvertEnabled()) return { ok: true };

  const payCur = mapCurrencyNetworkToPayCurrency(params.currency, params.network);
  const needed = Number(params.amountNeeded);
  if (!(needed > 0)) return { ok: true };

  const cfg = loadConfig();
  const apiKey = cfg.NOWPAYMENTS_API_KEY?.trim();
  if (!apiKey) return { ok: true };

  let balances = await fetchNowpaymentsBalance();
  if (!balances) return { ok: true };

  const available = balances[payCur]?.amount ?? 0;
  // Float tolerance — payout amount should already be capped to available/received.
  if (available + 1e-8 >= needed) {
    return { ok: true };
  }

  const shortfall = needed - available;
  logger.warn("custody_convert_needed", { payCur, needed, available, shortfall });

  const sources = Object.entries(balances)
    .filter(([cur, row]) => cur !== payCur && row.amount > 0)
    .sort((a, b) => b[1].amount - a[1].amount);

  if (sources.length === 0) {
    return {
      ok: false,
      detail: `Custody needs ${needed} ${payCur} but only ${available} available and no other coins to convert.`,
    };
  }

  const bearer = await getNowpaymentsBearerToken();

  for (const [fromCur, row] of sources) {
    try {
      const fromAmount = await solveFromAmountForTarget(
        apiKey,
        fromCur,
        payCur,
        shortfall * 1.03,
        row.amount * 0.995,
      );
      if (!fromAmount || fromAmount <= 0) continue;

      logger.warn("custody_convert_start", { from: fromCur, to: payCur, fromAmount });
      const convId = await createConversion(apiKey, bearer, fromCur, payCur, fromAmount);
      const done = await waitConversionFinished(apiKey, bearer, convId);
      if (!done) {
        logger.warn("custody_convert_timeout", { convId, from: fromCur, to: payCur });
        continue;
      }

      balances = await fetchNowpaymentsBalance();
      const newAvail = balances?.[payCur]?.amount ?? 0;
      if (newAvail + 1e-8 >= needed) {
        logger.warn("custody_convert_ok", { payCur, newAvail, needed });
        return { ok: true };
      }
    } catch (e) {
      logger.warn("custody_convert_attempt_failed", { from: fromCur, to: payCur, err: String(e) });
    }
  }

  const finalAvail = (await fetchNowpaymentsBalance())?.[payCur]?.amount ?? 0;
  return {
    ok: finalAvail + 1e-8 >= needed,
    detail:
      finalAvail + 1e-8 >= needed
        ? undefined
        : `After auto-convert, Custody has ${finalAvail} ${payCur} but payout needs ${needed}. Top up Custody or convert manually in NOWPayments.`,
  };
}

export function payCurrencyForDeal(currency: string, network: string): string {
  return mapCurrencyNetworkToPayCurrency(currency, network);
}

export type { NowpaymentsBalanceRow };
