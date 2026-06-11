import { aiProviders, createMockScenarioDraft, type AiDraftRequest } from "@csm-sim/ai-assistant";
import { CONTRACT_VERSION, type CanonicalEventEnvelope, type FaultInjection, type Scenario } from "@csm-sim/contracts";
import { createHttpRequestTracingMiddleware } from "@csm-sim/observability";
import { PublisherClient } from "@csm-sim/publisher-client";
import { availableBlocks } from "@csm-sim/simulation-core";
import cors from "cors";
import express, { type Express } from "express";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ApiConfig } from "./config.js";
import { problem } from "./http.js";
import { RuntimeRunner } from "./runtime-runner.js";
import { AuditLogger, createCorsOptions, createSecurityMiddleware } from "./security.js";
import { JsonStore } from "./store.js";
import { createValidators, type Validators } from "./validation.js";

export interface AppContext {
  config: ApiConfig;
  store: JsonStore;
  publisher: PublisherClient;
  runtimeRunner: RuntimeRunner;
  validators: Validators;
  audit: AuditLogger;
}

export async function createApp(config: ApiConfig): Promise<{ app: Express; context: AppContext }> {
  const store = new JsonStore(join(config.dataDir, "sim-store.json"));
  await store.load();

  const publisher = new PublisherClient(
    {
      mode: config.publisherMode,
      mainCopBaseUrl: config.mainCopBaseUrl,
      mainCopBearerToken: config.mainCopBearerToken,
      sourceSystemId: config.sourceSystemId,
      adapterVersion: config.adapterVersion,
      maxRetries: 5
    },
    join(config.dataDir, "publisher-queue.json")
  );
  await publisher.load();

  const validators = createValidators(config.schemaDir);
  const runtimeRunner = new RuntimeRunner(config, store, publisher);
  await runtimeRunner.recover();
  const audit = new AuditLogger(config.dataDir);
  const context: AppContext = { config, store, publisher, runtimeRunner, validators, audit };
  const app = express();
  app.locals.runtimeRunner = runtimeRunner;

  app.use(createHttpRequestTracingMiddleware("csm-sim-api"));
  app.use(cors(createCorsOptions(config)));
  app.use(createSecurityMiddleware(config, audit));
  app.use(express.json({ limit: "2mb" }));

  registerScenarioRoutes(app, context);
  registerRuntimeRoutes(app, context);
  registerFaultRoutes(app, context);
  registerPublisherRoutes(app, context);
  registerAiRoutes(app, context);
  registerHealthRoutes(app, context);
  registerMockCopRoutes(app, context);

  app.use((req, res) => {
    problem(req, res, 404, "NOT_FOUND", "Endpoint not found.");
  });

  return { app, context };
}

function registerScenarioRoutes(app: Express, context: AppContext): void {
  app.get("/api/v1/scenarios", (_req, res) => {
    res.json({ items: context.store.data.scenarios });
  });

  app.post("/api/v1/scenarios", async (req, res) => {
    if (!context.validators.scenario(req.body)) {
      return problem(req, res, 400, "VALIDATION_ERROR", "Scenario does not match schema.", context.validators.issues(context.validators.scenario));
    }
    const budgetIssues = validateScenarioBudget(req.body as Scenario, context.config);
    if (budgetIssues.length > 0) {
      return problem(req, res, 400, "SCENARIO_BUDGET_EXCEEDED", "Scenario exceeds configured simulation budget.", budgetIssues);
    }

    const scenario: Scenario = {
      ...(req.body as Scenario),
      scenarioId: randomUUID(),
      status: "DRAFT",
      metadata: {
        ...(req.body as Scenario).metadata,
        syntheticOnly: true,
        createdAt: new Date().toISOString()
      }
    };
    context.store.data.scenarios.push(scenario);
    await context.store.save();
    res.status(201).json({ scenarioId: scenario.scenarioId, status: scenario.status, createdAt: scenario.metadata?.createdAt });
  });

  app.get("/api/v1/scenarios/:scenarioId", (req, res) => {
    const scenario = findScenario(context, req.params.scenarioId);
    if (!scenario) {
      return problem(req, res, 404, "NOT_FOUND", "Scenario not found.");
    }
    res.json(scenario);
  });

  app.patch("/api/v1/scenarios/:scenarioId", async (req, res) => {
    const index = context.store.data.scenarios.findIndex((scenario) => scenario.scenarioId === req.params.scenarioId);
    if (index < 0) {
      return problem(req, res, 404, "NOT_FOUND", "Scenario not found.");
    }
    const existing = context.store.data.scenarios[index]!;
    const next = { ...existing, ...(req.body as Partial<Scenario>), scenarioId: existing.scenarioId, status: existing.status ?? "DRAFT" } as Scenario;

    if (!context.validators.scenario(next)) {
      return problem(req, res, 400, "VALIDATION_ERROR", "Scenario update does not match schema.", context.validators.issues(context.validators.scenario));
    }
    const budgetIssues = validateScenarioBudget(next, context.config);
    if (budgetIssues.length > 0) {
      return problem(req, res, 400, "SCENARIO_BUDGET_EXCEEDED", "Scenario update exceeds configured simulation budget.", budgetIssues);
    }

    context.store.data.scenarios[index] = next;
    await context.store.save();
    res.json(next);
  });

  app.delete("/api/v1/scenarios/:scenarioId", async (req, res) => {
    const scenario = findScenario(context, req.params.scenarioId);
    if (!scenario) {
      return problem(req, res, 404, "NOT_FOUND", "Scenario not found.");
    }
    if (scenario.status === "RUNNING" || scenario.status === "PAUSED") {
      return problem(req, res, 400, "SCENARIO_RUNNING", "Running scenario cannot be deleted.");
    }
    context.store.data.scenarios = context.store.data.scenarios.filter((item) => item.scenarioId !== req.params.scenarioId);
    await context.store.save();
    res.status(204).send();
  });
}

function registerRuntimeRoutes(app: Express, context: AppContext): void {
  app.post("/api/v1/scenarios/:scenarioId/start", async (req, res) => {
    const scenario = findScenario(context, req.params.scenarioId);
    if (!scenario) {
      return problem(req, res, 404, "NOT_FOUND", "Scenario not found.");
    }
    const budgetIssues = validateScenarioBudget(scenario, context.config);
    if (budgetIssues.length > 0) {
      return problem(req, res, 400, "SCENARIO_BUDGET_EXCEEDED", "Scenario exceeds configured simulation budget.", budgetIssues);
    }
    const runtime = await context.runtimeRunner.start(scenario, req.body);
    res.json(runtime);
  });

  app.post("/api/v1/scenarios/:scenarioId/step", async (req, res) => {
    const scenario = findScenario(context, req.params.scenarioId);
    if (!scenario) {
      return problem(req, res, 404, "NOT_FOUND", "Scenario not found.");
    }
    const runtime = await context.runtimeRunner.step(scenario);
    res.json(runtime);
  });

  for (const action of ["pause", "resume", "stop", "reset"] as const) {
    app.post(`/api/v1/scenarios/:scenarioId/${action}`, async (req, res) => {
      const scenario = findScenario(context, req.params.scenarioId);
      if (!scenario) {
        return problem(req, res, 404, "NOT_FOUND", "Scenario not found.");
      }
      const runtime = await context.runtimeRunner[action](scenario);
      res.json(runtime);
    });
  }

  app.get("/api/v1/runtime/status", (_req, res) => {
    res.json({
      ...context.store.data.runtime,
      queuedEvents: context.publisher.status().queueSize
    });
  });

  app.get("/api/v1/runtime/metrics", (_req, res) => {
    const publisherStatus = context.publisher.status();
    res.json({
      generatedEvents: context.store.data.runtime.generatedEvents,
      publishedEvents: context.store.data.runtime.publishedEvents,
      failedEvents: publisherStatus.deadLetterSize,
      publisherQueueSize: publisherStatus.queueSize,
      activeScenarioRuntime: context.store.data.runtime.state === "RUNNING" ? 1 : 0,
      aiRequestCount: context.store.data.drafts.length,
      aiRejectionCount: context.store.data.drafts.filter((draft) => !draft.policyCheck.allowed).length,
      faultInjectionActiveCount: context.store.data.scenarios.flatMap((scenario) => scenario.faults ?? []).length
    });
  });

  app.get("/api/v1/runtime/blocks", (_req, res) => {
    res.json({ blocks: availableBlocks });
  });

  app.get("/api/v1/runtime/publisher", (_req, res) => {
    res.json(context.publisher.status());
  });
}

function registerFaultRoutes(app: Express, context: AppContext): void {
  app.post("/api/v1/scenarios/:scenarioId/faults", async (req, res) => {
    const scenario = findScenario(context, req.params.scenarioId);
    if (!scenario) {
      return problem(req, res, 404, "NOT_FOUND", "Scenario not found.");
    }
    if (!context.validators.fault(req.body)) {
      return problem(req, res, 400, "VALIDATION_ERROR", "Fault injection does not match schema.", context.validators.issues(context.validators.fault));
    }
    const fault: FaultInjection = { ...(req.body as FaultInjection), faultId: randomUUID() };
    scenario.faults = [...(scenario.faults ?? []), fault];
    await context.store.save();
    res.status(201).json(fault);
  });

  app.get("/api/v1/scenarios/:scenarioId/faults", (req, res) => {
    const scenario = findScenario(context, req.params.scenarioId);
    if (!scenario) {
      return problem(req, res, 404, "NOT_FOUND", "Scenario not found.");
    }
    res.json({ items: scenario.faults ?? [] });
  });

  app.delete("/api/v1/scenarios/:scenarioId/faults/:faultId", async (req, res) => {
    const scenario = findScenario(context, req.params.scenarioId);
    if (!scenario) {
      return problem(req, res, 404, "NOT_FOUND", "Scenario not found.");
    }
    scenario.faults = (scenario.faults ?? []).filter((fault) => fault.faultId !== req.params.faultId);
    await context.store.save();
    res.status(204).send();
  });
}

function registerPublisherRoutes(app: Express, context: AppContext): void {
  app.get("/api/v1/publisher/status", (_req, res) => {
    res.json(context.publisher.status());
  });

  app.post("/api/v1/publisher/test-connection", async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0 && !context.validators.publisherConfig(req.body)) {
      return problem(req, res, 400, "VALIDATION_ERROR", "Publisher config does not match schema.", context.validators.issues(context.validators.publisherConfig));
    }
    res.json(await context.publisher.testConnection());
  });

  app.post("/api/v1/publisher/send-sample", async (req, res) => {
    if (!context.validators.canonicalEvent(req.body)) {
      return problem(req, res, 400, "VALIDATION_ERROR", "Canonical event does not match schema.", context.validators.issues(context.validators.canonicalEvent));
    }
    try {
      const item = await context.publisher.publishEvent(req.body as CanonicalEventEnvelope);
      res.json({
        accepted: item.state === "SENT" || item.state === "DRY_RUN_VALIDATED",
        dryRun: item.state === "DRY_RUN_VALIDATED",
        eventId: item.eventId,
        correlationId: item.event.correlationId
      });
    } catch (error) {
      problem(req, res, 422, "VALIDATION_ERROR", error instanceof Error ? error.message : "Publisher rejected event.");
    }
  });

  app.get("/api/v1/publisher/queue", (req, res) => {
    const queue = context.publisher.listQueue();
    const limit = parseQueryInteger(req.query.limit, 50, 100);
    res.json({ items: queue.slice(0, limit), totalCount: queue.length, limit });
  });

  app.post("/api/v1/publisher/queue/retry", async (req, res) => {
    const affectedCount = await context.publisher.retryQueue(req.body?.queueIds);
    res.json({ accepted: true, affectedCount });
  });

  app.post("/api/v1/publisher/queue/clear", async (_req, res) => {
    const affectedCount = await context.publisher.clearQueue();
    res.json({ accepted: true, affectedCount });
  });

  app.post("/api/v1/publisher/stop", async (_req, res) => {
    await context.publisher.stopPublishing();
    res.json(context.publisher.status());
  });
}

function registerAiRoutes(app: Express, context: AppContext): void {
  app.post("/api/v1/ai/scenario-drafts", async (req, res) => {
    const draft = createMockScenarioDraft(req.body as AiDraftRequest);
    context.store.data.drafts.push(draft);
    await context.store.save();
    res.status(201).json(draft);
  });

  app.get("/api/v1/ai/scenario-drafts/:draftId", (req, res) => {
    const draft = context.store.data.drafts.find((item) => item.draftId === req.params.draftId);
    if (!draft) {
      return problem(req, res, 404, "NOT_FOUND", "AI draft not found.");
    }
    res.json(draft);
  });

  app.post("/api/v1/ai/scenario-drafts/:draftId/validate", (req, res) => {
    const draft = context.store.data.drafts.find((item) => item.draftId === req.params.draftId);
    if (!draft) {
      return problem(req, res, 404, "NOT_FOUND", "AI draft not found.");
    }
    const schemaValid = draft.policyCheck.allowed && context.validators.scenario(draft.scenarioPatch);
    const budgetIssues = schemaValid ? validateScenarioBudget(draft.scenarioPatch as Scenario, context.config) : [];
    const valid = schemaValid && budgetIssues.length === 0;
    res.json({ schemaValid: valid, issues: valid ? [] : [...context.validators.issues(context.validators.scenario), ...budgetIssues] });
  });

  app.post("/api/v1/ai/scenario-drafts/:draftId/accept", async (req, res) => {
    const draft = context.store.data.drafts.find((item) => item.draftId === req.params.draftId);
    if (!draft) {
      return problem(req, res, 404, "NOT_FOUND", "AI draft not found.");
    }
    const schemaValid = context.validators.scenario(draft.scenarioPatch);
    const budgetIssues = schemaValid ? validateScenarioBudget(draft.scenarioPatch as Scenario, context.config) : [];
    if (!draft.policyCheck.allowed || !schemaValid || budgetIssues.length > 0) {
      return problem(req, res, 400, "VALIDATION_ERROR", "AI draft cannot be accepted.", [
        ...context.validators.issues(context.validators.scenario),
        ...budgetIssues
      ]);
    }
    const scenario: Scenario = {
      ...(draft.scenarioPatch as Scenario),
      scenarioId: randomUUID(),
      status: "DRAFT",
      metadata: {
        syntheticOnly: true,
        createdAt: new Date().toISOString(),
        aiDraftId: draft.draftId
      }
    };
    draft.audit = { ...draft.audit, humanReviewStatus: "ACCEPTED", reviewedAt: new Date().toISOString() };
    context.store.data.scenarios.push(scenario);
    await context.store.save();
    res.json({ scenarioId: scenario.scenarioId, status: scenario.status, createdAt: scenario.metadata?.createdAt });
  });

  app.post("/api/v1/ai/scenario-drafts/:draftId/reject", async (req, res) => {
    const draft = context.store.data.drafts.find((item) => item.draftId === req.params.draftId);
    if (!draft) {
      return problem(req, res, 404, "NOT_FOUND", "AI draft not found.");
    }
    draft.audit = { ...draft.audit, humanReviewStatus: "REJECTED", reviewedAt: new Date().toISOString(), reason: req.body?.reason };
    await context.store.save();
    res.json({ draftId: draft.draftId, status: "REJECTED" });
  });

  app.get("/api/v1/ai/providers", (_req, res) => {
    res.json({
      providers: aiProviders.map((provider) =>
        provider.external && !context.config.externalAiAllowed ? { ...provider, enabled: false, healthy: false } : provider
      )
    });
  });

  app.patch("/api/v1/ai/config", async (req, res) => {
    context.store.data.aiConfig = {
      providerMode: req.body?.providerMode ?? context.store.data.aiConfig.providerMode,
      externalProviderAllowed: Boolean(req.body?.externalProviderAllowed)
    };
    await context.store.save();
    res.json({ saved: true });
  });
}

function registerHealthRoutes(app: Express, context: AppContext): void {
  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/health/ready", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/health/dependencies", (_req, res) => {
    res.json({
      status: "ok",
      dependencies: {
        store: "ok",
        publisher: context.publisher.status().publishingEnabled ? "ok" : "publishing_stopped",
        ai: "mock"
      }
    });
  });

  app.get("/metrics", (_req, res) => {
    const publisherStatus = context.publisher.status();
    res.type("text/plain").send(
      [
        `sim_generated_events_total ${context.store.data.runtime.generatedEvents}`,
        `sim_publisher_queue_size ${publisherStatus.queueSize}`,
        `sim_publisher_dead_letter_size ${publisherStatus.deadLetterSize}`,
        `sim_ai_requests_total ${context.store.data.drafts.length}`,
        `sim_ai_rejections_total ${context.store.data.drafts.filter((draft) => !draft.policyCheck.allowed).length}`
      ].join("\n") + "\n"
    );
  });
}

function registerMockCopRoutes(app: Express, context: AppContext): void {
  app.post("/mock-cop/api/v1/ingest/events", (req, res) => {
    const requiredHeaders = ["authorization", "x-source-system-id", "x-idempotency-key", "x-contract-version", "x-correlation-id"];
    const missing = requiredHeaders.filter((header) => !req.header(header));
    if (missing.length > 0) {
      return problem(req, res, 401, "UNAUTHORIZED", "Missing required ingest headers.", missing);
    }
    if (req.header("x-contract-version") !== CONTRACT_VERSION) {
      return problem(req, res, 400, "VALIDATION_ERROR", "Unsupported contract version.");
    }
    if (!context.validators.canonicalEvent(req.body)) {
      return problem(req, res, 422, "VALIDATION_ERROR", "Payload does not match canonical event schema.", context.validators.issues(context.validators.canonicalEvent));
    }
    const event = req.body as CanonicalEventEnvelope;
    res.json({
      accepted: true,
      eventId: event.eventId,
      ingestId: randomUUID(),
      receivedAt: new Date().toISOString(),
      status: "QUEUED",
      correlationId: req.header("x-correlation-id")
    });
  });

  app.post("/mock-cop/api/v1/ingest/batches", (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const invalid = items.filter((item: unknown) => !context.validators.canonicalEvent(item));
    if (invalid.length > 0) {
      return problem(req, res, 422, "VALIDATION_ERROR", "Batch contains invalid event payloads.", [{ invalidCount: invalid.length }]);
    }
    res.json({
      accepted: true,
      batchId: randomUUID(),
      acceptedCount: items.length,
      receivedAt: new Date().toISOString(),
      status: "QUEUED",
      correlationId: req.header("x-correlation-id") ?? randomUUID()
    });
  });
}

function findScenario(context: AppContext, scenarioId: string | undefined): Scenario | undefined {
  return context.store.data.scenarios.find((scenario) => scenario.scenarioId === scenarioId);
}

function validateScenarioBudget(scenario: Scenario, config: ApiConfig): unknown[] {
  const maxBlocks = config.scenarioMaxBlocks ?? 24;
  const maxActiveObjects = config.scenarioMaxActiveObjects ?? 1000;
  const maxEventsPerSecond = config.scenarioMaxEventsPerSecond ?? 1000;
  const enabledBlocks = scenario.blocks.filter((block) => block.enabled);
  const activeObjects = enabledBlocks.reduce((sum, block) => sum + block.objectCount, 0);
  const eventsPerSecond = enabledBlocks.reduce((sum, block) => sum + block.objectCount * block.updateRateHz, 0);
  const issues: unknown[] = [];

  if (scenario.blocks.length > maxBlocks) {
    issues.push({ path: "/blocks", message: "Too many scenario blocks.", limit: maxBlocks, actual: scenario.blocks.length });
  }
  if (activeObjects > maxActiveObjects) {
    issues.push({ path: "/blocks", message: "Too many active synthetic objects.", limit: maxActiveObjects, actual: activeObjects });
  }
  if (eventsPerSecond > maxEventsPerSecond) {
    issues.push({ path: "/blocks", message: "Scenario event rate is too high.", limit: maxEventsPerSecond, actual: eventsPerSecond });
  }

  return issues;
}

function parseQueryInteger(value: unknown, fallback: number, max: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.trunc(parsed)));
}
