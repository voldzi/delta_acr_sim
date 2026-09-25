import { timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { BudgetError, BudgetStore, type RouterPolicy } from "./budget.js";
import { copModelPrompt, validCopContext } from "./cop-context.js";
import type { Config } from "./config.js";
import { chooseRoute, estimateMicrousd, estimateTokens, taskAllowsDataClass, type DataClass, type ModelPreference, type TaskType } from "./routing.js";

interface GenerateBody {
  taskType: TaskType;
  dataClass: DataClass;
  preference?: ModelPreference;
  prompt: string;
  userId: string;
  allowExternal?: boolean;
  allowPaidEscalation?: boolean;
  maxOutputTokens?: number;
  copContext?: Record<string, unknown>;
}

function bearer(req: Request): string {
  return /^Bearer (.+)$/iu.exec(req.header("authorization") ?? "")?.[1] ?? "";
}
function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function caller(req: Request, config: Config): "cop" | "sim" | "admin" | null {
  const token = bearer(req);
  if (!token) return null;
  if (secureEqual(token, config.adminToken)) return "admin";
  if (secureEqual(token, config.copToken)) return "cop";
  if (secureEqual(token, config.simToken)) return "sim";
  return null;
}
export function validBody(value: unknown): value is GenerateBody {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const allowedKeys = new Set(["taskType", "dataClass", "preference", "prompt", "userId", "allowExternal", "allowPaidEscalation", "maxOutputTokens", "copContext"]);
  if (Object.keys(v).some((key) => !allowedKeys.has(key))) return false;
  return (
    ["cop_chat", "source_health", "sim_scenario"].includes(v.taskType as string) &&
    ["synthetic", "public_aggregate", "internal"].includes(v.dataClass as string) &&
    [undefined, "auto", "local", "external"].includes(v.preference as string | undefined) &&
    typeof v.prompt === "string" &&
    v.prompt.length > 0 &&
    v.prompt.length <= 12_000 &&
    typeof v.userId === "string" &&
    v.userId.length > 0 &&
    v.userId.length <= 200 &&
    (v.taskType !== "cop_chat" || (/^[A-Za-z0-9_-]{8,128}$/u.test(v.userId) && v.prompt.length <= 1200 && validCopContext(v.copContext, v.dataClass as DataClass))) &&
    (v.taskType === "cop_chat" || v.copContext === undefined) &&
    [undefined, true, false].includes(v.allowExternal as boolean | undefined) &&
    [undefined, true, false].includes(v.allowPaidEscalation as boolean | undefined) &&
    (v.maxOutputTokens === undefined ||
      (typeof v.maxOutputTokens === "number" && Number.isInteger(v.maxOutputTokens) && v.maxOutputTokens >= 1 && v.maxOutputTokens <= 1024))
  );
}

interface ModelResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

async function callOpenAI(config: Config, model: string, prompt: string, maxOutputTokens: number): Promise<ModelResult> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${config.openaiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: model === config.economyModel ? "none" : "low" },
      instructions:
        "You are an assistive civil situation-map analyst. Do not make operational decisions. Explain uncertainty and data age. Do not provide targeting or tactical combat guidance.",
      input: prompt,
      max_output_tokens: maxOutputTokens
    }),
    signal: AbortSignal.timeout(25_000)
  });
  if (!response.ok) throw new Error(`openai_http_${response.status}`);
  const data = (await response.json()) as {
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text =
    data.output
      ?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text ?? "")
      .join("\n")
      .trim() ?? "";
  if (!text || !Number.isInteger(data.usage?.input_tokens) || !Number.isInteger(data.usage?.output_tokens)) throw new Error("provider_response_incomplete");
  return { text, inputTokens: data.usage!.input_tokens!, outputTokens: data.usage!.output_tokens! };
}

async function callLocal(config: Config, prompt: string, maxOutputTokens: number): Promise<ModelResult> {
  const url = new URL("/api/generate", config.localUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.localModel, stream: false, prompt, options: { num_predict: maxOutputTokens } }),
    signal: AbortSignal.timeout(25_000)
  });
  if (!response.ok) throw new Error(`local_http_${response.status}`);
  const data = (await response.json()) as { response?: string; prompt_eval_count?: number; eval_count?: number };
  if (!data.response?.trim()) throw new Error("provider_response_incomplete");
  return {
    text: data.response.trim(),
    inputTokens: data.prompt_eval_count ?? estimateTokens(prompt),
    outputTokens: data.eval_count ?? estimateTokens(data.response)
  };
}

export function createApp(config: Config, store: BudgetStore) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    try {
      await store.pool.query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.use("/api/v1/ai-router", (req, res, next) => {
    const identity = caller(req, config);
    if (!identity) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.locals.caller = identity;
    next();
  });
  app.get("/api/v1/ai-router/models", async (_req, res) => {
    try {
      const activePolicy = await store.policy();
      res.json({
        models: [
          { tier: "local_fast", model: config.localModel || null, enabled: Boolean(config.localUrl && config.localModel), external: false },
          {
            tier: "external_economy",
            model: config.economyModel,
            enabled: config.externalEnabled && activePolicy.externalAllowed && Boolean(config.openaiKey),
            external: true
          },
          {
            tier: "external_advanced",
            model: config.advancedModel,
            enabled: config.externalEnabled && config.advancedEnabled && activePolicy.advancedAllowed && Boolean(config.openaiKey),
            external: true
          }
        ],
        policy: { advancedRequiresExplicitApproval: true, internalDataLocalOnly: true, copChatExternalRequiresApproval: true, copChatExternalEconomyOnly: true }
      });
    } catch {
      res.status(503).json({ error: "policy_unavailable" });
    }
  });
  app.get("/api/v1/ai-router/policy", async (_req, res) => {
    try {
      res.json(await store.policy());
    } catch {
      res.status(503).json({ error: "policy_unavailable" });
    }
  });
  app.patch("/api/v1/ai-router/policy", async (req, res) => {
    if (res.locals.caller !== "admin") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const policy = req.body as RouterPolicy;
    if (
      !policy ||
      typeof policy.externalAllowed !== "boolean" ||
      typeof policy.advancedAllowed !== "boolean" ||
      !policy.limits ||
      !Number.isSafeInteger(policy.limits.dailyMicrousd) ||
      !Number.isSafeInteger(policy.limits.monthlyMicrousd) ||
      !Number.isSafeInteger(policy.limits.perUserDailyRequests)
    ) {
      res.status(400).json({ error: "invalid_policy" });
      return;
    }
    if ((policy.externalAllowed && (!config.externalEnabled || !config.openaiKey)) || (policy.advancedAllowed && !config.advancedEnabled)) {
      res.status(400).json({ error: "environment_cap_disabled" });
      return;
    }
    try {
      res.json(await store.updatePolicy(policy));
    } catch (error) {
      if (error instanceof BudgetError) {
        res.status(400).json({ error: error.code });
        return;
      }
      res.status(503).json({ error: "policy_unavailable" });
    }
  });
  app.get("/api/v1/ai-router/usage", async (_req, res) => {
    try {
      res.json(await store.usage());
    } catch {
      res.status(503).json({ error: "usage_unavailable" });
    }
  });
  app.post("/api/v1/ai-router/generate", async (req, res) => {
    if (!validBody(req.body)) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const body = req.body;
    const identity = res.locals.caller as string;
    if (identity === "admin" || (identity === "cop" && body.taskType === "sim_scenario") || (identity === "sim" && body.taskType !== "sim_scenario")) {
      res.status(403).json({ error: "task_not_allowed" });
      return;
    }
    if (!taskAllowsDataClass(body.taskType, body.dataClass)) {
      res.status(400).json({ error: "data_class_not_allowed" });
      return;
    }
    if (body.taskType === "cop_chat" && body.allowExternal === true && body.dataClass === "internal") {
      res.status(400).json({ error: "internal_external_forbidden" });
      return;
    }
    if (body.taskType === "cop_chat" && body.preference === "external" && body.allowExternal !== true) {
      res.status(400).json({ error: "external_processing_not_approved" });
      return;
    }
    if (body.taskType === "cop_chat" && body.allowPaidEscalation === true) {
      res.status(400).json({ error: "cop_paid_escalation_forbidden" });
      return;
    }
    let decision;
    try {
      const activePolicy = await store.policy();
      decision = chooseRoute(
        {
          taskType: body.taskType,
          dataClass: body.dataClass,
          preference: body.preference ?? "auto",
          prompt: body.prompt,
          allowExternal: body.allowExternal === true,
          allowPaidEscalation: body.taskType !== "cop_chat" && body.allowPaidEscalation === true
        },
        {
          localAvailable: Boolean(config.localUrl && config.localModel),
          externalAvailable: config.externalEnabled && activePolicy.externalAllowed && Boolean(config.openaiKey),
          advancedAvailable: config.externalEnabled && config.advancedEnabled && activePolicy.advancedAllowed && Boolean(config.openaiKey),
          externalEnabled: config.externalEnabled && activePolicy.externalAllowed
        }
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      res.status(503).json({ error: ["local_model_unavailable", "external_model_unavailable", "no_model_available"].includes(code) ? code : "policy_unavailable" });
      return;
    }
    const maxOutputTokens = body.maxOutputTokens ?? 512;
    const model = decision.tier === "local_fast" ? config.localModel : decision.tier === "external_advanced" ? config.advancedModel : config.economyModel;
    const modelPrompt = body.taskType === "cop_chat" ? copModelPrompt(body.prompt, body.copContext!) : body.prompt;
    // Conservative reservation at 2x published standard text-token rates.
    const inputRate = decision.tier === "external_advanced" ? 4 : decision.tier === "external_economy" ? 0.2 : 0;
    const outputRate = decision.tier === "external_advanced" ? 20 : decision.tier === "external_economy" ? 1 : 0;
    // UTF-8 bytes plus fixed instruction overhead is a conservative upper
    // bound for text tokenization, including non-ASCII Czech input.
    const reservedMicrousd = estimateMicrousd(Buffer.byteLength(modelPrompt, "utf8") + 1024, maxOutputTokens, inputRate, outputRate);
    let id: string;
    try {
      id = await store.reserve(identity, body.userId, body.taskType, model, decision.reason, decision.difficulty, decision.tier, reservedMicrousd);
    } catch (error) {
      if (error instanceof BudgetError) {
        res.status(429).json({ error: error.code });
        return;
      }
      res.status(503).json({ error: "budget_store_unavailable" });
      return;
    }
    let result: ModelResult;
    try {
      result = decision.tier === "local_fast" ? await callLocal(config, modelPrompt, maxOutputTokens) : await callOpenAI(config, model, modelPrompt, maxOutputTokens);
    } catch {
      await store.finish(id, "failed").catch(() => undefined);
      res.status(503).json({ requestId: id, error: "model_unavailable" });
      return;
    }
    const chargedMicrousd = estimateMicrousd(result.inputTokens, result.outputTokens, inputRate, outputRate);
    try {
      await store.finish(id, "success", result.inputTokens, result.outputTokens, chargedMicrousd);
    } catch {
      res.status(503).json({ requestId: id, error: "budget_store_unavailable" });
      return;
    }
    res.json({
      requestId: id,
      model,
      tier: decision.tier,
      routingReason: decision.reason,
      difficulty: decision.difficulty,
      output: result.text,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, estimatedMicrousd: chargedMicrousd },
      requiresHumanReview: true
    });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
    res.status(400).json({ error: error instanceof SyntaxError ? "invalid_json" : "invalid_request" });
  });
  return app;
}
