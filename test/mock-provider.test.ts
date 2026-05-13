import { describe, expect, it } from "vitest";
import { MockPaymentProvider } from "../src/payments/mock-payment.provider.js";

describe("MockPaymentProvider", () => {
  it("parses webhook payloads", () => {
    const p = new MockPaymentProvider();
    const r = p.parseWebhook({
      idempotencyKey: "k1",
      receivedAmount: "10",
      confirmations: 2,
      requiredConfirmations: 2,
    });
    expect(r.idempotencyKey).toBe("k1");
    expect(r.result.status).toBe("confirmed");
  });
});
