import type { Deal, DealStatus, PaymentRecordStatus } from "@prisma/client";

/** Simple labels for deal card and notifications (internal Prisma statuses stay strict). */
export function userFacingDealStatus(
  deal: Pick<Deal, "status" | "frozen">,
  opts?: { hasLockedDelivery: boolean; paymentStatus?: PaymentRecordStatus | null },
): string {
  if (deal.frozen) return "Under Review";
  const ps = opts?.paymentStatus;
  const locked = opts?.hasLockedDelivery ?? false;

  switch (deal.status) {
    case "pending_acceptance":
      return "Accept Terms";
    case "waiting_payment":
      if (locked) return "Delivery Locked";
      return "Waiting for Buyer Payment";
    case "payment_detected":
      if (locked) return "Delivery Locked";
      if (ps === "confirming" || ps === "detecting") return "Waiting for Buyer Payment";
      return "Waiting for Buyer Payment";
    case "funded":
      return "Payment Confirmed";
    case "item_delivered":
      return "Buyer Reviewing";
    case "buyer_confirmed":
      return "Release Requested";
    case "release_requested":
      return "Release Requested";
    case "released":
      return "Released";
    case "disputed":
      return "Under Review";
    case "cancelled":
      return "Cancelled";
    case "refunded":
      return "Refunded";
    default:
      return deal.status;
  }
}

export function userFacingDeliveryState(status: DealStatus, hasLockedDelivery: boolean): string {
  if (status === "waiting_payment" || status === "payment_detected") {
    return hasLockedDelivery ? "Delivery Locked" : "Waiting for Seller Delivery";
  }
  if (status === "funded") return "Delivery Unlocked";
  if (status === "item_delivered") return "Buyer Reviewing";
  return "—";
}
