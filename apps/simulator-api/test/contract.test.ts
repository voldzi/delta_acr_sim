import { countActiveScenarioObjects, generateScenarioEvents } from "@delta-acr/simulation-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";

const scenarioPayload = {
  name: "Air situation basic",
  description: "Synthetic mixed air situation for COP ingest test",
  area: {
    type: "BBOX",
    bbox: [14.0, 49.8, 15.0, 50.3]
  },
  durationSeconds: 900,
  seed: 123456,
  blocks: [
    {
      blockId: "air-sim-aircraft",
      enabled: true,
      objectCount: 2,
      updateRateHz: 1,
      patterns: ["DIRECT", "PATROL"]
    }
  ],
  faults: []
};

const highDensityScenarioPayload = {
  name: "High density air situation",
  description: "Synthetic high-density air situation for COP ingest load test",
  area: {
    type: "BBOX",
    bbox: [13.85, 49.65, 15.35, 50.45]
  },
  durationSeconds: 1800,
  seed: 20260519,
  blocks: [
    {
      blockId: "air-sim-aircraft",
      enabled: true,
      objectCount: 120,
      updateRateHz: 0.5,
      patterns: ["DIRECT", "PATROL"],
      parameters: { affiliations: ["FRIEND", "HOSTILE", "ASSUMED_FRIEND", "SUSPECT"] }
    },
    {
      blockId: "air-sim-uav",
      enabled: true,
      objectCount: 160,
      updateRateHz: 0.5,
      patterns: ["LOITER", "SURVEY"],
      parameters: { affiliations: ["HOSTILE", "SUSPECT", "FRIEND", "UNKNOWN"] }
    },
    {
      blockId: "air-sim-missile",
      enabled: true,
      objectCount: 20,
      updateRateHz: 0.2,
      patterns: ["SHORT_LIVED_TRACK"],
      parameters: { affiliations: ["HOSTILE"] }
    }
  ],
  faults: []
};

describe("SIM API contract baseline", () => {
  let dataDir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let context: Awaited<ReturnType<typeof createApp>>["context"];
  let config: ApiConfig;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "delta-acr-sim-"));
    config = {
      port: 0,
      dataDir,
      schemaDir: resolve("../../docs/api/schemas"),
      publisherMode: "DRY_RUN",
      sourceSystemId: "sim-air-situation-001",
      adapterVersion: "0.1.0",
      mainCopBaseUrl: "http://localhost/mock-cop",
      externalAiAllowed: false
    };
    ({ app, context } = await createApp(config));
  });

  afterEach(async () => {
    context.runtimeRunner.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("exposes health endpoints", async () => {
    const response = await request(app).get("/health/live").expect(200);
    expect(response.body.status).toBe("ok");
  });

  it("creates and starts a synthetic scenario in dry-run mode", async () => {
    const created = await request(app).post("/api/v1/scenarios").send(scenarioPayload).expect(201);
    expect(created.body.scenarioId).toBeTruthy();

    const runtime = await request(app).post(`/api/v1/scenarios/${created.body.scenarioId}/start`).send({ dryRun: true }).expect(200);
    expect(runtime.body.state).toBe("RUNNING");
    expect(runtime.body.generatedEvents).toBeGreaterThan(0);
    expect(runtime.body.tick).toBe(0);
    expect(runtime.body.activeObjects).toBe(2);
    expect(runtime.body.queuedEvents).toBe(0);

    const queue = await request(app).get("/api/v1/publisher/queue").expect(200);
    expect(queue.body.totalCount).toBe(2);
    expect(queue.body.limit).toBe(50);
    expect(queue.body.items[0].state).toBe("DRY_RUN_VALIDATED");
    expect(queue.body.items[0].event.classification.handlingCaveats).toContain("SYNTHETIC");

    const limitedQueue = await request(app).get("/api/v1/publisher/queue?limit=1").expect(200);
    expect(limitedQueue.body.totalCount).toBe(2);
    expect(limitedQueue.body.items).toHaveLength(1);

    const publisher = await request(app).get("/api/v1/runtime/publisher").expect(200);
    expect(publisher.body.queueSize).toBe(0);
  });

  it("scopes published event counts to the active runtime", async () => {
    const [sample] = generateScenarioEvents(
      { ...scenarioPayload, scenarioId: "00000000-0000-4000-8000-000000000001" },
      { sourceSystemId: "sim-air-situation-001", adapterVersion: "0.1.0" }
    );
    await request(app).post("/api/v1/publisher/send-sample").send(sample).expect(200);

    const created = await request(app).post("/api/v1/scenarios").send(scenarioPayload).expect(201);
    const runtime = await request(app).post(`/api/v1/scenarios/${created.body.scenarioId}/start`).send({}).expect(200);

    expect(runtime.body.generatedEvents).toBe(2);
    expect(runtime.body.publishedEvents).toBe(2);

    const status = await request(app).get("/api/v1/runtime/status").expect(200);
    expect(status.body.publishedEvents).toBe(2);
  });

  it("recovers a running runtime after API restart", async () => {
    const created = await request(app).post("/api/v1/scenarios").send(scenarioPayload).expect(201);
    await request(app).post(`/api/v1/scenarios/${created.body.scenarioId}/start`).send({}).expect(200);
    context.store.data.runtime.publishedEvents = 999;
    await context.store.save();
    context.runtimeRunner.dispose();

    ({ app, context } = await createApp(config));
    const status = await request(app).get("/api/v1/runtime/status").expect(200);

    expect(status.body.state).toBe("RUNNING");
    expect(status.body.scenarioId).toBe(created.body.scenarioId);
    expect(status.body.generatedEvents).toBe(2);
    expect(status.body.publishedEvents).toBe(2);
  });

  it("generates stable moving tracks across ticks", () => {
    const scenario = { ...scenarioPayload, scenarioId: "00000000-0000-4000-8000-000000000001" };
    const [created] = generateScenarioEvents(scenario, {
      sourceSystemId: "sim-air-situation-001",
      adapterVersion: "0.1.0",
      tick: 0,
      elapsedSeconds: 0
    });
    const [updated] = generateScenarioEvents(scenario, {
      sourceSystemId: "sim-air-situation-001",
      adapterVersion: "0.1.0",
      tick: 1,
      elapsedSeconds: 1
    });

    expect(created.eventType).toBe("track.created");
    expect(updated.eventType).toBe("track.updated");
    expect(updated.payload.objectId).toBe(created.payload.objectId);
    expect(updated.geo?.lat).not.toBe(created.geo?.lat);
    expect(updated.geo?.lon).not.toBe(created.geo?.lon);
  });

  it("generates COP-compatible own and foreign affiliations", () => {
    const events = generateScenarioEvents(
      { ...scenarioPayload, scenarioId: "00000000-0000-4000-8000-000000000001" },
      { sourceSystemId: "sim-air-situation-001", adapterVersion: "0.1.0" }
    );
    const affiliations = events.map((event) => event.payload.affiliation);

    expect(affiliations).toContain("FRIEND");
    expect(affiliations).toContain("HOSTILE");
  });

  it("generates realistic speed envelopes by object type", () => {
    const events = generateScenarioEvents(
      { ...highDensityScenarioPayload, scenarioId: "00000000-0000-4000-8000-000000000002" },
      { sourceSystemId: "sim-air-situation-001", adapterVersion: "0.1.0" }
    );

    expect(events.filter((event) => event.payload.objectType === "AIRCRAFT")).toHaveLength(120);
    expect(events.filter((event) => event.payload.objectType === "UAV")).toHaveLength(160);
    expect(events.filter((event) => event.payload.objectType === "MISSILE_TRACK")).toHaveLength(20);

    for (const event of events) {
      const speedMps = event.payload.speedMps ?? 0;
      if (event.payload.objectType === "AIRCRAFT") {
        expect(speedMps).toBeGreaterThanOrEqual(130);
        expect(speedMps).toBeLessThanOrEqual(260);
      }
      if (event.payload.objectType === "UAV") {
        expect(speedMps).toBeGreaterThanOrEqual(22);
        expect(speedMps).toBeLessThanOrEqual(75);
      }
      if (event.payload.objectType === "MISSILE_TRACK") {
        expect(speedMps).toBeGreaterThanOrEqual(250);
        expect(speedMps).toBeLessThanOrEqual(900);
      }
    }
  });

  it("starts high-density scenarios with hundreds of active synthetic objects", async () => {
    const created = await request(app).post("/api/v1/scenarios").send(highDensityScenarioPayload).expect(201);
    const runtime = await request(app).post(`/api/v1/scenarios/${created.body.scenarioId}/start`).send({ dryRun: true }).expect(200);

    expect(runtime.body.generatedEvents).toBe(300);
    expect(runtime.body.activeObjects).toBe(300);
    expect(countActiveScenarioObjects({ ...highDensityScenarioPayload, scenarioId: created.body.scenarioId })).toBe(300);

    const queue = await request(app).get("/api/v1/publisher/queue?limit=5").expect(200);
    expect(queue.body.totalCount).toBe(300);
    expect(queue.body.items).toHaveLength(5);
  });

  it("rejects a canonical event without synthetic marking", async () => {
    const [event] = generateScenarioEvents(
      { ...scenarioPayload, scenarioId: "00000000-0000-4000-8000-000000000001" },
      { sourceSystemId: "sim-air-situation-001", adapterVersion: "0.1.0" }
    );
    const unsafeEvent = {
      ...event,
      classification: { ...event.classification, handlingCaveats: [] }
    };

    const response = await request(app).post("/api/v1/publisher/send-sample").send(unsafeEvent).expect(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("mock COP endpoint enforces ingest headers and schema", async () => {
    const [event] = generateScenarioEvents(
      { ...scenarioPayload, scenarioId: "00000000-0000-4000-8000-000000000001" },
      { sourceSystemId: "sim-air-situation-001", adapterVersion: "0.1.0" }
    );

    await request(app).post("/mock-cop/api/v1/ingest/events").send(event).expect(401);

    const response = await request(app)
      .post("/mock-cop/api/v1/ingest/events")
      .set("Authorization", "Bearer test")
      .set("X-Source-System-Id", "sim-air-situation-001")
      .set("X-Idempotency-Key", event.eventId)
      .set("X-Contract-Version", "cop-ingest-v1")
      .set("X-Correlation-Id", event.correlationId)
      .send(event)
      .expect(200);

    expect(response.body.accepted).toBe(true);
    expect(response.body.eventId).toBe(event.eventId);
  });

  it("AI draft workflow rejects prohibited requests and accepts synthetic drafts", async () => {
    const rejected = await request(app)
      .post("/api/v1/ai/scenario-drafts")
      .send({
        prompt: "Plan a weapon attack target selection workflow.",
        purpose: "DEMO",
        allowedBlocks: ["air-sim-aircraft"],
        limits: { maxObjects: 10, maxDurationSeconds: 300, externalProviderAllowed: false },
        providerPreference: "mock"
      })
      .expect(201);
    expect(rejected.body.policyCheck.allowed).toBe(false);

    const draft = await request(app)
      .post("/api/v1/ai/scenario-drafts")
      .send({
        prompt: "Create a synthetic latency test with aircraft and UAV tracks.",
        purpose: "LATENCY_TEST",
        allowedBlocks: ["air-sim-aircraft", "air-sim-uav"],
        limits: { maxObjects: 20, maxDurationSeconds: 900, externalProviderAllowed: false },
        providerPreference: "mock"
      })
      .expect(201);

    expect(draft.body.policyCheck.allowed).toBe(true);
    const accepted = await request(app).post(`/api/v1/ai/scenario-drafts/${draft.body.draftId}/accept`).send({}).expect(200);
    expect(accepted.body.scenarioId).toBeTruthy();
  });
});
