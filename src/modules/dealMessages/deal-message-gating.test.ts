import { describe, expect, it } from "vitest";
import { buyerMayReceiveDealRoomFiles } from "./dealMessage.service.js";

describe("buyerMayReceiveDealRoomFiles", () => {
  it("is false until fundedAt is set", () => {
    expect(buyerMayReceiveDealRoomFiles({ fundedAt: null })).toBe(false);
  });

  it("is true once fundedAt is set", () => {
    expect(buyerMayReceiveDealRoomFiles({ fundedAt: new Date() })).toBe(true);
  });
});
