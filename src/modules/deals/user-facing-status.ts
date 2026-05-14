import type { Deal, DealStatus, PaymentRecordStatus } from "@prisma/client";

/**
 * Short premium labels for cards and DMs.
 * Each maps to a moment in the flow: Deal Protection, Delivery Vault, Buyer Review, Release Request, Case Review.
 */
export function userFacingDealStatus(
  deal: Pick<Deal, "status" | "frozen">,
  opts?: { hasLockedDelivery: boolean; paymentStatus?: PaymentRecordStatus | null },
): string {
  if (deal.frozen) return "Case Review";
  const ps = opts?.paymentStatus;
  const locked = opts?.hasLockedDelivery ?? false;

  switch (deal.status) {
    case "pending_acceptance":
      return "Accept terms";
    case "waiting_payment":
      if (locked) return "Deal Protection — Delivery Vault locked";
      return "Seller — add to Delivery Vault";
    case "payment_detected":
      if (locked) {
        if (ps === "confirming" || ps === "detecting") return "Deal Protection — payment confirming";
        return "Deal Protection — Delivery Vault locked";
      }
      return "Seller — add to Delivery Vault";
    case "funded":
      return "Delivery Vault unlocked";
    case "item_delivered":
      return "Buyer Review";
    case "buyer_confirmed":
    case "release_requested":
      return "Release Request";
    case "released":
      return "Completed";
    case "disputed":
      return "Case Review";
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
    return hasLockedDelivery ? "Delivery Vault (locked)" : "Delivery Vault (awaiting upload)";
  }
  if (status === "funded") return "Delivery Vault (unlocked)";
  if (status === "item_delivered") return "Buyer Review";
  return "—";
}
