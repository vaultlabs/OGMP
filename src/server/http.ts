import express from "express";
import type { Bot } from "grammy";
import { processWebhookPayload } from "../modules/payments/payment.service.js";
import { logger } from "../utils/logger.js";
import { loadConfig } from "../config/index.js";

export function createHttpApp(_bot: Bot): express.Express {
  void _bot;
  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "ogmp-mm" });
  });

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
