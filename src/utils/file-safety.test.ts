import { beforeEach, describe, expect, it } from "vitest";
import { resetConfigCacheForTests } from "../config/index.js";
import { assertFileAllowed } from "./file-safety.js";
import { ValidationError } from "./errors.js";

function setMinimalEnv(): void {
  process.env.DATABASE_URL = "postgresql://ogmp:ogmp@127.0.0.1:5432/ogmp_mm?schema=public";
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.MAIN_BOT_TOKEN = "123456:TEST_TOKEN_PLACEHOLDER";
  process.env.MOCK_WEBHOOK_SECRET = "x".repeat(40);
  process.env.ADMIN_IDS = "1";
  process.env.BLOCKED_FILE_EXTENSIONS = ".exe,.bat,.cmd,.scr,.js,.vbs,.ps1,.jar";
}

describe("assertFileAllowed", () => {
  beforeEach(() => {
    resetConfigCacheForTests();
    setMinimalEnv();
  });

  it("allows .txt with text/plain", () => {
    expect(() =>
      assertFileAllowed({ fileName: "readme.txt", mimeType: "text/plain", fileSize: 100 }),
    ).not.toThrow();
  });

  it("allows .txt with application/octet-stream", () => {
    expect(() =>
      assertFileAllowed({ fileName: "note.txt", mimeType: "application/octet-stream", fileSize: 50 }),
    ).not.toThrow();
  });

  it("allows .zip with application/octet-stream", () => {
    expect(() =>
      assertFileAllowed({ fileName: "bundle.zip", mimeType: "application/octet-stream", fileSize: 1024 }),
    ).not.toThrow();
  });

  it("rejects octet-stream without safe extension", () => {
    expect(() =>
      assertFileAllowed({ fileName: "unknown", mimeType: "application/octet-stream", fileSize: 10 }),
    ).toThrow(ValidationError);
  });

  it("rejects dangerous extension", () => {
    expect(() => assertFileAllowed({ fileName: "run.exe", mimeType: "application/octet-stream", fileSize: 10 })).toThrow(
      ValidationError,
    );
  });

  it("allows .rar with application/vnd.rar", () => {
    expect(() =>
      assertFileAllowed({ fileName: "a.rar", mimeType: "application/vnd.rar", fileSize: 100 }),
    ).not.toThrow();
  });

  it("allows .rar with application/x-rar-compressed", () => {
    expect(() =>
      assertFileAllowed({ fileName: "a.rar", mimeType: "application/x-rar-compressed", fileSize: 100 }),
    ).not.toThrow();
  });

  it("allows .zip with application/zip", () => {
    expect(() => assertFileAllowed({ fileName: "x.zip", mimeType: "application/zip", fileSize: 100 })).not.toThrow();
  });

  it("rejects oversize file", () => {
    resetConfigCacheForTests();
    setMinimalEnv();
    process.env.MAX_UPLOAD_SIZE_MB = "1";
    resetConfigCacheForTests();
    expect(() =>
      assertFileAllowed({ fileName: "big.zip", mimeType: "application/zip", fileSize: 10 * 1024 * 1024 }),
    ).toThrow(ValidationError);
  });
});
