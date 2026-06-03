import type { PaymentRecordStatus } from "@prisma/client";
import type { PaymentStatusResult } from "../../payments/payment-provider.types.js";

const RANK: Record<string, number> = {
  pending: 0,
  detecting: 1,
  confirming: 2,
  underpaid: 3,
  overpaid: 3,
  confirmed: 4,
  expired: 5,
  failed: 5,
};

export function paymentStatusRank(status: PaymentRecordStatus | PaymentStatusResult["status"]): number {
  return RANK[status] ?? 0;
}

/** Never downgrade payment row when API lags behind IPN webhook. */
export function shouldAdvancePaymentStatus(
  current: PaymentRecordStatus,
  incoming: PaymentStatusResult["status"],
): boolean {
  return paymentStatusRank(incoming) >= paymentStatusRank(current);
}

/** Treat as escrow-confirmed when provider says confirmed or enough on-chain confirmations. */
export function isPaymentConfirmedForEscrow(status: PaymentStatusResult): boolean {
  if (status.status === "confirmed") return true;
  if (
    status.status === "confirming" &&
    status.confirmations >= status.requiredConfirmations &&
    status.requiredConfirmations > 0
  ) {
    return true;
  }
  return false;
}
