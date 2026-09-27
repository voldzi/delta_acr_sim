import { createHmac } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { BudgetStore } from "./budget.js";
import type { Config } from "./config.js";
import { SeparateBillingError, type SeparateBilling } from "./separate-billing.js";

const actorSecret = "cop-actor-test-secret-long-enough-123456";
const config = {
  copToken: "cop-service-token-long-enough-123456", simToken: "sim-service-token-long-enough-123456",
  adminToken: "admin-service-token-long-enough-123456", izsToken: "izs-service-token-long-enough-123456",
  copActorSecret: actorSecret, copByokEnabled: true, simIzsEnabled: true,
  externalEnabled: true,
  economyModel: "gpt-6-luna", simIzsModel: "gpt-5.4-mini", simIzsOpenaiKey: "sim-project-test-key",
  simIzsProjectId: "proj_sim_test", userHashSecret: "user-hash-test-secret-long-enough-123456",
  publishedSourceIds: ["chmi_public"], byokDailyMicrousd: 1_000_000, byokMonthlyMicrousd: 10_000_000,
  byokDailyRequests: 10, simIzsDailyMicrousd: 1_000_000, simIzsMonthlyMicrousd: 10_000_000, simIzsDailyRequests: 20
} as Config;
const store = { hashUser: (client: string, user: string) => `${client}:${user}`, policy: async () => ({ externalAllowed: true }) } as BudgetStore;
const chat = { contractVersion: "cop-chat-byok-v1", billingSource: "user_openai_key", question: "Jaký je stav?", allowExternal: true };
const izs = { contractVersion: "sim-izs-summary-v1", billingSource: "sim_project", taskType: "sim_izs_summary", dataClass: "synthetic", prompt: "Shrň fiktivní výpadek.", context: { contractVersion: "sim-synthetic-context-v1", attestation: "sim-synthetic-reviewed-v1", facts: ["Fiktivní výpadek."] } };

function copHeaders(user: string): Record<string, string> {
  const now = Math.floor(Date.now() / 1000);
  const encoded = Buffer.from(JSON.stringify({ sub: user, aud: "sim-ai-router", iat: now, exp: now + 40 })).toString("base64url");
  return { authorization: `Bearer ${config.copToken}`, "x-cop-actor": encoded,
    "x-cop-actor-signature": createHmac("sha256", actorSecret).update(encoded).digest("hex") };
}

function memoryBilling() {
  const keys = new Map<string, string>();
  const separate = {
    keyStatus: vi.fn(async (user: string) => ({ configured: keys.has(user) })),
    putKey: vi.fn(async (user: string, key: string) => { keys.set(user, key); return { configured: true as const, fingerprint: "fingerprint" }; }),
    removeKey: vi.fn(async (user: string) => { keys.delete(user); }),
    getKey: vi.fn(async (user: string) => keys.has(user) ? { apiKey: keys.get(user)!, fingerprint: "fingerprint" } : null),
    reserve: vi.fn(async () => "00000000-0000-4000-8000-000000000001"),
    finish: vi.fn(async () => undefined),
    usage: vi.fn(async () => ({ user_openai_key: { dailyMicrousd: 1 }, sim_project: { dailyMicrousd: 2 } }))
  };
  return { separate: separate as unknown as SeparateBilling, calls: separate, keys };
}

afterEach(() => vi.unstubAllGlobals());

describe("separate COP and SIM billing lanes", () => {
  it("isolates two users, rotation and deletion, without returning plaintext keys", async () => {
    const { separate, keys } = memoryBilling();
    const outgoing: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("/models/")) return new Response("{}", { status: 200 });
      outgoing.push(String((init.headers as Record<string, string>).authorization));
      return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: "Advisory" }] }], usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200 });
    }));
    const app = createApp(config, store, separate);
    for (const [user, key] of [["opaque_user_1111", "sk-user-one-key-long-enough-123456"], ["opaque_user_2222", "sk-user-two-key-long-enough-123456"]] as Array<[string, string]>) {
      const saved = await request(app).put("/api/v1/ai-router/cop/users/me/openai-key").set(copHeaders(user)).send({ apiKey: key }).expect(200);
      expect(JSON.stringify(saved.body)).not.toContain(key);
      const answer = await request(app).post("/api/v1/ai-router/cop/chat").set(copHeaders(user)).send(chat).expect(200);
      expect(answer.body.billingSource).toBe("user_openai_key");
      expect(JSON.stringify(answer.body)).not.toContain(key);
    }
    expect(outgoing).toEqual(["Bearer sk-user-one-key-long-enough-123456", "Bearer sk-user-two-key-long-enough-123456"]);
    await request(app).put("/api/v1/ai-router/cop/users/me/openai-key").set(copHeaders("opaque_user_1111")).send({ apiKey: "sk-rotated-one-key-long-enough-123456" }).expect(200);
    expect(keys.get("cop:opaque_user_1111")).toBe("sk-rotated-one-key-long-enough-123456");
    expect(keys.get("cop:opaque_user_2222")).toBe("sk-user-two-key-long-enough-123456");
    await request(app).delete("/api/v1/ai-router/cop/users/me/openai-key").set(copHeaders("opaque_user_1111")).expect(204);
    await request(app).post("/api/v1/ai-router/cop/chat").set(copHeaders("opaque_user_1111")).send(chat).expect(422, { error: "user_key_missing" });
    await request(app).post("/api/v1/ai-router/cop/chat").set(copHeaders("opaque_user_2222")).send(chat).expect(200);
  });

  it("rejects account override and unsigned actor before provider calls", async () => {
    const { separate } = memoryBilling();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const app = createApp(config, store, separate);
    await request(app).post("/api/v1/ai-router/cop/chat").set("authorization", `Bearer ${config.copToken}`).send(chat).expect(401);
    await request(app).post("/api/v1/ai-router/cop/chat").set(copHeaders("opaque_user_1111")).send({ ...chat, userId: "opaque_user_2222" }).expect(400);
    await request(app).post("/api/v1/ai-router/cop/chat").set(copHeaders("opaque_user_1111")).send({ ...chat, billingSource: "sim_project" }).expect(400);
    await request(app).post("/api/v1/ai-router/cop/chat").set("authorization", `Bearer ${config.simToken}`).send(chat).expect(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never falls back to the SIM key on missing/invalid keys, limits, 429 or provider outage", async () => {
    const { separate, calls, keys } = memoryBilling();
    keys.set("cop:opaque_user_1111", "sk-user-one-key-long-enough-123456");
    const app = createApp(config, store, separate);
    for (const code of ["daily_budget_exceeded", "monthly_budget_exceeded", "user_daily_limit_exceeded"]) {
      calls.reserve.mockRejectedValueOnce(new SeparateBillingError(code));
      const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
      await request(app).post("/api/v1/ai-router/cop/chat").set(copHeaders("opaque_user_1111")).send(chat).expect(429, { error: code });
      expect(fetchMock).not.toHaveBeenCalled();
    }
    for (const [status, expected] of [[401, 422], [429, 429], [503, 503]] as const) {
      const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("error", { status })); vi.stubGlobal("fetch", fetchMock);
      await request(app).post("/api/v1/ai-router/cop/chat").set(copHeaders("opaque_user_1111")).send(chat).expect(expected);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String((fetchMock.mock.calls[0]?.[1].headers as Record<string, string>).authorization)).toContain("sk-user-one");
    }
    expect(calls.finish).toHaveBeenCalledWith(expect.any(String), "uncertain", undefined, undefined, undefined, "provider_unavailable");
  });

  it("keeps the SIM IZS project, service identity, model, ledger and admin usage separate", async () => {
    const { separate, calls, keys } = memoryBilling();
    keys.set("cop:opaque_user_1111", "sk-user-one-key-long-enough-123456");
    const outbound: Array<{ authorization: string; model: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(String(init.body));
      outbound.push({ authorization: String((init.headers as Record<string, string>).authorization), model: parsed.model });
      return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: "IZS draft" }] }], usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200 });
    }));
    const app = createApp(config, store, separate);
    await request(app).post("/api/v1/ai-router/sim/izs-summary").set("authorization", `Bearer ${config.copToken}`).set("x-sim-actor", "operator_123456").send(izs).expect(403);
    await request(app).post("/api/v1/ai-router/sim/izs-summary").set("authorization", `Bearer ${config.izsToken}`).send(izs).expect(401);
    const summary = await request(app).post("/api/v1/ai-router/sim/izs-summary").set("authorization", `Bearer ${config.izsToken}`).set("x-sim-actor", "operator_123456").send(izs).expect(200);
    expect(summary.body).toMatchObject({ billingSource: "sim_project", model: "gpt-5.4-mini", requiresHumanReview: true });
    expect(calls.reserve).toHaveBeenCalledWith("sim_project", "sim_izs_project", "izs:operator_123456", expect.any(String), "proj_sim_test", "sim_izs_summary", "gpt-5.4-mini", expect.any(Number), expect.any(Object));
    expect(outbound).toEqual([{ authorization: "Bearer sim-project-test-key", model: "gpt-5.4-mini" }]);
    await request(app).get("/api/v1/ai-router/billing-usage").set("authorization", `Bearer ${config.copToken}`).expect(403);
    const usage = await request(app).get("/api/v1/ai-router/billing-usage").set("authorization", `Bearer ${config.adminToken}`).expect(200);
    expect(usage.body).toMatchObject({ actualProviderChargesVerified: false, usage: { user_openai_key: { dailyMicrousd: 1 }, sim_project: { dailyMicrousd: 2 } } });
  });

  it("reports an invalid SIM project key without retry or a COP-key fallback", async () => {
    const { separate, calls } = memoryBilling();
    const fetchMock = vi.fn(async () => new Response("invalid", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await request(createApp(config, store, separate)).post("/api/v1/ai-router/sim/izs-summary")
      .set("authorization", `Bearer ${config.izsToken}`).set("x-sim-actor", "operator_123456")
      .send(izs).expect(503, { requestId: "00000000-0000-4000-8000-000000000001", error: "sim_project_unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls.finish).toHaveBeenCalledWith(expect.any(String), "failed", undefined, undefined, undefined, "user_key_invalid");
  });

  it("fails closed when a feature or database is unavailable", async () => {
    const { separate, calls, keys } = memoryBilling();
    keys.set("cop:opaque_user_1111", "sk-user-one-key-long-enough-123456");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    calls.reserve.mockRejectedValueOnce(new Error("db down"));
    await request(createApp(config, store, separate)).post("/api/v1/ai-router/cop/chat").set(copHeaders("opaque_user_1111")).send(chat).expect(503, { error: "billing_store_unavailable" });
    await request(createApp({ ...config, copByokEnabled: false }, store, separate)).post("/api/v1/ai-router/cop/chat").set(copHeaders("opaque_user_1111")).send(chat).expect(503, { error: "cop_byok_not_enabled" });
    await request(createApp({ ...config, externalEnabled: false }, store, separate)).post("/api/v1/ai-router/cop/chat").set(copHeaders("opaque_user_1111")).send(chat).expect(503, { error: "external_processing_disabled" });
    await request(createApp({ ...config, simIzsEnabled: false }, store, separate)).post("/api/v1/ai-router/sim/izs-summary").set("authorization", `Bearer ${config.izsToken}`).set("x-sim-actor", "operator_123456").send(izs).expect(503, { error: "sim_izs_not_enabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
