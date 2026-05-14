import { prisma } from "../../db/prisma.js";

/** Admin-facing digest: deal room messages, report evidence, admin notes (no raw file_id in user channels). */
export async function buildAdminEvidenceDigest(params: {
  dealId: string;
  reportId?: string | null;
}): Promise<string> {
  const sections: string[] = [];
  const msgs = await prisma.dealMessage.findMany({
    where: { dealId: params.dealId },
    orderBy: { createdAt: "asc" },
    include: { sender: true },
  });
  if (msgs.length) {
    const lines = msgs.map(
      (m) =>
        `• ${m.createdAt.toISOString().slice(0, 16)} [${m.messageType}] from ${m.sender.telegramId}${m.fileName ? ` — ${m.fileName}` : ""}`,
    );
    sections.push(`Deal room messages (${msgs.length})\n${lines.join("\n")}`);
  } else {
    sections.push("Deal room messages: none");
  }
  if (params.reportId) {
    const ev = await prisma.reportEvidence.findMany({
      where: { reportId: params.reportId },
      orderBy: { createdAt: "asc" },
    });
    if (ev.length) {
      const lines = ev.map(
        (e) =>
          `• ${e.createdAt.toISOString().slice(0, 16)} [${e.evidenceType}]${e.fileName ? ` — ${e.fileName}` : ""}`,
      );
      sections.push(`Report evidence (${ev.length})\n${lines.join("\n")}`);
    } else {
      sections.push("Report evidence: none");
    }
    const notes = await prisma.reportAdminNote.findMany({
      where: { reportId: params.reportId },
      orderBy: { createdAt: "asc" },
    });
    if (notes.length) {
      const lines = notes.map((n) => `• ${n.createdAt.toISOString().slice(0, 16)} admin ${n.adminTelegramId}: ${n.note.slice(0, 200)}`);
      sections.push(`Admin notes (${notes.length})\n${lines.join("\n")}`);
    } else {
      sections.push("Admin notes: none");
    }
  }
  return sections.join("\n\n");
}
