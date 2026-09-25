import { afterEach, describe, expect, it, vi } from "vitest";
import { caller, validBody } from "./app.js";
import type { Config } from "./config.js";
import type { Request } from "express";
import request from "supertest";
import { createApp } from "./app.js";
import type { BudgetStore } from "./budget.js";
import { BudgetError } from "./budget.js";

const config = {
  copToken: "cop-secret-value-long-enough-123456",
  simToken: "sim-secret-value-long-enough-123456",
  adminToken: "admin-secret-value-long-enough-123456"
} as Config;
const req = (token?: string) => ({ header: () => (token ? `Bearer ${token}` : undefined) }) as unknown as Request;
const internalContext = { contractVersion: "cop-chat-context-v1", dataClass: "internal" };
const reviewedInternalContext = { contractVersion: "cop-chat-context-v1", dataClass: "internal", attestation: "cop-internal-reviewed-v1", items: [{ kind: "chat_message", text: "Viditelná zpráva pouze pro lokální model." }] };
const syntheticContext = { contractVersion: "cop-chat-context-v1", dataClass: "synthetic", attestation: "cop-policy-reviewed-v1", scenarioId: "exercise_42", facts: ["Fiktivní výpadek proudu v cvičení."] };
const aggregateContext = { contractVersion: "cop-chat-context-v1", dataClass: "public_aggregate", attestation: "cop-policy-reviewed-v1", aggregates: [{ sourceId: "chmi_weather_stations", metricId: "station_count", regionCode: "CZ010", periodStart: "2026-09-24T00:00:00Z", periodEnd: "2026-09-25T00:00:00Z", value: 42, unit: "count", sampleSize: 42 }] };
const copBody = (dataClass: "synthetic" | "public_aggregate" | "internal", copContext: unknown) => ({
  taskType: "cop_chat", dataClass, prompt: "Stručně shrň povolený kontext.", userId: "user_opaque_123456", preference: "external", allowExternal: true, copContext
});
const runtimeConfig = { ...config, localUrl: "", localModel: "", externalEnabled: true, advancedEnabled: true, openaiKey: "test-only-key", economyModel: "gpt-6-luna", advancedModel: "gpt-6-sol" } as Config;
const testStore = () => ({
  policy: vi.fn(async () => ({ externalAllowed: true, advancedAllowed: true, limits: { dailyMicrousd: 1_000_000, monthlyMicrousd: 10_000_000, perUserDailyRequests: 10 } })),
  reserve: vi.fn(async () => "00000000-0000-4000-8000-000000000001"),
  finish: vi.fn(async () => undefined),
  usage: vi.fn(async () => ({ dailyMicrousd: 120, monthlyMicrousd: 120, dailyRequests: 1, monthlyRequests: 1, dailyInputTokens: 100, dailyOutputTokens: 20, monthlyInputTokens: 100, monthlyOutputTokens: 20, limits: { dailyMicrousd: 1_000_000, monthlyMicrousd: 10_000_000, perUserDailyRequests: 10 } }))
});

afterEach(() => vi.unstubAllGlobals());

describe("AI Router request boundary", () => {
  it("requires a service identity", () => {
    expect(caller(req(), config)).toBeNull();
    expect(caller(req("wrong"), config)).toBeNull();
  });
  it("keeps separate COP, SIM and admin identities", () => {
    expect(caller(req(config.copToken), config)).toBe("cop");
    expect(caller(req(config.simToken), config)).toBe("sim");
    expect(caller(req(config.adminToken), config)).toBe("admin");
  });
  it("rejects malformed generation input", () => {
    expect(validBody({ ...copBody("internal", internalContext), preference: "local", allowExternal: false })).toBe(true);
    expect(validBody({ ...copBody("internal", reviewedInternalContext), preference: "local", allowExternal: false })).toBe(true);
    expect(validBody({ ...copBody("internal", { ...reviewedInternalContext, items: [{ kind: "incident", text: "Forbidden raw incident." }] }), preference: "local", allowExternal: false })).toBe(false);
    expect(validBody({ ...copBody("internal", { ...reviewedInternalContext, extra: "raw data" }), preference: "local", allowExternal: false })).toBe(false);
    expect(validBody({ ...copBody("internal", internalContext), maxOutputTokens: 99999 })).toBe(false);
    expect(validBody({ ...copBody("internal", internalContext), dataClass: "secret" })).toBe(false);
    expect(validBody({ ...copBody("synthetic", syntheticContext), dataClass: undefined })).toBe(false);
    expect(validBody({ ...copBody("public_aggregate", aggregateContext), extraContext: "raw records" })).toBe(false);
    expect(validBody({ ...copBody("public_aggregate", { ...aggregateContext, aggregates: [{ ...aggregateContext.aggregates[0], rawText: "private message" }] }) })).toBe(false);
    expect(validBody({ ...copBody("public_aggregate", { ...aggregateContext, aggregates: [{ ...aggregateContext.aggregates[0], sampleSize: 1 }] }) })).toBe(false);
    expect(validBody({ ...copBody("public_aggregate", { ...aggregateContext, aggregates: [{ ...aggregateContext.aggregates[0], periodStart: "2026-09-24" }] }) })).toBe(false);
  });
  it("shares only aggregate usage with authenticated service callers", async () => {
    const usage = { dailyMicrousd: 42, monthlyMicrousd: 84, dailyRequests: 2, limits: { dailyMicrousd: 1_000_000, monthlyMicrousd: 10_000_000, perUserDailyRequests: 10 } };
    const app = createApp(config, { usage: async () => usage } as BudgetStore);
    await request(app).get("/api/v1/ai-router/usage").expect(401);
    for (const token of [config.copToken, config.simToken, config.adminToken]) {
      const response = await request(app).get("/api/v1/ai-router/usage").set("authorization", `Bearer ${token}`).expect(200);
      expect(response.body).toEqual(usage);
    }
  });
  it("allows only authenticated COP to send explicitly reviewed synthetic and public aggregates to Luna and audits usage", async () => {
    const calls: Array<{ model: string; input: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string; input: string };
      calls.push(body);
      return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: "Přehled pro operátora." }] }], usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200 });
    }));
    const store = testStore();
    const app = createApp(runtimeConfig, store as unknown as BudgetStore);
    for (const [dataClass, context] of [["synthetic", syntheticContext], ["public_aggregate", aggregateContext]] as const) {
      const result = await request(app).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.copToken}`).send(copBody(dataClass, context)).expect(200);
      expect(result.body).toMatchObject({ model: "gpt-6-luna", tier: "external_economy", routingReason: "approved_cop_external_economy", requiresHumanReview: true, usage: { inputTokens: 100, outputTokens: 20, estimatedMicrousd: 40 } });
      expect(calls.at(-1)?.model).toBe("gpt-6-luna");
      expect(calls.at(-1)?.input).toContain(dataClass);
    }
    expect(store.reserve).toHaveBeenCalledWith("cop", "user_opaque_123456", "cop_chat", "gpt-6-luna", "approved_cop_external_economy", expect.any(String), "external_economy", expect.any(Number));
    expect(store.finish).toHaveBeenCalledTimes(2);
    expect(store.finish).toHaveBeenCalledWith(expect.any(String), "success", 100, 20, 40);
    const usage = await request(app).get("/api/v1/ai-router/usage").set("authorization", `Bearer ${config.copToken}`).expect(200);
    expect(usage.body).toMatchObject({ dailyInputTokens: 100, dailyOutputTokens: 20, dailyMicrousd: 120 });
  });
  it("rejects missing approval, internal external processing, wrong caller and invalid classification before a model call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = testStore();
    const app = createApp(runtimeConfig, store as unknown as BudgetStore);
    await request(app).post("/api/v1/ai-router/generate").send(copBody("synthetic", syntheticContext)).expect(401);
    await request(app).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.simToken}`).send(copBody("synthetic", syntheticContext)).expect(403);
    await request(app).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.copToken}`).send({ ...copBody("synthetic", syntheticContext), allowExternal: false }).expect(400, { error: "external_processing_not_approved" });
    await request(app).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.copToken}`).send(copBody("internal", internalContext)).expect(400, { error: "internal_external_forbidden" });
    await request(app).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.copToken}`).send({ ...copBody("synthetic", syntheticContext), allowPaidEscalation: true }).expect(400, { error: "cop_paid_escalation_forbidden" });
    await request(app).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.copToken}`).send({ ...copBody("public_aggregate", aggregateContext), dataClass: "secret" }).expect(400, { error: "invalid_request" });
    await request(app).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.copToken}`).send({ ...copBody("synthetic", syntheticContext), copContext: undefined }).expect(400, { error: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.reserve).not.toHaveBeenCalled();
  });
  it("keeps internal COP chat local and fails closed when that model is absent", async () => {
    const store = testStore();
    const app = createApp(runtimeConfig, store as unknown as BudgetStore);
    const response = await request(app).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.copToken}`).send({ ...copBody("internal", internalContext), preference: "auto", allowExternal: false }).expect(503);
    expect(response.body).toEqual({ error: "local_model_unavailable" });
    expect(store.reserve).not.toHaveBeenCalled();
    const localFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ response: "Lokální odpověď", prompt_eval_count: 12, eval_count: 5 }), { status: 200 }));
    vi.stubGlobal("fetch", localFetch);
    const localStore = testStore();
    const localApp = createApp({ ...runtimeConfig, localUrl: "http://ollama:11434", localModel: "local-test-model" }, localStore as unknown as BudgetStore);
    const localResult = await request(localApp).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.copToken}`).send({ ...copBody("internal", reviewedInternalContext), preference: "auto", allowExternal: false }).expect(200);
    expect(localResult.body).toMatchObject({ tier: "local_fast", model: "local-test-model", usage: { estimatedMicrousd: 0 } });
    expect(String(localFetch.mock.calls[0]?.[0])).toContain("ollama:11434");
    expect(String(localFetch.mock.calls[0]?.[1]?.body)).toContain("Viditelná zpráva pouze pro lokální model.");
    expect(JSON.parse(String(localFetch.mock.calls[0]?.[1]?.body)).think).toBe(false);
    const failedLocalFetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", failedLocalFetch);
    await request(localApp).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.copToken}`).send({ ...copBody("internal", internalContext), preference: "auto", allowExternal: false }).expect(503, { requestId: "00000000-0000-4000-8000-000000000001", error: "model_unavailable" });
    expect(failedLocalFetch).toHaveBeenCalledTimes(1);
  });
  it("returns specific limit, database and model failures without an external bypass", async () => {
    const body = copBody("synthetic", syntheticContext);
    for (const code of ["daily_budget_exceeded", "monthly_budget_exceeded", "user_daily_limit_exceeded"]) {
      const store = testStore();
      store.reserve.mockRejectedValueOnce(new BudgetError(code));
      const response = await request(createApp(runtimeConfig, store as unknown as BudgetStore)).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.copToken}`).send(body).expect(429);
      expect(response.body).toEqual({ error: code });
    }
    const dbStore = testStore();
    dbStore.policy.mockRejectedValueOnce(new Error("db down"));
    await request(createApp(runtimeConfig, dbStore as unknown as BudgetStore)).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.copToken}`).send(body).expect(503, { error: "policy_unavailable" });
    const reserveStore = testStore();
    reserveStore.reserve.mockRejectedValueOnce(new Error("db down"));
    await request(createApp(runtimeConfig, reserveStore as unknown as BudgetStore)).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.copToken}`).send(body).expect(503, { error: "budget_store_unavailable" });
    const unavailableStore = testStore();
    await request(createApp({ ...runtimeConfig, openaiKey: "" }, unavailableStore as unknown as BudgetStore)).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.copToken}`).send(body).expect(503, { error: "external_model_unavailable" });
    const providerStore = testStore();
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await request(createApp(runtimeConfig, providerStore as unknown as BudgetStore)).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.copToken}`).send(body).expect(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(providerStore.finish).toHaveBeenCalledWith(expect.any(String), "failed");
    const finishStore = testStore();
    finishStore.finish.mockRejectedValueOnce(new Error("audit db down"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: "Odpověď" }] }], usage: { input_tokens: 5, output_tokens: 5 } }), { status: 200 })));
    await request(createApp(runtimeConfig, finishStore as unknown as BudgetStore)).post("/api/v1/ai-router/generate").set("authorization", `Bearer ${config.copToken}`).send(body).expect(503, { requestId: "00000000-0000-4000-8000-000000000001", error: "budget_store_unavailable" });
  });
});
