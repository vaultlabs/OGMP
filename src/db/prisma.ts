import { PrismaClient } from "@prisma/client";
import { loadConfig } from "../config/index.js";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function createPrismaClient(): PrismaClient {
  const cfg = loadConfig();
  return new PrismaClient({
    log: cfg.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
