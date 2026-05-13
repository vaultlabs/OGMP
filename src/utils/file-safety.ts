import { loadConfig } from "../config/index.js";
import { getBlockedExtensions } from "../config/index.js";
import { ValidationError } from "./errors.js";

const TG_BOT_MAX_BYTES = 50 * 1024 * 1024;

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
  const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
  if (ext && getBlockedExtensions().has(ext)) {
    throw new ValidationError(
      "This file type is blocked for safety. Send archives (.zip/.rar/.7z), images, PDFs, or text — or other allowed files, one message at a time.",
    );
  }
  const dangerous = [".exe", ".bat", ".cmd", ".scr", ".vbs", ".ps1", ".js", ".jar", ".msi", ".com", ".pif"];
  if (dangerous.some((d) => name.endsWith(d))) {
    throw new ValidationError("Executable or script uploads are not accepted.");
  }
}
