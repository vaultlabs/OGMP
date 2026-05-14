import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors.js";
import { paymentAddressSetupFailedUserMessage, replyTextForCaughtError } from "./user-facing-errors.js";

describe("user-facing-errors", () => {
  it("passes through AppError messages", () => {
    expect(replyTextForCaughtError(new ValidationError("File type not allowed."))).toBe("File type not allowed.");
  });

  it("hides unknown errors", () => {
    expect(replyTextForCaughtError(new Error("secret internal DATABASE_URL=..."))).not.toContain("DATABASE_URL");
  });

  it("paymentAddressSetupFailedUserMessage includes deal code only", () => {
    const t = paymentAddressSetupFailedUserMessage("OGMP-ABC12");
    expect(t).toContain("OGMP-ABC12");
    expect(t).toContain("/support");
  });
});
