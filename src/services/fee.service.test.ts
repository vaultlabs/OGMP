import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  computeFeeBreakdown,
  formatCryptoAmount,
  previewSellerPayoutAmount,
  resolveBuyerPayAmount,
  resolveDealPaymentAmounts,
} from "./fee.service.js";

const D = (n: string) => new Prisma.Decimal(n);

describe("fee.service", () => {
  it("buyer pays fee: $10 deal + 1% OGMP → buyer pays 10.1, seller gets 10", () => {
    const b = computeFeeBreakdown({
      dealAmount: D("10"),
      amountUsdForCaps: D("10"),
      networkFeeEstimate: D("0"),
      feePayer: "buyer",
      percentage: D("0.01"),
      minimumUsd: D("0"),
      maximumUsd: null,
      fixedUsd: D("0"),
    });
    expect(formatCryptoAmount(b.totalBuyerPays)).toBe("10.1");
    expect(formatCryptoAmount(b.sellerReceives)).toBe("10");
    expect(formatCryptoAmount(b.escrowFee)).toBe("0.1");
  });

  it("seller pays fee: buyer pays 10, seller receives 9.9", () => {
    const b = computeFeeBreakdown({
      dealAmount: D("10"),
      amountUsdForCaps: D("10"),
      networkFeeEstimate: D("0"),
      feePayer: "seller",
      percentage: D("0.01"),
      minimumUsd: D("0"),
      maximumUsd: null,
      fixedUsd: D("0"),
    });
    expect(formatCryptoAmount(b.totalBuyerPays)).toBe("10");
    expect(formatCryptoAmount(b.sellerReceives)).toBe("9.9");
  });

  it("split fee: buyer pays 10.05, seller receives 9.95", () => {
    const b = computeFeeBreakdown({
      dealAmount: D("10"),
      amountUsdForCaps: D("10"),
      networkFeeEstimate: D("0"),
      feePayer: "split",
      percentage: D("0.01"),
      minimumUsd: D("0"),
      maximumUsd: null,
      fixedUsd: D("0"),
    });
    expect(formatCryptoAmount(b.totalBuyerPays)).toBe("10.05");
    expect(formatCryptoAmount(b.sellerReceives)).toBe("9.95");
  });

  it("resolveDealPaymentAmounts adds NOWPayments processor fee on top", () => {
    const stored = resolveDealPaymentAmounts({
      amount: D("10"),
      feeAmount: D("0.1"),
      feePayer: "buyer",
      networkFeeEstimate: D("0.05"),
    });
    expect(formatCryptoAmount(stored.buyerPays)).toBe("10.15");
    expect(formatCryptoAmount(stored.sellerReceives)).toBe("10");
  });

  it("resolveBuyerPayAmount prefers payment.expectedAmount when address exists", () => {
    const deal = {
      amount: D("0.2388"),
      feeAmount: D("0.002388"),
      feePayer: "buyer" as const,
      networkFeeEstimate: D("0.0001"),
    };
    expect(
      formatCryptoAmount(resolveBuyerPayAmount(deal, { expectedAmount: D("0.239") })),
    ).toBe("0.239");
  });

  it("previewSellerPayoutAmount caps to received when lower than quote", () => {
    const deal = {
      amount: D("0.2388"),
      feeAmount: D("0.002388"),
      feePayer: "buyer" as const,
      networkFeeEstimate: D("0"),
    };
    const preview = previewSellerPayoutAmount(deal, { receivedAmount: D("0.238491") });
    expect(preview.capped).toBe(true);
    expect(formatCryptoAmount(preview.payout)).toBe("0.238491");
  });
});
