import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCacheForTests } from "../config/index.js";
import { NowPaymentsProvider, sortJsonForNowPaymentsSignature } from "./nowpayments.provider.js";

function npEnv() {
  process.env.DATABASE_URL = "postgresql://ogmp:ogmp@127.0.0.1:5432/ogmp_mm?schema=public";
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.MAIN_BOT_TOKEN = "123456:TEST_TOKEN_PLACEHOLDER";
  process.env.MOCK_WEBHOOK_SECRET = "x".repeat(40);
  process.env.PAYMENT_PROVIDER = "nowpayments";
  process.env.NOWPAYMENTS_API_KEY = "test_api_key";
  process.env.NOWPAYMENTS_IPN_SECRET = "test_ipn_secret";
  process.env.PUBLIC_BASE_URL = "https://example.com";
}

function signIpnBody(secret: string, json: Record<string, unknown>): string {
  const sorted = sortJsonForNowPaymentsSignature(json);
  return createHmac("sha512", secret).update(JSON.stringify(sorted)).digest("hex");
}

describe("NowPaymentsProvider", () => {
  beforeEach(() => {
    resetConfigCacheForTests();
    npEnv();
  });

  afterEach(() => {
    resetConfigCacheForTests();
    delete process.env.PAYMENT_PROVIDER;
    delete process.env.NOWPAYMENTS_API_KEY;
    delete process.env.NOWPAYMENTS_IPN_SECRET;
    delete process.env.PUBLIC_BASE_URL;
  });

  it("sortJsonForNowPaymentsSignature sorts nested object keys", () => {
    const input = { b: 2, a: 1, nested: { z: 9, y: 8 } };
    const sorted = sortJsonForNowPaymentsSignature(input) as Record<string, unknown>;
    expect(Object.keys(sorted)).toEqual(["a", "b", "nested"]);
    expect(Object.keys(sorted.nested as object)).toEqual(["y", "z"]);
  });

  it("verifyWebhook accepts a valid x-nowpayments-sig", () => {
    const p = new NowPaymentsProvider();
    const body = {
      payment_id: 123,
      payment_status: "finished",
      order_id: "nowpayments:deal-uuid:1",
      actually_paid: 10,
      pay_amount: 10,
    };
    const raw = JSON.stringify(body);
    const sig = signIpnBody("test_ipn_secret", body as Record<string, unknown>);
    expect(p.verifyWebhook(Buffer.from(raw, "utf8"), sig)).toBe(true);
  });

  it("verifyWebhook rejects bad signature", () => {
    const p = new NowPaymentsProvider();
    const raw = JSON.stringify({ order_id: "x", payment_status: "waiting" });
    expect(p.verifyWebhook(Buffer.from(raw, "utf8"), "deadbeef")).toBe(false);
  });

  it("parseWebhook maps finished + full pay to confirmed", () => {
    const p = new NowPaymentsProvider();
    const r = p.parseWebhook({
      order_id: "nowpayments:abc:0",
      payment_id: "999",
      payment_status: "finished",
      actually_paid: 1.5,
      pay_amount: 1.5,
    });
    expect(r.idempotencyKey).toBe("nowpayments:abc:0");
    expect(r.paymentExternalId).toBe("999");
    expect(r.result.status).toBe("confirmed");
    expect(r.result.receivedAmount).toBe("1.5");
  });

  it("parseWebhook maps partially_paid to underpaid", () => {
    const p = new NowPaymentsProvider();
    const r = p.parseWebhook({
      order_id: "nowpayments:abc:0",
      payment_id: 1,
      payment_status: "partially_paid",
      actually_paid: 0.5,
      pay_amount: 2,
    });
    expect(r.result.status).toBe("underpaid");
  });
});
