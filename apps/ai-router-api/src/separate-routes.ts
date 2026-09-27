import { createHmac } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { BudgetStore } from "./budget.js";
import type { Config } from "./config.js";
import { verifyCopActor } from "./cop-actor.js";
import { estimateMicrousd } from "./routing.js";
import { type BillingLimits, type SeparateBilling, SeparateBillingError } from "./separate-billing.js";
import { callSeparateOpenAI, ProviderError, validateProjectKey } from "./separate-provider.js";
import { copOutboundInput, simIzsOutboundInput, validCopChatBody, validSimIzsBody } from "./typed-context.js";

function forbidden(res: Response): boolean {
  if (res.locals.caller === "admin") { res.status(403).json({ error: "task_not_allowed" }); return true; }
  return false;
}

function copUser(req: Request, res: Response, config: Config, store: BudgetStore): string | null {
  if (res.locals.caller !== "cop") { res.status(403).json({ error: "task_not_allowed" }); return null; }
  if (!config.copByokEnabled || !config.copActorSecret) { res.status(503).json({ error: "cop_byok_not_enabled" }); return null; }
  const actor = verifyCopActor(req, config.copActorSecret);
  if (!actor) { res.status(401).json({ error: "actor_assertion_invalid" }); return null; }
  return store.hashUser("cop", actor.sub);
}

function limits(config: Config, source: "user_openai_key" | "sim_project"): BillingLimits {
  return source === "user_openai_key"
    ? { dailyMicrousd: config.byokDailyMicrousd!, monthlyMicrousd: config.byokMonthlyMicrousd!, dailyRequests: config.byokDailyRequests! }
    : { dailyMicrousd: config.simIzsDailyMicrousd!, monthlyMicrousd: config.simIzsMonthlyMicrousd!, dailyRequests: config.simIzsDailyRequests! };
}

function providerStatus(error: ProviderError): number {
  if (error.code === "user_key_invalid" || error.code === "user_model_unavailable") return 422;
  if (error.code === "provider_rate_limited") return 429;
  return 503;
}

async function externalPolicyAllowed(config: Config, store: BudgetStore): Promise<boolean> {
  if (!config.externalEnabled) return false;
  return (await store.policy()).externalAllowed;
}

export function registerSeparateRoutes(app: Express, config: Config, store: BudgetStore, separate?: SeparateBilling): void {
  const path = "/api/v1/ai-router/cop/users/me/openai-key";
  app.get(path, async (req, res) => {
    const userHash = copUser(req, res, config, store);
    if (!userHash) return;
    if (!separate) { res.status(503).json({ error: "credential_store_unavailable" }); return; }
    try { res.json(await separate.keyStatus(userHash)); }
    catch { res.status(503).json({ error: "credential_store_unavailable" }); }
  });
  app.put(path, async (req, res) => {
    const userHash = copUser(req, res, config, store);
    if (!userHash) return;
    if (!separate) { res.status(503).json({ error: "credential_store_unavailable" }); return; }
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || Object.keys(body).length !== 1 || typeof body.apiKey !== "string" ||
        body.apiKey.length < 20 || body.apiKey.length > 512 || !/^sk-[\x21-\x7e]+$/u.test(body.apiKey)) {
      res.status(400).json({ error: "invalid_key_input" }); return;
    }
    try {
      await validateProjectKey(body.apiKey, config.economyModel);
      res.json(await separate.putKey(userHash, body.apiKey));
    } catch (error) {
      if (error instanceof ProviderError) { res.status(providerStatus(error)).json({ error: error.code }); return; }
      res.status(503).json({ error: "credential_store_unavailable" });
    }
  });
  app.delete(path, async (req, res) => {
    const userHash = copUser(req, res, config, store);
    if (!userHash) return;
    if (!separate) { res.status(503).json({ error: "credential_store_unavailable" }); return; }
    try { await separate.removeKey(userHash); res.status(204).end(); }
    catch { res.status(503).json({ error: "credential_store_unavailable" }); }
  });
  app.get("/api/v1/ai-router/billing-usage", async (_req, res) => {
    if (res.locals.caller !== "admin") { res.status(403).json({ error: "forbidden" }); return; }
    if (!separate) { res.status(503).json({ error: "billing_store_unavailable" }); return; }
    try { res.json({ usage: await separate.usage(), limits: { userOpenaiKey: limits(config, "user_openai_key"), simProject: limits(config, "sim_project") }, actualProviderChargesVerified: false }); }
    catch { res.status(503).json({ error: "billing_store_unavailable" }); }
  });
  app.post("/api/v1/ai-router/cop/chat", async (req, res) => {
    const userHash = copUser(req, res, config, store);
    if (!userHash) return;
    if (!separate) { res.status(503).json({ error: "billing_store_unavailable" }); return; }
    if (!validCopChatBody(req.body, config.publishedSourceIds ?? [])) { res.status(400).json({ error: "invalid_request" }); return; }
    try { if (!await externalPolicyAllowed(config, store)) { res.status(503).json({ error: "external_processing_disabled" }); return; } }
    catch { res.status(503).json({ error: "policy_unavailable" }); return; }
    if (config.economyModel !== "gpt-6-luna") { res.status(503).json({ error: "model_policy_unavailable" }); return; }
    let key: Awaited<ReturnType<SeparateBilling["getKey"]>>;
    try { key = await separate.getKey(userHash); }
    catch { res.status(503).json({ error: "credential_store_unavailable" }); return; }
    if (!key) { res.status(422).json({ error: "user_key_missing" }); return; }
    const input = copOutboundInput(req.body);
    const maxOutputTokens = req.body.maxOutputTokens ?? 512;
    const reserved = estimateMicrousd((Buffer.byteLength(input, "utf8") + 1024) * 2, maxOutputTokens * 2, 0.2, 1);
    let id: string;
    try { id = await separate.reserve("user_openai_key", userHash, userHash, key.fingerprint, null, "cop_chat", "gpt-6-luna", reserved, limits(config, "user_openai_key")); }
    catch (error) {
      if (error instanceof SeparateBillingError) { res.status(429).json({ error: error.code }); return; }
      res.status(503).json({ error: "billing_store_unavailable" }); return;
    }
    try {
      const result = await callSeparateOpenAI(key.apiKey, "gpt-6-luna", input, maxOutputTokens);
      const estimatedMicrousd = estimateMicrousd(result.inputTokens, result.outputTokens, 0.2, 1);
      await separate.finish(id, "success", result.inputTokens, result.outputTokens, estimatedMicrousd);
      res.json({ requestId: id, billingSource: "user_openai_key", model: "gpt-6-luna", output: result.text,
        usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, estimatedMicrousd, actualProviderChargesVerified: false }, requiresHumanReview: true });
    } catch (error) {
      if (error instanceof ProviderError) {
        try { await separate.finish(id, error.uncertain ? "uncertain" : "failed", undefined, undefined, undefined, error.code); }
        catch { res.status(503).json({ requestId: id, error: "billing_store_unavailable" }); return; }
        res.status(providerStatus(error)).json({ requestId: id, error: error.code }); return;
      }
      res.status(503).json({ requestId: id, error: "billing_store_unavailable" });
    }
  });
  app.post("/api/v1/ai-router/sim/izs-summary", async (req, res) => {
    if (forbidden(res)) return;
    if (res.locals.caller !== "izs") { res.status(403).json({ error: "task_not_allowed" }); return; }
    if (!config.simIzsEnabled) { res.status(503).json({ error: "sim_izs_not_enabled" }); return; }
    if (!separate) { res.status(503).json({ error: "billing_store_unavailable" }); return; }
    const actor = req.header("x-sim-actor") ?? "";
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(actor)) { res.status(401).json({ error: "actor_invalid" }); return; }
    if (!validSimIzsBody(req.body, config.publishedSourceIds ?? [])) { res.status(400).json({ error: "invalid_request" }); return; }
    try { if (!await externalPolicyAllowed(config, store)) { res.status(503).json({ error: "external_processing_disabled" }); return; } }
    catch { res.status(503).json({ error: "policy_unavailable" }); return; }
    if (config.simIzsModel !== "gpt-5.4-mini" || !config.simIzsOpenaiKey) { res.status(503).json({ error: "sim_project_unavailable" }); return; }
    const input = simIzsOutboundInput(req.body);
    const maxOutputTokens = req.body.maxOutputTokens ?? 512;
    const reserved = estimateMicrousd((Buffer.byteLength(input, "utf8") + 1024) * 2, maxOutputTokens * 2, 0.75, 4.5);
    const actorHash = store.hashUser("izs", actor);
    let id: string;
    const fingerprint = createHmac("sha256", config.userHashSecret).update("sim-project-key\0").update(config.simIzsOpenaiKey).digest("hex").slice(0, 16);
    try { id = await separate.reserve("sim_project", "sim_izs_project", actorHash, fingerprint, config.simIzsProjectId ?? null, "sim_izs_summary", "gpt-5.4-mini", reserved, limits(config, "sim_project")); }
    catch (error) {
      if (error instanceof SeparateBillingError) { res.status(429).json({ error: error.code }); return; }
      res.status(503).json({ error: "billing_store_unavailable" }); return;
    }
    try {
      const result = await callSeparateOpenAI(config.simIzsOpenaiKey, "gpt-5.4-mini", input, maxOutputTokens);
      const estimatedMicrousd = estimateMicrousd(result.inputTokens, result.outputTokens, 0.75, 4.5);
      await separate.finish(id, "success", result.inputTokens, result.outputTokens, estimatedMicrousd);
      res.json({ requestId: id, billingSource: "sim_project", model: "gpt-5.4-mini", output: result.text,
        usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, estimatedMicrousd, actualProviderChargesVerified: false }, requiresHumanReview: true });
    } catch (error) {
      if (error instanceof ProviderError) {
        try { await separate.finish(id, error.uncertain ? "uncertain" : "failed", undefined, undefined, undefined, error.code); }
        catch { res.status(503).json({ requestId: id, error: "billing_store_unavailable" }); return; }
        const code = error.code === "user_key_invalid" || error.code === "user_model_unavailable" ? "sim_project_unavailable" : error.code;
        res.status(error.code === "user_key_invalid" || error.code === "user_model_unavailable" ? 503 : providerStatus(error)).json({ requestId: id, error: code }); return;
      }
      res.status(503).json({ requestId: id, error: "billing_store_unavailable" });
    }
  });
}
