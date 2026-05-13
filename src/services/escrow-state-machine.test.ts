import { describe, expect, it } from "vitest";
import { assertValidDealTransition, isValidDealTransition } from "./escrow-state-machine.js";
import type { DealStatus } from "@prisma/client";

describe("escrow state machine", () => {
  it("allows happy path chain", () => {
    const chain: DealStatus[] = [
      "pending_acceptance",
      "waiting_payment",
      "payment_detected",
      "funded",
      "item_delivered",
      "buyer_confirmed",
      "release_requested",
      "released",
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      const from = chain[i]!;
      const to = chain[i + 1]!;
      expect(isValidDealTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it("allows buyer_confirmed -> released when auto-release (direct)", () => {
    expect(isValidDealTransition("buyer_confirmed", "released")).toBe(true);
  });

  it("allows dispute from active states", () => {
    expect(isValidDealTransition("funded", "disputed")).toBe(true);
    expect(isValidDealTransition("waiting_payment", "disputed")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(isValidDealTransition("released", "funded")).toBe(false);
    expect(isValidDealTransition("pending_acceptance", "funded")).toBe(false);
  });

  it("assertValidDealTransition throws on invalid", () => {
    expect(() => assertValidDealTransition("released", "funded")).toThrow();
  });
});
