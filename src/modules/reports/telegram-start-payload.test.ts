import { describe, expect, it } from "vitest";
import { extractTelegramStartPayload } from "./telegram-start-payload.js";

describe("extractTelegramStartPayload", () => {
  it("returns undefined for bare /start", () => {
    expect(extractTelegramStartPayload("/start")).toBeUndefined();
    expect(extractTelegramStartPayload("/start@MyBot")).toBeUndefined();
  });

  it("returns payload after /start", () => {
    expect(extractTelegramStartPayload("/start report_abc")).toBe("report_abc");
  });

  it("returns payload after /start@Bot", () => {
    expect(extractTelegramStartPayload("/start@Ogmpreport_bot report_token123")).toBe("report_token123");
  });
});
