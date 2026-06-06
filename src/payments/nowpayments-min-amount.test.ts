import { describe, expect, it } from "vitest";
import { isNowpaymentsAmountTooSmallError } from "./nowpayments-min-amount.js";

describe("nowpayments-min-amount", () => {
  it("detects amountTo is too small errors", () => {
    expect(isNowpaymentsAmountTooSmallError("amountTo is too small")).toBe(true);
    expect(isNowpaymentsAmountTooSmallError("NOWPayments: amountTo is too small")).toBe(true);
    expect(isNowpaymentsAmountTooSmallError("Invalid IP")).toBe(false);
  });
});
