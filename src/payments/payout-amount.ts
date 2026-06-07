import { Prisma } from "@prisma/client";

/** Round down to 6 decimals (NOWPayments payout limit). */
export function formatPayoutAmount(amount: Prisma.Decimal): string {
  return amount.toDecimalPlaces(6, Prisma.Decimal.ROUND_DOWN).toFixed();
}

/**
 * Cap seller payout to what actually landed in custody / was received.
 * NOWPayments may credit slightly less than pay_amount (processor fees) even when the buyer sent exactly what we showed.
 */
export function computeEscrowPayoutAmount(params: {
  sellerReceives: Prisma.Decimal;
  receivedAmount?: Prisma.Decimal | null;
  custodyAvailable?: number | null;
}): Prisma.Decimal {
  let amount = params.sellerReceives;
  if (params.receivedAmount?.gt(0)) {
    amount = Prisma.Decimal.min(amount, params.receivedAmount);
  }
  if (params.custodyAvailable != null && params.custodyAvailable > 0) {
    amount = Prisma.Decimal.min(amount, new Prisma.Decimal(params.custodyAvailable));
  }
  return amount.toDecimalPlaces(6, Prisma.Decimal.ROUND_DOWN);
}
