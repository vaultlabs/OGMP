import { describe, expect, it } from "vitest";
import { extractJoinTokenFromText } from "./join-invite.js";

describe("extractJoinTokenFromText", () => {
  it("parses t.me deep link", () => {
    expect(
      extractJoinTokenFromText("https://t.me/MyBot?start=join_abc123XYZ-_"),
    ).toBe("abc123XYZ-_");
  });

  it("parses raw token", () => {
    expect(extractJoinTokenFromText("YWJjMTIzZWZnaGlqa2xtbm9w")).toBe("YWJjMTIzZWZnaGlqa2xtbm9w");
  });

  it("ignores normal chat", () => {
    expect(extractJoinTokenFromText("hello there")).toBeNull();
  });
});
