import { describe, expect, it } from "vitest";
import { hashReportToken } from "./report-session.service.js";

describe("hashReportToken", () => {
  it("is stable and sensitive to input", () => {
    const a = hashReportToken("token-a");
    expect(hashReportToken("token-a")).toBe(a);
    expect(hashReportToken("token-b")).not.toBe(a);
    expect(a.length).toBe(64);
  });
});
