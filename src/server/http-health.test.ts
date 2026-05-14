import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Bot } from "grammy";
import { createHttpApp } from "./http.js";

describe("HTTP health", () => {
  it("GET /health", async () => {
    const app = createHttpApp({} as unknown as Bot);
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: "ogmp-mm" });
  });
});
