/**
 * Telegram bots never receive a host OS "folder" as one object.
 * Users must either send an archive (.zip / .rar / .7z) or send files one message at a time.
 */
export const TELEGRAM_FOLDER_UPLOAD_EXPLANATION_PLAIN = `Telegram cannot accept a real folder in a single upload.

You can:
• Send a .zip, .rar, or .7z archive as a document (compressed folder), or
• Send multiple files one by one — each message is saved separately.`;

/** Short follow-up after each stored file (plain text — safe for all Telegram parse modes). */
export function formatUploadContinuationPlain(finishHint: string): string {
  return `Send another file, a .zip / .rar / .7z archive, or ${finishHint}.`;
}
