import { createHmac, timingSafeEqual } from "node:crypto";
import type { Deal, Payment, Payout } from "@prisma/client";
import type { PaymentAddressResult, PaymentProvider, PaymentStatusResult, PayoutResult } from "./payment-provider.types.js";
import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";

const DEFAULT_API_BASE = "https://api.nowpayments.io";

/** Recursively sort object keys for IPN HMAC (NOWPayments HelpCenter). Arrays keep element order. */
export function sortJsonForNowPaymentsSignature(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortJsonForNowPaymentsSignature);
  const o = value as Record<string, unknown>;
  return Object.keys(o)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortJsonForNowPaymentsSignature(o[key]);
      return acc;
    }, {});
}

function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function mapCurrencyNetworkToPayCurrency(currency: string, network: string): string {
  const c = currency.trim().toUpperCase();
  const n = network.trim().toUpperCase();
  if (c === "USDT" && n === "TRC20") return "usdttrc20";
  if (c === "USDT" && n === "ERC20") return "usdterc20";
  if (c === "BTC" && n === "BTC") return "btc";
  if (c === "ETH" && n === "ETH") return "eth";
  if (c === "LTC" && n === "LTC") return "ltc";
  return `${c}${n}`.toLowerCase();
}

function priceCurrencyForDeal(currency: string): string {
  return currency.trim().toLowerCase().replace(/\s+/g, "");
}

/** True when NOWPayments failed its internal price_currency → pay_currency estimate (common for USDT↔USDTTRC20). */
export function isNowpaymentsEstimateConversionError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("get estimate") ||
    m.includes("cannot get estimate") ||
    m.includes("can not get estimate") ||
    (m.includes("estimate") && (m.includes("usdt") || m.includes("usdc")))
  );
}

/**
 * NOWPayments estimates price_currency → pay_currency. Invoicing in `usdt` while paying with
 * `usdttrc20` / `usdterc20` hits "Can not get estimate from USDT to USDTTRC20" (HTTP 500).
 * Use fiat `usd` for the invoice when the deal is USDT/USDC but settlement is an on-chain slug.
 */
export function nowpaymentsPriceAndPayForCreate(params: {
  currency: string;
  network: string;
  expectedAmount: string;
}): { price_amount: number; price_currency: string; pay_currency: string } {
  const payCurrency = mapCurrencyNetworkToPayCurrency(params.currency, params.network);
  const priceAmount = toNum(params.expectedAmount);
  if (!(priceAmount > 0)) {
    throw new Error("Invalid expected amount for NOWPayments payment");
  }
  const priceCurrency = priceCurrencyForDeal(params.currency);
  const payLower = payCurrency.toLowerCase();
  if (priceCurrency === "usdt" && payLower.startsWith("usdt")) {
    return { price_amount: priceAmount, price_currency: "usd", pay_currency: payCurrency };
  }
  if (priceCurrency === "usdc" && payLower.startsWith("usdc")) {
    return { price_amount: priceAmount, price_currency: "usd", pay_currency: payCurrency };
  }
  return { price_amount: priceAmount, price_currency: priceCurrency, pay_currency: payCurrency };
}

function extractTxHash(body: Record<string, unknown>): string | undefined {
  const h =
    (typeof body.transaction_hash === "string" && body.transaction_hash) ||
    (typeof body.payin_hash === "string" && body.payin_hash) ||
    (typeof body.outcome_hash === "string" && body.outcome_hash) ||
    (typeof body.txid === "string" && body.txid);
  return h && h.length > 0 ? h : undefined;
}

function mapNowPaymentsPaymentToResult(
  body: Record<string, unknown>,
  requiredConfirmations: number,
): PaymentStatusResult {
  const rawStatus = typeof body.payment_status === "string" ? body.payment_status.toLowerCase() : "";
  const actuallyPaid = toNum(body.actually_paid ?? body.actually_paid_amount);
  const payAmount = toNum(body.pay_amount);
  const txHash = extractTxHash(body);
  const confirmations = toNum(body.confirmations) || (rawStatus === "finished" ? requiredConfirmations : 0);

  let status: PaymentStatusResult["status"] = "pending";
  switch (rawStatus) {
    case "waiting":
      status = actuallyPaid > 0 ? "detecting" : "pending";
      break;
    case "confirming":
    case "confirmed":
    case "sending":
      status = "confirming";
      break;
    case "partially_paid":
      status = "underpaid";
      break;
    case "finished":
      if (payAmount > 0 && actuallyPaid + 1e-12 < payAmount) status = "underpaid";
      else if (payAmount > 0 && actuallyPaid > payAmount + 1e-12) status = "overpaid";
      else status = "confirmed";
      break;
    case "failed":
    case "refunded":
      status = "failed";
      break;
    case "expired":
      status = "expired";
      break;
    default:
      status = "pending";
  }

  return {
    status,
    receivedAmount: String(actuallyPaid),
    txHash,
    confirmations: Math.max(0, Math.floor(confirmations)),
    requiredConfirmations,
    raw: body,
  };
}

/**
 * NOWPayments crypto payments (POST /v1/payment + IPN callbacks).
 * @see https://documenter.getpostman.com/view/7907941/2s93JusNJt
 * @see https://nowpayments.zendesk.com/hc/en-us/articles/21395546303389-IPN-and-how-to-setup
 */
export class NowPaymentsProvider implements PaymentProvider {
  readonly name = "nowpayments";

  private apiBase(): string {
    const cfg = loadConfig();
    return (cfg.NOWPAYMENTS_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, "");
  }

  private requireKeys(): { apiKey: string; ipnSecret: string; publicBase: string } {
    const cfg = loadConfig();
    const apiKey = cfg.NOWPAYMENTS_API_KEY?.trim();
    const ipnSecret = cfg.NOWPAYMENTS_IPN_SECRET?.trim();
    const publicBase = cfg.PUBLIC_BASE_URL?.trim();
    if (!apiKey || !ipnSecret || !publicBase) {
      throw new Error("NOWPayments requires NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET, and PUBLIC_BASE_URL");
    }
    return { apiKey, ipnSecret, publicBase: publicBase.replace(/\/$/, "") };
  }

  verifyWebhook(payload: Buffer | string, signatureHeader: string | undefined): boolean {
    let ipnSecret: string;
    try {
      ipnSecret = this.requireKeys().ipnSecret;
    } catch {
      logger.warn("nowpayments_ipn_missing_secret");
      return false;
    }
    if (!signatureHeader) return false;
    const sig = signatureHeader.trim().toLowerCase();
    const raw = typeof payload === "string" ? payload : payload.toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return false;
    }
    const sorted = sortJsonForNowPaymentsSignature(parsed);
    const signingPayload = JSON.stringify(sorted);
    const expected = createHmac("sha512", ipnSecret).update(signingPayload).digest("hex");
    return timingSafeEqualHex(expected, sig);
  }

  parseWebhook(payload: unknown): {
    idempotencyKey: string;
    paymentExternalId?: string;
    result: PaymentStatusResult;
  } {
    const body = payload as Record<string, unknown>;
    const orderId = body.order_id;
    if (typeof orderId !== "string" || !orderId.trim()) {
      throw new Error("NOWPayments IPN missing order_id");
    }
    const paymentId = body.payment_id;
    const paymentExternalId =
      typeof paymentId === "string" || typeof paymentId === "number" ? String(paymentId) : undefined;
    const required = toNum(body.required_confirmations) || 1;
    const result = mapNowPaymentsPaymentToResult(body, Math.max(1, Math.floor(required)));
    return {
      idempotencyKey: orderId.trim(),
      paymentExternalId,
      result,
    };
  }

  async createPaymentAddress(
    deal: Deal,
    expectedAmount: string,
    currency: string,
    network: string,
  ): Promise<PaymentAddressResult> {
    const { apiKey, publicBase } = this.requireKeys();
    let pricing = nowpaymentsPriceAndPayForCreate({ currency, network, expectedAmount });
    const orderBase = `${this.name}:${deal.id}:${deal.version}`;
    let orderId = orderBase;
    const ipnUrl = `${publicBase}/webhooks/payments/${this.name}`;
    const url = `${this.apiBase()}/v1/payment`;

    for (let i = 0; i < 2; i++) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          price_amount: pricing.price_amount,
          price_currency: pricing.price_currency,
          pay_currency: pricing.pay_currency,
          ipn_callback_url: ipnUrl,
          order_id: orderId,
          order_description: `OGMP ${deal.dealCode}`.slice(0, 200),
        }),
      });
      const text = await res.text();
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        logger.error("nowpayments_create_payment_bad_json", { status: res.status, text: text.slice(0, 500) });
        throw new Error(`NOWPayments create payment: non-JSON response (${res.status})`);
      }

      if (res.ok) {
        const addr =
          (typeof data.pay_address === "string" && data.pay_address) ||
          (typeof data.payment_address === "string" && data.payment_address) ||
          (typeof data.deposit_address === "string" && data.deposit_address);
        if (!addr) {
          logger.error("nowpayments_create_payment_no_address", { keys: Object.keys(data) });
          throw new Error("NOWPayments create payment response missing pay address");
        }
        const paymentId = data.payment_id;
        const ref = typeof paymentId === "string" || typeof paymentId === "number" ? String(paymentId) : undefined;
        const reqConf = data.required_confirmations;
        const requiredConfirmations =
          typeof reqConf === "number" && Number.isFinite(reqConf) && reqConf > 0
            ? Math.floor(reqConf)
            : undefined;

        return {
          address: addr,
          reference: ref,
          providerRef: ref,
          requiredConfirmations,
        };
      }

      const msgRaw =
        (typeof data.message === "string" && data.message) ||
        (typeof data.error === "string" && data.error) ||
        text.slice(0, 500);
      logger.error("nowpayments_create_payment_http_error", {
        status: res.status,
        message: msgRaw,
        price_currency: pricing.price_currency,
        pay_currency: pricing.pay_currency,
        attempt: i + 1,
      });

      const retryUsd =
        i === 0 &&
        pricing.price_currency !== "usd" &&
        isNowpaymentsEstimateConversionError(msgRaw);
      if (retryUsd) {
        logger.warn("nowpayments_create_payment_retry_usd_invoice", {
          pay_currency: pricing.pay_currency,
          firstError: msgRaw,
        });
        pricing = { ...pricing, price_currency: "usd" };
        orderId = `${orderBase}:usd-retry`;
        continue;
      }

      throw new Error(typeof data.message === "string" ? `NOWPayments: ${data.message}` : `NOWPayments create payment failed (${res.status})`);
    }

    throw new Error("NOWPayments create payment failed after retry");
  }

  async checkPaymentStatus(payment: Payment): Promise<PaymentStatusResult> {
    const { apiKey } = this.requireKeys();
    const paymentId = payment.reference?.trim();
    if (!paymentId) {
      throw new Error("Payment row missing NOWPayments payment id (reference)");
    }
    const url = `${this.apiBase()}/v1/payment/${encodeURIComponent(paymentId)}`;
    const res = await fetch(url, { headers: { "x-api-key": apiKey } });
    const text = await res.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      logger.error("nowpayments_get_payment_bad_json", { status: res.status, text: text.slice(0, 500) });
      throw new Error(`NOWPayments get payment: non-JSON (${res.status})`);
    }
    if (!res.ok) {
      logger.error("nowpayments_get_payment_http_error", {
        status: res.status,
        message: data.message ?? data.error ?? text.slice(0, 300),
      });
      throw new Error(
        typeof data.message === "string" ? `NOWPayments: ${data.message}` : `NOWPayments get payment (${res.status})`,
      );
    }
    return mapNowPaymentsPaymentToResult(data, Math.max(1, payment.requiredConfirmations));
  }

  async createPayout(_payout: Payout, _destinationAddress: string): Promise<PayoutResult> {
    void _payout;
    void _destinationAddress;
    logger.warn("nowpayments_create_payout_not_implemented");
    throw new Error(
      "NOWPayments mass payouts are not automated in OGMP yet. Complete the payout in your NOWPayments dashboard and update the Payout row manually if needed.",
    );
  }
}
