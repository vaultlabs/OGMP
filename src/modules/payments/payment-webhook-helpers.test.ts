import { describe, expect, it } from "vitest";
import { isPrismaUniqueConstraintError } from "./payment.service.js";

describe("isPrismaUniqueConstraintError", () => {
  it("detects Prisma P2002", () => {
    expect(isPrismaUniqueConstraintError({ code: "P2002" })).toBe(true);
    expect(isPrismaUniqueConstraintError({ code: "P2003" })).toBe(false);
    expect(isPrismaUniqueConstraintError(null)).toBe(false);
    expect(isPrismaUniqueConstraintError("x")).toBe(false);
  });
});
