import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCacheForTests } from "../config/index.js";
import { fetchNowpaymentsPayQuote } from "./nowpayments-quote.js";

function npEnv() {
  process.env.DATABASE_URL = "postgresql://ogmp:ogmp@127.0.0.1:5432/ogmp_mm?schema=public";
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.MAIN_BOT_TOKEN = "123456:TEST_TOKEN_PLACEHOLDER";
  process.env.MOCK_WEBHOOK_SECRET = "x".repeat(40);
  process.env.PAYMENT_PROVIDER = "nowpayments";
  process.env.NOWPAYMENTS_API_KEY = "test_api_key";
  process.env.NOWPAYMENTS_IPN_SECRET = "test_ipn_secret";
  process.env.PUBLIC_BASE_URL = "https://example.com";
  process.env.NOWPAYMENTS_SERVICE_FEE_PERCENT = "0.01";
}

describe("nowpayments-quote", () => {
  beforeEach(() => {
    resetConfigCacheForTests();
    npEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetConfigCacheForTests();
  });

  it("fetchNowpaymentsPayQuote applies service fee multiplier to estimate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ estimated_amount: 10 }),
      }),
    );

    const q = await fetchNowpaymentsPayQuote({
      currency: "USDT",
      network: "TRC20",
      invoiceAmount: "10.1",
    });

    expect(q.estimatedPayAmount).toBeCloseTo(10.1, 5);
    expect(q.payCurrency).toBe("usdttrc20");
  });
});
