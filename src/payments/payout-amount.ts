import { Prisma } from "@prisma/client";

/** Round down to 6 decimals (NOWPayments payout limit). */
export function formatPayoutAmount(amount: Prisma.Decimal): string {
  return amount.toDecimalPlaces(6, Prisma.Decimal.ROUND_DOWN).toFixed();
}
