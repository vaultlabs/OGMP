import { prisma } from "../../db/prisma.js";
import { loadConfig } from "../../config/index.js";

export const GATEWAY_SETTING_KEYS = {
  REQUIRE_OVERRIDE: "gateway.require_join_override",
  JOIN_URL: "gateway.join_url",
  USERNAME: "gateway.username",
  CHAT_ID: "gateway.chat_id",
} as const;

export type EffectiveGatewayConfig = {
  requireGatewayJoin: boolean;
  joinUrl: string;
  usernameLabel: string;
  /** When set, used for getChatMember; empty means honor-system on Continue. */
  chatId: string | null;
};

async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.botSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function getEffectiveGatewayConfig(): Promise<EffectiveGatewayConfig> {
  const cfg = loadConfig();
  const requireOverride = await getSetting(GATEWAY_SETTING_KEYS.REQUIRE_OVERRIDE);
  const requireGatewayJoin =
    requireOverride === "true" || requireOverride === "false"
      ? requireOverride === "true"
      : cfg.REQUIRE_GATEWAY_JOIN;

  const urlOverride = await getSetting(GATEWAY_SETTING_KEYS.JOIN_URL);
  const joinUrl = (urlOverride && urlOverride.trim()) || cfg.GATEWAY_JOIN_URL;

  const userOverride = await getSetting(GATEWAY_SETTING_KEYS.USERNAME);
  const usernameLabel = (userOverride && userOverride.trim()) || cfg.GATEWAY_USERNAME;

  const chatOverride = await getSetting(GATEWAY_SETTING_KEYS.CHAT_ID);
  const rawChat = (chatOverride && chatOverride.trim()) || cfg.GATEWAY_CHAT_ID?.trim() || "";
  const chatId = rawChat.length > 0 ? rawChat : null;

  return { requireGatewayJoin, joinUrl, usernameLabel, chatId };
}

export async function setGatewaySetting(key: string, value: string): Promise<void> {
  await prisma.botSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export async function deleteGatewaySetting(key: string): Promise<void> {
  await prisma.botSetting.deleteMany({ where: { key } });
}

export async function getGatewayAdminSnapshot(): Promise<{
  effective: EffectiveGatewayConfig;
  overrides: {
    requireJoin: string | null;
    joinUrl: string | null;
    username: string | null;
    chatId: string | null;
  };
  env: {
    REQUIRE_GATEWAY_JOIN: boolean;
    GATEWAY_JOIN_URL: string;
    GATEWAY_USERNAME: string;
    GATEWAY_CHAT_ID: string;
  };
}> {
  const cfg = loadConfig();
  const [req, url, user, cid] = await Promise.all([
    getSetting(GATEWAY_SETTING_KEYS.REQUIRE_OVERRIDE),
    getSetting(GATEWAY_SETTING_KEYS.JOIN_URL),
    getSetting(GATEWAY_SETTING_KEYS.USERNAME),
    getSetting(GATEWAY_SETTING_KEYS.CHAT_ID),
  ]);
  const effective = await getEffectiveGatewayConfig();
  return {
    effective,
    overrides: { requireJoin: req, joinUrl: url, username: user, chatId: cid },
    env: {
      REQUIRE_GATEWAY_JOIN: cfg.REQUIRE_GATEWAY_JOIN,
      GATEWAY_JOIN_URL: cfg.GATEWAY_JOIN_URL,
      GATEWAY_USERNAME: cfg.GATEWAY_USERNAME,
      GATEWAY_CHAT_ID: cfg.GATEWAY_CHAT_ID ?? "",
    },
  };
}
