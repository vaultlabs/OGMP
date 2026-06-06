import { describe, expect, it } from "vitest";
import {
  formatNowpaymentsMinimumHint,
  isNowpaymentsAmountTooSmallError,
  type NowpaymentsMinAmountInfo,
} from "./nowpayments-min-amount.js";

describe("nowpayments-min-amount", () => {
  it("detects amountTo is too small errors", () => {
    expect(isNowpaymentsAmountTooSmallError("amountTo is too small")).toBe(true);
    expect(isNowpaymentsAmountTooSmallError("NOWPayments: amountTo is too small")).toBe(true);
    expect(isNowpaymentsAmountTooSmallError("Invalid IP")).toBe(false);
  });

  it("formats minimum hint in coin units, not dollars", () => {
    const usdtInfo: NowpaymentsMinAmountInfo = {
      payCurrency: "usdttrc20",
      priceCurrency: "usd",
      minPayAmount: 0,
      minUsd: 10,
    };
    expect(formatNowpaymentsMinimumHint(usdtInfo, "USDT", "TRC20")).toContain("10 USDT");
    expect(formatNowpaymentsMinimumHint(usdtInfo, "USDT", "TRC20")).not.toContain("$");

    const btcInfo: NowpaymentsMinAmountInfo = {
      payCurrency: "btc",
      priceCurrency: "btc",
      minPayAmount: 0.00015,
      minUsd: null,
    };
    expect(formatNowpaymentsMinimumHint(btcInfo, "BTC", "BTC")).toContain("BTC");
    expect(formatNowpaymentsMinimumHint(btcInfo, "BTC", "BTC")).not.toContain("USD");
  });
});
