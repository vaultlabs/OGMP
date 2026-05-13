import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.supportedCoin.createMany({
    data: [
      {
        currency: "USDT",
        network: "TRC20",
        enabled: true,
        confirmationsRequired: 20,
        paymentTimeoutMinutes: 120,
      },
      {
        currency: "USDT",
        network: "ERC20",
        enabled: true,
        confirmationsRequired: 12,
        paymentTimeoutMinutes: 120,
      },
      {
        currency: "BTC",
        network: "BTC",
        enabled: true,
        confirmationsRequired: 2,
        paymentTimeoutMinutes: 240,
      },
      {
        currency: "ETH",
        network: "ETH",
        enabled: true,
        confirmationsRequired: 12,
        paymentTimeoutMinutes: 120,
      },
      {
        currency: "LTC",
        network: "LTC",
        enabled: true,
        confirmationsRequired: 6,
        paymentTimeoutMinutes: 180,
      },
    ],
    skipDuplicates: true,
  });

  const feeCount = await prisma.feeSetting.count();
  if (feeCount === 0) {
    await prisma.feeSetting.create({
      data: {
        percentage: 0.01,
        minimumUsd: 1,
        maximumUsd: null,
        fixedUsd: 0,
        defaultFeePayer: "split",
      },
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
