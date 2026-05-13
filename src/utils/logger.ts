import { loadConfig } from "../config/index.js";

type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function shouldLog(level: Level): boolean {
  try {
    const cfg = loadConfig();
    return order[level] >= order[cfg.LOG_LEVEL];
  } catch {
    return true;
  }
}

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return "[unserializable]";
  }
}

export const logger = {
  debug: (msg: string, meta?: unknown) => {
    if (!shouldLog("debug")) return;
    if (meta !== undefined) console.debug(`[OGMP-MM] ${msg}`, safeStringify(meta));
    else console.debug(`[OGMP-MM] ${msg}`);
  },
  info: (msg: string, meta?: unknown) => {
    if (!shouldLog("info")) return;
    if (meta !== undefined) console.info(`[OGMP-MM] ${msg}`, safeStringify(meta));
    else console.info(`[OGMP-MM] ${msg}`);
  },
  warn: (msg: string, meta?: unknown) => {
    if (!shouldLog("warn")) return;
    if (meta !== undefined) console.warn(`[OGMP-MM] ${msg}`, safeStringify(meta));
    else console.warn(`[OGMP-MM] ${msg}`);
  },
  error: (msg: string, meta?: unknown) => {
    if (!shouldLog("error")) return;
    if (meta !== undefined) console.error(`[OGMP-MM] ${msg}`, safeStringify(meta));
    else console.error(`[OGMP-MM] ${msg}`);
  },
};
