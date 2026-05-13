import type { DealStatus } from "@prisma/client";

/** Valid deal status transitions for OGMP MM escrow state machine */
export const DEAL_TRANSITIONS: Readonly<Record<DealStatus, readonly DealStatus[]>> = {
  pending_acceptance: ["waiting_payment", "cancelled", "disputed"],
  waiting_payment: ["payment_detected", "cancelled", "disputed"],
  payment_detected: ["funded", "waiting_payment", "disputed", "cancelled"],
  funded: ["item_delivered", "disputed"],
  item_delivered: ["buyer_confirmed", "disputed"],
  buyer_confirmed: ["release_requested", "released", "disputed"],
  release_requested: ["released", "refunded", "disputed", "cancelled"],
  released: [],
  disputed: ["released", "refunded", "cancelled", "funded", "item_delivered"],
  cancelled: [],
  refunded: [],
} as const;

export function isValidDealTransition(from: DealStatus, to: DealStatus): boolean {
  const next = DEAL_TRANSITIONS[from];
  return (next as readonly DealStatus[]).includes(to);
}

export function assertValidDealTransition(from: DealStatus, to: DealStatus): void {
  if (!isValidDealTransition(from, to)) {
    throw new Error(`Invalid deal transition: ${from} -> ${to}`);
  }
}
