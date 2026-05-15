import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors.js";
import {
  paymentAddressSetupFailedBuyerMessage,
  paymentAddressSetupFailedSellerMessage,
  replyTextForCaughtError,
} from "./user-facing-errors.js";

describe("user-facing-errors", () => {
  it("passes through AppError messages", () => {
    expect(replyTextForCaughtError(new ValidationError("File type not allowed."))).toBe("File type not allowed.");
  });

  it("hides unknown errors", () => {
    expect(replyTextForCaughtError(new Error("secret internal DATABASE_URL=..."))).not.toContain("DATABASE_URL");
  });

  it("payment setup failed messages are short and include deal code", () => {
    const code = "OGMP-ABC12";
    expect(paymentAddressSetupFailedBuyerMessage(code)).toContain(code);
    expect(paymentAddressSetupFailedBuyerMessage(code)).toContain("/support");
    expect(paymentAddressSetupFailedSellerMessage(code)).toContain(code);
    expect(paymentAddressSetupFailedBuyerMessage(code).split("\n").length).toBeLessThan(6);
  });
});
