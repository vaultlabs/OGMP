import { Prisma } from "@prisma/client";
import type { FeePayer } from "@prisma/client";
import { prisma } from "../db/prisma.js";

const Decimal = Prisma.Decimal;

export type FeeBreakdown = {
  dealAmount: Prisma.Decimal;
  escrowFee: Prisma.Decimal;
  networkFeeEstimate: Prisma.Decimal;
  totalBuyerPays: Prisma.Decimal;
  sellerReceives: Prisma.Decimal;
  feePayer: FeePayer;
};

export async function getActiveFeeSettings() {
  const row = await prisma.feeSetting.findFirst({ orderBy: { updatedAt: "desc" } });
  if (row) return row;
  return prisma.feeSetting.create({
    data: {
      percentage: new Decimal("0.01"),
      minimumUsd: new Decimal("1"),
      maximumUsd: null,
      fixedUsd: new Decimal("0"),
      defaultFeePayer: "split",
    },
  });
}

/**
 * Computes escrow fee and totals. Amount is the negotiated deal amount in USD terms for fee caps.
 * For crypto-denominated deals, `amountUsd` should be the USD notional used for min/max fee bounds.
 */
export function computeFeeBreakdown(params: {
  dealAmount: Prisma.Decimal;
  amountUsdForCaps: Prisma.Decimal;
  networkFeeEstimate: Prisma.Decimal;
  feePayer: FeePayer;
  percentage: Prisma.Decimal;
  minimumUsd: Prisma.Decimal;
  maximumUsd: Prisma.Decimal | null;
  fixedUsd: Prisma.Decimal;
}): FeeBreakdown {
  const { dealAmount, amountUsdForCaps, networkFeeEstimate, feePayer } = params;
  const pct = params.percentage.mul(amountUsdForCaps);
  let escrowFee = Decimal.max(pct, params.minimumUsd).add(params.fixedUsd);
  if (params.maximumUsd) {
    escrowFee = Decimal.min(escrowFee, params.maximumUsd);
  }
  // Fee is charged on top or deducted depending on payer — simplified model:
  // - buyer pays: total = deal + fee + network (seller gets deal)
  // - seller pays: total = deal + network (seller gets deal - fee)
  // - split: buyer pays deal + half fee + network, seller loses half fee from proceeds
  let totalBuyerPays = dealAmount.add(networkFeeEstimate);
  let sellerReceives = dealAmount;
  if (feePayer === "buyer") {
    totalBuyerPays = dealAmount.add(escrowFee).add(networkFeeEstimate);
    sellerReceives = dealAmount;
  } else if (feePayer === "seller") {
    totalBuyerPays = dealAmount.add(networkFeeEstimate);
    sellerReceives = dealAmount.sub(escrowFee);
  } else {
    const half = escrowFee.div(2);
    totalBuyerPays = dealAmount.add(half).add(networkFeeEstimate);
    sellerReceives = dealAmount.sub(half);
  }
  return {
    dealAmount,
    escrowFee,
    networkFeeEstimate,
    totalBuyerPays,
    sellerReceives,
    feePayer,
  };
}
