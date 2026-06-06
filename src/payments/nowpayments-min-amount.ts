import { loadConfig } from "../config/index.js";
import { getRedis } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import { mapCurrencyNetworkToPayCurrency, nowpaymentsPriceAndPayForCreate } from "./nowpayments.provider.js";

const DEFAULT_API_BASE = "https://api.nowpayments.io";
const CACHE_TTL_SEC = 1800;

export type NowpaymentsMinAmountInfo = {
  payCurrency: string;
  priceCurrency: string;
  /** Minimum in pay_currency (on-chain). */
  minPayAmount: number;
  /** Minimum USD equivalent when API provides it. */
  minUsd: number | null;
};

function apiBase(): string {
  const cfg = loadConfig();
  return (cfg.NOWPAYMENTS_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, "");
}

function cacheKey(priceCurrency: string, payCurrency: string): string {
  return `ogmp:np:min:${priceCurrency}:${payCurrency}:fee_user`;
}

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function isNowpaymentsAmountTooSmallError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("amountto is too small") || m.includes("amount to is too small") || m.includes("too small");
}

/** GET /v1/min-amount — cached ~30 min. */
export async function fetchNowpaymentsMinPaymentAmount(params: {
  currency: string;
  network: string;
}): Promise<NowpaymentsMinAmountInfo | null> {
  const cfg = loadConfig();
  if (cfg.PAYMENT_PROVIDER !== "nowpayments") return null;
  const apiKey = cfg.NOWPAYMENTS_API_KEY?.trim();
  if (!apiKey) return null;

  const payCurrency = mapCurrencyNetworkToPayCurrency(params.currency, params.network);
  const pricing = nowpaymentsPriceAndPayForCreate({
    currency: params.currency,
    network: params.network,
    expectedAmount: "1",
  });
  const priceCurrency = pricing.price_currency;
  const key = cacheKey(priceCurrency, payCurrency);

  try {
    const cached = await getRedis().get(key);
    if (cached) return JSON.parse(cached) as NowpaymentsMinAmountInfo;
  } catch {
    /* ignore cache read errors */
  }

  const url = new URL(`${apiBase()}/v1/min-amount`);
  url.searchParams.set("currency_from", priceCurrency);
  url.searchParams.set("currency_to", payCurrency);
  url.searchParams.set("fiat_equivalent", "usd");
  url.searchParams.set("is_fee_paid_by_user", "true");

  try {
    const res = await fetch(url.toString(), { headers: { "x-api-key": apiKey } });
    const text = await res.text();
    if (!res.ok) {
      logger.warn("nowpayments_min_amount_fetch_failed", {
        status: res.status,
        payCurrency,
        body: text.slice(0, 200),
      });
      return null;
    }
    const data = JSON.parse(text) as Record<string, unknown>;
    const minPayAmount = toNum(data.min_amount);
    const minUsdRaw = toNum(data.fiat_equivalent);
    const minUsd = minUsdRaw > 0 ? minUsdRaw : null;
    if (!(minPayAmount > 0) && !minUsd) return null;

    const info: NowpaymentsMinAmountInfo = {
      payCurrency,
      priceCurrency,
      minPayAmount: minPayAmount > 0 ? minPayAmount : 0,
      minUsd,
    };
    try {
      await getRedis().set(key, JSON.stringify(info), "EX", CACHE_TTL_SEC);
    } catch {
      /* ignore cache write */
    }
    return info;
  } catch (e) {
    logger.warn("nowpayments_min_amount_fetch_error", { err: String(e), payCurrency });
    return null;
  }
}

function formatMinAmount(n: number): string {
  if (n >= 1) return n.toFixed(2).replace(/\.?0+$/, "");
  return String(Number(n.toPrecision(6)));
}

/** User-facing minimum — always in the deal coin, never dollars. */
export function formatNowpaymentsMinimumHint(info: NowpaymentsMinAmountInfo, currency: string, network: string): string {
  if (info.minPayAmount > 0) {
    return `Minimum payment is about ${formatMinAmount(info.minPayAmount)} ${currency} on ${network}`;
  }
  if (currency === "USDT" && info.minUsd && info.minUsd > 0) {
    return `Minimum payment is about ${formatMinAmount(info.minUsd)} USDT on ${network}`;
  }
  if (info.minUsd && info.minUsd > 0) {
    return `Minimum payment is about ${formatMinAmount(info.minUsd)} ${currency} on ${network}`;
  }
  return `Minimum payment applies for ${currency} (${network})`;
}

export type MinAmountCheckResult =
  | { ok: true }
  | { ok: false; message: string; minInfo: NowpaymentsMinAmountInfo };

/** Compare processor invoice (pre-NP fees) against NOWPayments /v1/min-amount. */
export async function validateInvoiceMeetsNowpaymentsMinimum(params: {
  currency: string;
  network: string;
  invoiceAmount: string;
}): Promise<MinAmountCheckResult> {
  const minInfo = await fetchNowpaymentsMinPaymentAmount({
    currency: params.currency,
    network: params.network,
  });
  if (!minInfo) return { ok: true };

  const invoice = Number(params.invoiceAmount);
  if (!(invoice > 0)) {
    return {
      ok: false,
      message: "Invalid deal amount.",
      minInfo,
    };
  }

  const pricing = nowpaymentsPriceAndPayForCreate({
    currency: params.currency,
    network: params.network,
    expectedAmount: params.invoiceAmount,
  });

  let tooSmall = false;
  if (pricing.price_currency === "usd" && minInfo.minUsd && minInfo.minUsd > 0) {
    tooSmall = invoice + 1e-9 < minInfo.minUsd;
  } else if (minInfo.minPayAmount > 0) {
    tooSmall = invoice + 1e-12 < minInfo.minPayAmount;
  }

  if (!tooSmall) return { ok: true };

  const hint = formatNowpaymentsMinimumHint(minInfo, params.currency, params.network);
  return {
    ok: false,
    minInfo,
    message: `Too small. ${hint}. Type a bigger amount in ${params.currency} (not dollars).`,
  };
}
