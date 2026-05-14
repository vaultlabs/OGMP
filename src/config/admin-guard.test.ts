import { beforeEach, describe, expect, it } from "vitest";
import { isAdminTelegramId, resetConfigCacheForTests } from "./index.js";

describe("isAdminTelegramId", () => {
  beforeEach(() => {
    resetConfigCacheForTests();
    process.env.DATABASE_URL = "postgresql://ogmp:ogmp@127.0.0.1:5432/ogmp_mm?schema=public";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.MAIN_BOT_TOKEN = "123456:TEST_TOKEN_PLACEHOLDER";
    process.env.MOCK_WEBHOOK_SECRET = "x".repeat(40);
    process.env.ADMIN_IDS = "1001, 1002";
    process.env.ADMIN_TELEGRAM_IDS = "";
  });

  it("returns true only for listed admins", () => {
    expect(isAdminTelegramId(1001n)).toBe(true);
    expect(isAdminTelegramId(1002n)).toBe(true);
    expect(isAdminTelegramId(999n)).toBe(false);
  });
});
