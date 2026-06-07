import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { computeEscrowPayoutAmount } from "./payout-amount.js";
import { pickConversionId } from "./nowpayments-custody-convert.js";

const D = (n: string) => new Prisma.Decimal(n);

describe("payout-amount", () => {
  it("caps seller payout to received custody when buyer paid exactly but NP credited less", () => {
    const capped = computeEscrowPayoutAmount({
      sellerReceives: D("0.2388"),
      receivedAmount: D("0.238491"),
      custodyAvailable: 0.238491,
    });
    expect(capped.toFixed()).toBe("0.238491");
  });

  it("does not cap when received covers quoted seller amount", () => {
    const amount = computeEscrowPayoutAmount({
      sellerReceives: D("10"),
      receivedAmount: D("10.15"),
      custodyAvailable: 10.15,
    });
    expect(amount.toFixed()).toBe("10");
  });
});

describe("pickConversionId", () => {
  it("reads id from nested result object", () => {
    expect(
      pickConversionId({
        result: { id: "260512021", status: "WAITING" },
      }),
    ).toBe("260512021");
  });
});
