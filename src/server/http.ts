import express from "express";
import type { Bot } from "grammy";
import { processWebhookPayload } from "../modules/payments/payment.service.js";
import { processPayoutIpn } from "../services/payout.service.js";
import { NowPaymentsProvider } from "../payments/nowpayments.provider.js";
import { logger } from "../utils/logger.js";
import { loadConfig } from "../config/index.js";

export function createHttpApp(_bot: Bot): express.Express {
  void _bot;
  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "ogmp-mm" });
  });

  app.post(
    "/webhooks/payouts/:provider",
    express.raw({ type: "application/json" }),
    (req, res) => {
      const provider = req.params.provider;
      if (provider !== "nowpayments") {
        res.status(404).json({ ok: false });
        return;
      }
      const signature = req.header("x-signature") ?? req.header("x-nowpayments-sig");
      const raw = req.body as Buffer;
      const np = new NowPaymentsProvider();
      if (!np.verifyWebhook(raw, signature)) {
        res.status(401).json({ ok: false });
        return;
      }
      try {
        const payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        void processPayoutIpn(payload)
          .then(() => res.json({ ok: true }))
          .catch((e) => {
            logger.error("payout_webhook_handler_error", { err: String(e) });
            res.status(500).json({ ok: false });
          });
      } catch (e) {
        logger.error("payout_webhook_parse_error", { err: String(e) });
        res.status(400).json({ ok: false });
      }
    },
  );

  app.post(
    "/webhooks/payments/:provider",
    express.raw({ type: "application/json" }),
    (req, res) => {
      const provider = req.params.provider;
      const signature = req.header("x-signature") ?? req.header("x-nowpayments-sig");
      const raw = req.body as Buffer;
      void processWebhookPayload(provider, raw, signature)
        .then((r) => {
          if (!r.ok) res.status(401).json(r);
          else res.json(r);
        })
        .catch((e) => {
          logger.error("webhook_handler_error", { err: String(e) });
          res.status(500).json({ ok: false });
        });
    },
  );

  return app;
}

export function startHttpServer(bot: Bot): ReturnType<express.Express["listen"]> {
  const cfg = loadConfig();
  const app = createHttpApp(bot);
  return app.listen(cfg.SERVER_PORT, () => {
    logger.info("http_server_listening", { port: cfg.SERVER_PORT });
  });
}
