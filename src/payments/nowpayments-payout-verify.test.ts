import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCacheForTests } from "../config/index.js";
import { normalizeTotpSecret, resolvePayoutVerificationCode } from "./nowpayments-payout-verify.js";

describe("nowpayments-payout-verify", () => {
  beforeEach(() => {
    resetConfigCacheForTests();
    process.env.DATABASE_URL = "postgresql://ogmp:ogmp@127.0.0.1:5432/ogmp_mm?schema=public";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.MAIN_BOT_TOKEN = "123456:TEST";
  });

  afterEach(() => {
    resetConfigCacheForTests();
    delete process.env.NOWPAYMENTS_2FA_SECRET;
    delete process.env.NOWPAYMENTS_PAYOUT_VERIFY_CODE;
  });

  it("normalizeTotpSecret strips spaces", () => {
    expect(normalizeTotpSecret("abcd efgh")).toBe("ABCDEFGH");
  });

  it("resolvePayoutVerificationCode generates TOTP when 2FA secret is set", async () => {
    process.env.NOWPAYMENTS_2FA_SECRET = "KRSXG5CTMVRXXK4TIVRXXK4TIVRXXK4T";
    process.env.NOWPAYMENTS_PAYOUT_VERIFY_CODE = "999999";
    const code = await resolvePayoutVerificationCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it("resolvePayoutVerificationCode uses manual when no secret", async () => {
    process.env.NOWPAYMENTS_PAYOUT_VERIFY_CODE = "123456";
    expect(await resolvePayoutVerificationCode()).toBe("123456");
  });
});
