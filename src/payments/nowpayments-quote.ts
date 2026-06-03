import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { nowpaymentsPriceAndPayForCreate } from "./nowpayments.provider.js";

const DEFAULT_API_BASE = "https://api.nowpayments.io";

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function apiBase(): string {
  const cfg = loadConfig();
  return (cfg.NOWPAYMENTS_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, "");
}

function requireApiKey(): string {
  const key = loadConfig().NOWPAYMENTS_API_KEY?.trim();
  if (!key) throw new Error("NOWPAYMENTS_API_KEY is required");
  return key;
}

/** Invoice amount (before NOWPayments adds service/network fees to the buyer). */
export type NowpaymentsInvoiceParams = {
  currency: string;
  network: string;
  /** Deal-side invoice total in price_currency units (deal + OGMP fee slice). */
  invoiceAmount: string;
};

export type NowpaymentsPayQuote = {
  priceAmount: number;
  priceCurrency: string;
  payCurrency: string;
  /** Crypto amount buyer must send (estimate until POST /payment returns final pay_amount). */
  estimatedPayAmount: number;
  /** OGMP uses this multiplier when estimate endpoint excludes NP service fee. */
  serviceFeeMultiplier: number;
};

/**
 * GET /v1/estimate — approximate pay_currency amount for a fiat/crypto invoice.
 * Final amount comes from POST /v1/payment `pay_amount` with is_fee_paid_by_user.
 */
export async function fetchNowpaymentsPayQuote(params: NowpaymentsInvoiceParams): Promise<NowpaymentsPayQuote> {
  const pricing = nowpaymentsPriceAndPayForCreate({
    currency: params.currency,
    network: params.network,
    expectedAmount: params.invoiceAmount,
  });
  const apiKey = requireApiKey();
  const url = new URL(`${apiBase()}/v1/estimate`);
  url.searchParams.set("amount", String(pricing.price_amount));
  url.searchParams.set("currency_from", pricing.price_currency);
  url.searchParams.set("currency_to", pricing.pay_currency);

  const res = await fetch(url.toString(), { headers: { "x-api-key": apiKey } });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    logger.error("nowpayments_estimate_bad_json", { status: res.status, text: text.slice(0, 300) });
    throw new Error(`NOWPayments estimate: non-JSON (${res.status})`);
  }
  if (!res.ok) {
    throw new Error(typeof data.message === "string" ? `NOWPayments: ${data.message}` : `NOWPayments estimate (${res.status})`);
  }

  const estimated = toNum(data.estimated_amount ?? data.amount);
  if (!(estimated > 0)) {
    throw new Error("NOWPayments estimate returned no amount");
  }

  const cfg = loadConfig();
  const npFeePct = cfg.NOWPAYMENTS_SERVICE_FEE_PERCENT
    ? Math.max(0, toNum(cfg.NOWPAYMENTS_SERVICE_FEE_PERCENT))
    : 0.01;
  const serviceFeeMultiplier = 1 + npFeePct;

  return {
    priceAmount: pricing.price_amount,
    priceCurrency: pricing.price_currency,
    payCurrency: pricing.pay_currency,
    estimatedPayAmount: estimated * serviceFeeMultiplier,
    serviceFeeMultiplier,
  };
}
