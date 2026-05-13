import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Deal, Payment, Payout } from "@prisma/client";
import type { PaymentAddressResult, PaymentProvider, PaymentStatusResult, PayoutResult } from "./payment-provider.types.js";
import { getRedis } from "../utils/redis.js";
import { loadConfig } from "../config/index.js";

const MOCK_STATE_PREFIX = "ogmp:mockpay:v1:";

/**
 * Development / staging payment provider.
 * Simulates unique addresses and payment detection via Redis + signed webhooks.
 * TODO: Never enable PAYMENT_PROVIDER=mock in real production with real funds.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";

  verifyWebhook(payload: Buffer | string, signatureHeader: string | undefined): boolean {
    const cfg = loadConfig();
    const secret = cfg.MOCK_WEBHOOK_SECRET;
    if (!secret) return false;
    if (!signatureHeader?.startsWith("sha256=")) return false;
    const sig = signatureHeader.slice("sha256=".length);
    const body = typeof payload === "string" ? payload : payload.toString("utf8");
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    return timingSafeEqualHex(sig, expected);
  }

  parseWebhook(payload: unknown): {
    idempotencyKey: string;
    paymentExternalId?: string;
    result: PaymentStatusResult;
  } {
    const p = payload as {
      idempotencyKey: string;
      receivedAmount?: string;
      txHash?: string;
      confirmations?: number;
      requiredConfirmations?: number;
      status?: PaymentStatusResult["status"];
    };
    if (!p?.idempotencyKey) throw new Error("mock webhook missing idempotencyKey");
    const required = p.requiredConfirmations ?? 1;
    const confirmations = p.confirmations ?? 0;
    const received = p.receivedAmount ?? "0";
    const status: PaymentStatusResult["status"] =
      p.status ??
      (confirmations >= required ? "confirmed" : received !== "0" ? "confirming" : "pending");
    return {
      idempotencyKey: p.idempotencyKey,
      result: {
        status,
        receivedAmount: received,
        txHash: p.txHash,
        confirmations,
        requiredConfirmations: required,
        raw: p,
      },
    };
  }

  async createPaymentAddress(
    deal: Deal,
    expectedAmount: string,
    _currency: string,
    network: string,
  ): Promise<PaymentAddressResult> {
    const seed = `${deal.id}:${expectedAmount}:${network}`;
    const addr = `MOCK_${createHash("sha256").update(seed).digest("hex").slice(0, 34)}`;
    return {
      address: addr,
      reference: deal.inviteToken,
      providerRef: deal.id,
      expiresAt: deal.paymentExpiresAt ?? undefined,
      requiredConfirmations: 2,
    };
  }

  async checkPaymentStatus(payment: Payment): Promise<PaymentStatusResult> {
    const r = getRedis();
    const raw = await r.get(`${MOCK_STATE_PREFIX}${payment.idempotencyKey}`);
    if (!raw) {
      return {
        status: "pending",
        receivedAmount: "0",
        confirmations: 0,
        requiredConfirmations: payment.requiredConfirmations,
      };
    }
    const parsed = JSON.parse(raw) as {
      receivedAmount: string;
      confirmations: number;
      txHash?: string;
    };
    const required = payment.requiredConfirmations;
    const confirmations = parsed.confirmations ?? 0;
    let status: PaymentStatusResult["status"] = "pending";
    if (Number(parsed.receivedAmount) > 0 && confirmations < required) status = "confirming";
    if (confirmations >= required) {
      const expected = Number(payment.expectedAmount.toString());
      const got = Number(parsed.receivedAmount);
      if (got < expected) status = "underpaid";
      else if (got > expected) status = "overpaid";
      else status = "confirmed";
    }
    return {
      status,
      receivedAmount: parsed.receivedAmount,
      txHash: parsed.txHash,
      confirmations,
      requiredConfirmations: required,
      raw: parsed,
    };
  }

  async createPayout(_payout: Payout, _destinationAddress: string): Promise<PayoutResult> {
    void _payout;
    void _destinationAddress;
    return {
      payoutId: `mock_payout_${randomBytes(8).toString("hex")}`,
      status: "completed",
      txHash: `0x${randomBytes(32).toString("hex")}`,
    };
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length) return false;
    let out = 0;
    for (let i = 0; i < ba.length; i++) out |= ba[i]! ^ bb[i]!;
    return out === 0;
  } catch {
    return false;
  }
}
