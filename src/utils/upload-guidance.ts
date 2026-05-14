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

/** After a text note is saved in Deal room mode (plain text). */
export function formatDealRoomTextSavedPlain(): string {
  return [
    "What's next:",
    "• Send another text note or a file for this same deal, or",
    "• Type /done_room when you're done here — then you can use the menu (Create deal, View deal, etc.) again.",
    "",
    "If you meant to create a new deal but see this message, you were still in Deal room mode: send /done_room first, then tap Create deal or send /create.",
  ].join("\n");
}
