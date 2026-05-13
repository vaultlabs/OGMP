import { prisma } from "../db/prisma.js";

export async function allocateDealCode(year: number): Promise<string> {
  const next = await prisma.$transaction(async (tx) => {
    const row = await tx.dealCodeCounter.upsert({
      where: { year },
      create: { year, last: 1 },
      update: { last: { increment: 1 } },
    });
    return row.last;
  });
  const padded = String(next).padStart(6, "0");
  return `OGMP-${year}-${padded}`;
}
