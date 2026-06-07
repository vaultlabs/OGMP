import { Prisma } from "@prisma/client";
import type { FeePayer } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { loadConfig } from "../config/index.js";
import { fetchNowpaymentsPayQuote } from "../payments/nowpayments-quote.js";
import { computeEscrowPayoutAmount } from "../payments/payout-amount.js";

const Decimal = Prisma.Decimal;

export type FeeBreakdown = {
  dealAmount: Prisma.Decimal;
  escrowFee: Prisma.Decimal;
  networkFeeEstimate: Prisma.Decimal;
  totalBuyerPays: Prisma.Decimal;
  sellerReceives: Prisma.Decimal;
  feePayer: FeePayer;
};

/** Resolved from a stored deal row (uses locked-in feeAmount from creation). */
export type DealPaymentAmounts = {
  dealAmount: Prisma.Decimal;
  escrowFee: Prisma.Decimal;
  networkFeeEstimate: Prisma.Decimal;
  buyerPays: Prisma.Decimal;
  sellerReceives: Prisma.Decimal;
  feePayer: FeePayer;
};

/** Trim trailing zeros for Telegram display (e.g. 10.50000000 → 10.5). */
export function formatCryptoAmount(value: Prisma.Decimal): string {
  const s = value.toFixed(8);
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

export function feePayerLabel(feePayer: FeePayer): string {
  switch (feePayer) {
    case "buyer":
      return "buyer";
    case "seller":
      return "seller";
    case "split":
      return "split (50/50)";
  }
}

/** Buyer invoice + seller net from deal fields (same rules as computeFeeBreakdown). */
export function resolveDealPaymentAmounts(deal: {
  amount: Prisma.Decimal;
  feeAmount: Prisma.Decimal;
  feePayer: FeePayer;
  networkFeeEstimate: Prisma.Decimal;
}): DealPaymentAmounts {
  const dealAmount = deal.amount;
  const escrowFee = deal.feeAmount;
  const networkFeeEstimate = deal.networkFeeEstimate;
  const { feePayer } = deal;

  let buyerPays = dealAmount.add(networkFeeEstimate);
  let sellerReceives = dealAmount;

  if (feePayer === "buyer") {
    buyerPays = dealAmount.add(escrowFee).add(networkFeeEstimate);
    sellerReceives = dealAmount;
  } else if (feePayer === "seller") {
    buyerPays = dealAmount.add(networkFeeEstimate);
    sellerReceives = dealAmount.sub(escrowFee);
  } else {
    const half = escrowFee.div(2);
    buyerPays = dealAmount.add(half).add(networkFeeEstimate);
    sellerReceives = dealAmount.sub(half);
  }

  return {
    dealAmount,
    escrowFee,
    networkFeeEstimate,
    buyerPays,
    sellerReceives,
    feePayer,
  };
}

/** Buyer send amount — `payment.expectedAmount` (NOWPayments pay_amount) when escrow address exists. */
export function resolveBuyerPayAmount(
  deal: {
    amount: Prisma.Decimal;
    feeAmount: Prisma.Decimal;
    feePayer: FeePayer;
    networkFeeEstimate: Prisma.Decimal;
  },
  payment?: { expectedAmount: Prisma.Decimal } | null,
): Prisma.Decimal {
  if (payment?.expectedAmount?.gt(0)) {
    return payment.expectedAmount;
  }
  return resolveDealPaymentAmounts(deal).buyerPays;
}

/** Seller payout preview — caps to on-chain received when lower than quoted sellerReceives. */
export function previewSellerPayoutAmount(
  deal: {
    amount: Prisma.Decimal;
    feeAmount: Prisma.Decimal;
    feePayer: FeePayer;
    networkFeeEstimate: Prisma.Decimal;
  },
  payment?: { receivedAmount?: Prisma.Decimal | null } | null,
): { quoted: Prisma.Decimal; payout: Prisma.Decimal; capped: boolean } {
  const amounts = resolveDealPaymentAmounts(deal);
  const payout = computeEscrowPayoutAmount({
    sellerReceives: amounts.sellerReceives,
    receivedAmount: payment?.receivedAmount ?? null,
    custodyAvailable: null,
  });
  return { quoted: amounts.sellerReceives, payout, capped: payout.lt(amounts.sellerReceives) };
}

/** Plain-language fee lines for deal card, payment DM, and wizard confirm. */
export function formatFeeBreakdownLines(params: {
  currency: string;
  network: string;
  amounts: DealPaymentAmounts;
  /** When true, buyer total is final (from NOWPayments pay_amount). */
  paymentAddressReady?: boolean;
  authoritativeBuyerPay?: Prisma.Decimal | null;
  sellerPayoutPreview?: Prisma.Decimal | null;
}): string[] {
  const { currency, network, amounts: a } = params;
  const cur = currency;
  const buyerPay =
    params.paymentAddressReady && params.authoritativeBuyerPay?.gt(0)
      ? params.authoritativeBuyerPay
      : a.buyerPays;
  const sellerLine =
    params.sellerPayoutPreview && params.sellerPayoutPreview.lt(a.sellerReceives)
      ? `Seller receives on release: ${formatCryptoAmount(params.sellerPayoutPreview)} ${cur} (net after processor)`
      : `Seller receives on release: ${formatCryptoAmount(a.sellerReceives)} ${cur}`;
  const lines = [
    `Deal price: ${formatCryptoAmount(a.dealAmount)} ${cur} (in ${cur}, not dollars)`,
    `OGMP fee (1%): ${formatCryptoAmount(a.escrowFee)} ${cur} (${feePayerLabel(a.feePayer)})`,
  ];
  if (a.networkFeeEstimate.gt(0)) {
    lines.push(
      params.paymentAddressReady
        ? `NOWPayments fee: ${formatCryptoAmount(a.networkFeeEstimate)} ${cur}`
        : `NOWPayments fee (est.): ${formatCryptoAmount(a.networkFeeEstimate)} ${cur}`,
    );
  } else {
    lines.push("NOWPayments fee: added when payment opens (from live quote)");
  }
  lines.push(
    `Network: ${network}`,
    "",
    params.paymentAddressReady
      ? `Pay exactly: ${formatCryptoAmount(buyerPay)} ${cur}`
      : `Estimated total: ${formatCryptoAmount(buyerPay)} ${cur} (final amount locks when payment opens)`,
    sellerLine,
  );
  if (a.feePayer === "buyer") {
    lines.push("", "Fee is added on top — seller gets the full deal amount after release.");
  } else if (a.feePayer === "seller") {
    lines.push("", "Buyer sends the deal amount only — fee is deducted from the seller payout.");
  } else {
    lines.push("", "Fee is split: buyer pays half extra; seller loses half from payout.");
  }
  return lines;
}

export async function getActiveFeeSettings() {
  const cfg = loadConfig();
  const row = await prisma.feeSetting.findFirst({ orderBy: { updatedAt: "desc" } });
  const percentage = cfg.PLATFORM_FEE_PERCENT?.trim()
    ? new Decimal(cfg.PLATFORM_FEE_PERCENT.trim())
    : (row?.percentage ?? new Decimal("0.01"));
  const minimumUsd = cfg.MIN_FEE?.trim()
    ? new Decimal(cfg.MIN_FEE.trim())
    : (row?.minimumUsd ?? new Decimal("0"));
  const maximumUsd =
    cfg.MAX_FEE?.trim() && cfg.MAX_FEE.trim() !== ""
      ? new Decimal(cfg.MAX_FEE.trim())
      : (row?.maximumUsd ?? null);
  const fixedUsd = row?.fixedUsd ?? new Decimal("0");
  const defaultFeePayer = row?.defaultFeePayer ?? "split";

  if (row) {
    return {
      ...row,
      percentage,
      minimumUsd,
      maximumUsd,
      fixedUsd,
      defaultFeePayer,
    };
  }
  return prisma.feeSetting.create({
    data: {
      percentage,
      minimumUsd,
      maximumUsd,
      fixedUsd,
      defaultFeePayer,
    },
  });
}

/** Invoice amount for NOWPayments before processor fees (deal + OGMP slice on invoice). */
export function computeProcessorInvoiceAmount(deal: {
  amount: Prisma.Decimal;
  feeAmount: Prisma.Decimal;
  feePayer: FeePayer;
}): Prisma.Decimal {
  const { amount: dealAmount, feeAmount, feePayer } = deal;
  if (feePayer === "buyer") return dealAmount.add(feeAmount);
  if (feePayer === "seller") return dealAmount;
  return dealAmount.add(feeAmount.div(2));
}

/** Buyer/seller totals without NOWPayments processor fee (networkFeeEstimate = 0). */
export function resolveDealPaymentAmountsPreProcessor(deal: {
  amount: Prisma.Decimal;
  feeAmount: Prisma.Decimal;
  feePayer: FeePayer;
}): DealPaymentAmounts {
  return resolveDealPaymentAmounts({
    ...deal,
    networkFeeEstimate: new Decimal(0),
  });
}

/** Quote OGMP + NOWPayments fees for wizard / deal card (live NP estimate when configured). */
export async function quoteDealPaymentTotals(params: {
  amount: string;
  currency: string;
  network: string;
  feePayer: FeePayer;
}): Promise<DealPaymentAmounts> {
  const feeRow = await getActiveFeeSettings();
  const dealAmount = new Decimal(params.amount);
  const breakdown = computeFeeBreakdown({
    dealAmount,
    amountUsdForCaps: dealAmount,
    networkFeeEstimate: new Decimal(0),
    feePayer: params.feePayer,
    percentage: feeRow.percentage,
    minimumUsd: feeRow.minimumUsd,
    maximumUsd: feeRow.maximumUsd,
    fixedUsd: feeRow.fixedUsd,
  });

  const prelim = resolveDealPaymentAmountsPreProcessor({
    amount: dealAmount,
    feeAmount: breakdown.escrowFee,
    feePayer: params.feePayer,
  });

  if (loadConfig().PAYMENT_PROVIDER !== "nowpayments") {
    return prelim;
  }

  try {
    const invoice = computeProcessorInvoiceAmount({
      amount: dealAmount,
      feeAmount: breakdown.escrowFee,
      feePayer: params.feePayer,
    });
    const q = await fetchNowpaymentsPayQuote({
      currency: params.currency,
      network: params.network,
      invoiceAmount: invoice.toString(),
    });
    const buyerPays = new Decimal(q.estimatedPayAmount);
    const processorFee = Decimal.max(0, buyerPays.sub(prelim.buyerPays));
    return resolveDealPaymentAmounts({
      amount: dealAmount,
      feeAmount: breakdown.escrowFee,
      feePayer: params.feePayer,
      networkFeeEstimate: processorFee,
    });
  } catch {
    return prelim;
  }
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
  let escrowFee = params.percentage.mul(amountUsdForCaps).add(params.fixedUsd);
  if (params.minimumUsd.gt(0)) {
    escrowFee = Decimal.max(escrowFee, params.minimumUsd);
  }
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
