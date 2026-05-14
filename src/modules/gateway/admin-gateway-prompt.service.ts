import { getRedis } from "../../utils/redis.js";

const KEY = (telegramId: bigint) => `ogmp:admin_gw_expect:${telegramId.toString()}`;
const TTL_SEC = 600;

export type AdminGatewayExpectField = "url" | "username" | "chat_id";

export async function setAdminGatewayExpect(
  telegramId: bigint,
  field: AdminGatewayExpectField,
): Promise<void> {
  await getRedis().set(KEY(telegramId), field, "EX", TTL_SEC);
}

export async function getAdminGatewayExpect(telegramId: bigint): Promise<AdminGatewayExpectField | null> {
  const v = await getRedis().get(KEY(telegramId));
  if (v === "url" || v === "username" || v === "chat_id") return v;
  return null;
}

export async function clearAdminGatewayExpect(telegramId: bigint): Promise<void> {
  await getRedis().del(KEY(telegramId));
}
