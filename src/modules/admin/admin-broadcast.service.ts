import { getRedis } from "../../utils/redis.js";
import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";

const draftKey = (adminTg: bigint) => `ogmp:bc_draft:${adminTg.toString()}`;
const photoWaitKey = (adminTg: bigint) => `ogmp:bc_photo_wait:${adminTg.toString()}`;

export type BroadcastDraft = {
  text: string;
  /** Telegram file_id for photo broadcasts */
  photoFileId?: string;
  /** Optional URL button under the announcement */
  button?: { text: string; url: string };
};

export async function setBroadcastPhotoWait(adminTg: bigint): Promise<void> {
  await getRedis().set(photoWaitKey(adminTg), "1", "EX", 300);
}

export async function peekBroadcastPhotoWait(adminTg: bigint): Promise<boolean> {
  const v = await getRedis().get(photoWaitKey(adminTg));
  return v === "1";
}

export async function clearBroadcastPhotoWait(adminTg: bigint): Promise<void> {
  await getRedis().del(photoWaitKey(adminTg));
}

export async function setBroadcastDraft(adminTg: bigint, draft: BroadcastDraft): Promise<void> {
  await getRedis().set(draftKey(adminTg), JSON.stringify(draft), "EX", 600);
}

export async function getBroadcastDraft(adminTg: bigint): Promise<BroadcastDraft | null> {
  const raw = await getRedis().get(draftKey(adminTg));
  if (!raw) return null;
  return JSON.parse(raw) as BroadcastDraft;
}

export async function clearBroadcastDraft(adminTg: bigint): Promise<void> {
  await getRedis().del(draftKey(adminTg));
}

/** Parse `/broadcast` body. Use `text|||Button label|||https://example.com` for an optional URL button. */
export function parseBroadcastCommandBody(raw: string): BroadcastDraft {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty");
  const parts = trimmed.split("|||").map((s) => s.trim());
  if (parts.length === 3) {
    const text = parts[0]!;
    const btnText = parts[1]!;
    const btnUrl = parts[2];
    if (!text) throw new Error("empty");
    if (!btnUrl) throw new Error("bad_url");
    let u: URL;
    try {
      u = new URL(btnUrl);
    } catch {
      throw new Error("bad_url");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad_url");
    return {
      text,
      button: { text: (btnText || "Read more").slice(0, 64), url: btnUrl },
    };
  }
  return { text: trimmed };
}

function broadcastMarkup(draft: BroadcastDraft): InlineKeyboard | undefined {
  if (!draft.button) return undefined;
  return new InlineKeyboard().url(draft.button.text, draft.button.url);
}

/** Sends an official announcement to all non-banned users with a Telegram id. Rate-limited. */
export async function runBroadcastFanout(api: Api, draft: BroadcastDraft): Promise<{ sent: number; errors: number }> {
  const users = await prisma.user.findMany({
    where: { banned: false },
    select: { telegramId: true },
    take: 5000,
  });
  let sent = 0;
  let errors = 0;
  const markup = broadcastMarkup(draft);
  for (const u of users) {
    try {
      if (draft.photoFileId) {
        await api.sendPhoto(u.telegramId.toString(), draft.photoFileId, {
          caption: draft.text.slice(0, 1024),
          ...(markup ? { reply_markup: markup } : {}),
        });
      } else {
        await api.sendMessage(u.telegramId.toString(), draft.text.slice(0, 4096), {
          ...(markup ? { reply_markup: markup } : {}),
        });
      }
      sent += 1;
      if (sent % 25 === 0) await new Promise((r) => setTimeout(r, 1100));
    } catch (e) {
      errors += 1;
      logger.warn("broadcast_send_failed", { err: String(e), tg: u.telegramId.toString() });
    }
  }
  return { sent, errors };
}
