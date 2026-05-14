import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    /** Primary escrow bot token (preferred) */
    MAIN_BOT_TOKEN: z.string().optional(),
    /** @deprecated alias — use MAIN_BOT_TOKEN */
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    OGMP_MM_REPORT_BOT_TOKEN: z.string().optional(),
    /** Comma-separated Telegram user IDs (numeric) */
    ADMIN_IDS: z.string().default(""),
    ADMIN_TELEGRAM_IDS: z.string().default(""),
    WEBHOOK_SECRET: z.string().optional(),
    BOT_PUBLIC_USERNAME: z.string().optional(),
    REPORT_BOT_USERNAME: z.string().optional(),
    SERVER_PORT: z.coerce.number().default(8080),
    PAYMENT_PROVIDER: z.enum(["mock", "nowpayments"]).default("mock"),
    NOWPAYMENTS_API_KEY: z.string().optional(),
    NOWPAYMENTS_IPN_SECRET: z.string().optional(),
    PUBLIC_BASE_URL: z.string().url().optional(),
    AUTO_RELEASE_ENABLED: z.coerce.boolean().default(false),
    /** After escrow payment confirms, DM buyer each delivery file_id from the deal (if false, only a Download button). */
    AUTO_SEND_DELIVERY_AFTER_PAYMENT: z.coerce.boolean().default(true),
    MOCK_WEBHOOK_SECRET: z.string().optional(),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().default(10_000),
    RATE_LIMIT_MAX: z.coerce.number().default(30),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    APP_SECRET_KEY: z.string().optional(),
    REPORT_SESSION_EXPIRY_MINUTES: z.coerce.number().default(60),
    MAX_UPLOAD_SIZE_MB: z.coerce.number().default(50),
    BLOCKED_FILE_EXTENSIONS: z
      .string()
      .default(".exe,.bat,.cmd,.scr,.js,.vbs,.ps1,.jar"),
    SUPPORT_USERNAME: z.string().optional(),
    PLATFORM_FEE_PERCENT: z.string().optional(),
    MIN_FEE: z.string().optional(),
    MAX_FEE: z.string().optional(),
    /** Run BullMQ notification worker in-process */
    NOTIFICATION_WORKER_ENABLED: z.coerce.boolean().default(true),
    /** Require joining OGMP gateway before using the escrow bot (overridable via BotSetting). */
    REQUIRE_GATEWAY_JOIN: z.coerce.boolean().default(true),
    GATEWAY_JOIN_URL: z.string().url().default("https://t.me/OGMP_GatewayBot"),
    GATEWAY_USERNAME: z.string().default("@OGMP_GatewayBot"),
    /** Optional: numeric channel/supergroup id for getChatMember (e.g. -100…). Empty = honor-system on Continue. */
    GATEWAY_CHAT_ID: z.string().optional().default(""),
  })
  .superRefine((data, ctx) => {
    if (!data.MAIN_BOT_TOKEN && !data.TELEGRAM_BOT_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Set MAIN_BOT_TOKEN or TELEGRAM_BOT_TOKEN",
        path: ["MAIN_BOT_TOKEN"],
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

function parseAdminIds(raw: string): bigint[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return BigInt(s);
      } catch {
        return null;
      }
    })
    .filter((x): x is bigint => x !== null);
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment: ${JSON.stringify(msg)}`);
  }
  cached = parsed.data;
  return parsed.data;
}

export function getMainBotToken(): string {
  const c = loadConfig();
  return c.MAIN_BOT_TOKEN ?? c.TELEGRAM_BOT_TOKEN ?? "";
}

export function getReportBotToken(): string | undefined {
  const t = loadConfig().OGMP_MM_REPORT_BOT_TOKEN;
  return t && t.length > 0 ? t : undefined;
}

export function getAdminTelegramIds(): Set<string> {
  const cfg = loadConfig();
  const merged = [cfg.ADMIN_IDS, cfg.ADMIN_TELEGRAM_IDS].filter(Boolean).join(",");
  return new Set(parseAdminIds(merged).map((b) => b.toString()));
}

export function isAdminTelegramId(telegramId: bigint): boolean {
  return getAdminTelegramIds().has(telegramId.toString());
}

export function getBlockedExtensions(): Set<string> {
  const raw = loadConfig().BLOCKED_FILE_EXTENSIONS;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}
