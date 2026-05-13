import { Redis } from "ioredis";
import { loadConfig } from "../config/index.js";

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    const { REDIS_URL } = loadConfig();
    client = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  }
  return client;
}

export async function redisIncrWithTtl(
  key: string,
  ttlSeconds: number,
): Promise<number> {
  const r = getRedis();
  const n = await r.incr(key);
  if (n === 1) {
    await r.expire(key, ttlSeconds);
  }
  return n;
}

export async function acquireLock(
  key: string,
  ttlMs: number,
  token: string,
): Promise<boolean> {
  const r = getRedis();
  const res = await r.set(key, token, "PX", ttlMs, "NX");
  return res === "OK";
}

export async function releaseLock(key: string, token: string): Promise<void> {
  const r = getRedis();
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  await r.eval(script, 1, key, token);
}
