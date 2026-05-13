import { prisma } from "../../db/prisma.js";

export async function allocateReportCode(year: number): Promise<string> {
  const next = await prisma.$transaction(async (tx) => {
    const row = await tx.reportCodeCounter.upsert({
      where: { year },
      create: { year, last: 1 },
      update: { last: { increment: 1 } },
    });
    return row.last;
  });
  return `RPT-${year}-${String(next).padStart(6, "0")}`;
}
