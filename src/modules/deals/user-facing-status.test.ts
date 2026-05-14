import { describe, expect, it } from "vitest";
import { userFacingDealStatus, userFacingDeliveryState } from "./user-facing-status.js";

describe("userFacingDealStatus", () => {
  it("uses premium labels for common paths", () => {
    expect(
      userFacingDealStatus({ status: "waiting_payment", frozen: false }, { hasLockedDelivery: true }),
    ).toContain("Deal Protection");
    expect(userFacingDealStatus({ status: "waiting_payment", frozen: true })).toBe("Case Review");
    expect(userFacingDealStatus({ status: "funded", frozen: false })).toContain("Delivery Vault");
    expect(userFacingDealStatus({ status: "item_delivered", frozen: false })).toBe("Buyer Review");
    expect(userFacingDealStatus({ status: "release_requested", frozen: false })).toBe("Release Request");
    expect(userFacingDealStatus({ status: "disputed", frozen: false })).toBe("Case Review");
  });
});

describe("userFacingDeliveryState", () => {
  it("names Delivery Vault states", () => {
    expect(userFacingDeliveryState("waiting_payment", true)).toContain("Delivery Vault");
    expect(userFacingDeliveryState("funded", false)).toContain("Delivery Vault");
    expect(userFacingDeliveryState("item_delivered", true)).toBe("Buyer Review");
  });
});
