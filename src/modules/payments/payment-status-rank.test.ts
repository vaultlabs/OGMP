import { describe, expect, it } from "vitest";
import {
  isPaymentConfirmedForEscrow,
  shouldAdvancePaymentStatus,
} from "./payment-status-rank.js";

describe("payment-status-rank", () => {
  it("does not downgrade confirmed to pending", () => {
    expect(shouldAdvancePaymentStatus("confirmed", "pending")).toBe(false);
    expect(shouldAdvancePaymentStatus("confirming", "detecting")).toBe(false);
    expect(shouldAdvancePaymentStatus("pending", "detecting")).toBe(true);
  });

  it("treats confirming with enough confirmations as escrow confirmed", () => {
    expect(
      isPaymentConfirmedForEscrow({
        status: "confirming",
        receivedAmount: "10",
        confirmations: 2,
        requiredConfirmations: 2,
      }),
    ).toBe(true);
  });
});
