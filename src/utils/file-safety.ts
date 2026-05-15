import { loadConfig, getBlockedExtensions } from "../config/index.js";
import { ValidationError } from "./errors.js";

const TG_BOT_MAX_BYTES = 50 * 1024 * 1024;

/** Telegram often sends .txt as document with text/plain; some clients use application/octet-stream. */
const OCTET_STREAM_SAFE_EXTENSIONS = new Set([".txt", ".zip", ".rar", ".7z", ".pdf"]);

function extensionFromFileName(fileName: string | null | undefined): string {
  const raw = (fileName ?? "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return "";
  return lower.slice(dot);
}

export function getMaxUploadBytes(): number {
  const mb = loadConfig().MAX_UPLOAD_SIZE_MB;
  return Math.min(mb * 1024 * 1024, TG_BOT_MAX_BYTES);
}

export function assertFileAllowed(params: {
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
}): void {
  if (params.fileSize != null && params.fileSize > getMaxUploadBytes()) {
    throw new ValidationError("File exceeds maximum allowed size for this bot.");
  }
  const name = (params.fileName ?? "").toLowerCase();
  const ext = extensionFromFileName(params.fileName);
  const mimeRaw = (params.mimeType ?? "").trim().toLowerCase();
  /** Telegram often appends `; charset=utf-8` — compare only the primary type. */
  const mime = (mimeRaw.split(";")[0] ?? "").trim();

  const isPlainTextDocument = mime === "text/plain" || ext === ".txt";
  const isSafeArchive = ext === ".zip" || ext === ".rar" || ext === ".7z";

  if (ext && getBlockedExtensions().has(ext) && !isPlainTextDocument && !isSafeArchive) {
    throw new ValidationError(
      "This file type is blocked for safety. Send archives (.zip/.rar/.7z), images, PDFs, or text — or other allowed files, one message at a time.",
    );
  }
  const dangerous = [".exe", ".bat", ".cmd", ".scr", ".vbs", ".ps1", ".js", ".jar", ".msi", ".com", ".pif"];
  if (dangerous.some((d) => name.endsWith(d))) {
    throw new ValidationError("Executable or script uploads are not accepted.");
  }

  if (mime === "application/octet-stream") {
    if (!ext || !OCTET_STREAM_SAFE_EXTENSIONS.has(ext)) {
      throw new ValidationError(
        "This file was sent as application/octet-stream without a clear safe extension. Please send .txt, .pdf, .zip, .rar, or .7z (filename must end with that extension).",
      );
    }
  }
}
