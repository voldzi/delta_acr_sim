import { countActiveScenarioObjects, generateScenarioEvents } from "@csm-sim/simulation-core";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";
import { clearJwksCacheForTests } from "../src/security.js";

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

const trajectoryScenarioPayload = {
  name: "Continuous trajectory validation",
  description: "Synthetic scenario used to verify that COP history polylines do not contain position jumps.",
  area: {
    type: "BBOX",
    bbox: [14.0, 49.8, 14.08, 49.86]
  },
  durationSeconds: 360,
  seed: 20260520,
  blocks: [
    {
      blockId: "air-sim-aircraft",
      enabled: true,
      objectCount: 2,
      updateRateHz: 1,
      patterns: ["DIRECT", "PATROL"]
    },
    {
      blockId: "air-sim-uav",
      enabled: true,
      objectCount: 2,
      updateRateHz: 1,
      patterns: ["LOITER", "SURVEY"]
    },
    {
      blockId: "ground-sim-friendly",
      enabled: true,
      objectCount: 1,
      updateRateHz: 1,
      patterns: ["DIRECT"]
    }
  ],
  faults: []
};

const ukraineAirDefenseScenarioPayload = {
  name: "Ukraine Air Defense Demo 2026-05-13",
  description: "Synthetic non-operational paired intercept demonstration over Ukraine.",
  area: {
    type: "BBOX",
    bbox: [22.0, 44.2, 40.4, 52.5]
  },
  durationSeconds: 5700,
  seed: 20260513,
  blocks: [
    {
      blockId: "air-sim-uav",
      enabled: true,
      objectCount: 10,
      updateRateHz: 1,
      patterns: ["DIRECT"],
      parameters: {
        objectIdPrefix: "HOSTILE_UAV",
        routeModel: "UKRAINE_AIR_DEFENSE_DEMO",
        engagementRole: "HOSTILE_INBOUND",
        engagementFamily: "uav",
        pairedObjectIdPrefix: "BLUE_INTERCEPTOR_UAV",
        affiliations: ["HOSTILE"]
      }
    },
    {
      blockId: "air-sim-uav",
      enabled: true,
      objectCount: 9,
      updateRateHz: 1,
      patterns: ["DIRECT"],
      parameters: {
        objectIdPrefix: "BLUE_INTERCEPTOR_UAV",
        routeModel: "UKRAINE_AIR_DEFENSE_DEMO",
        engagementRole: "FRIEND_INTERCEPTOR",
        engagementFamily: "uav",
        pairedObjectIdPrefix: "HOSTILE_UAV",
        affiliations: ["FRIEND"]
      }
    }
  ],
  faults: []
};

const ukraineFullDemoScenarioPayload = {
  ...ukraineAirDefenseScenarioPayload,
  blocks: [
    { ...ukraineAirDefenseScenarioPayload.blocks[0], objectCount: 72 },
    {
      blockId: "air-sim-missile",
      enabled: true,
      objectCount: 18,
      updateRateHz: 1,
      patterns: ["SHORT_LIVED_TRACK"],
      parameters: {
        objectIdPrefix: "HOSTILE_MSL",
        routeModel: "UKRAINE_AIR_DEFENSE_DEMO",
        engagementRole: "HOSTILE_INBOUND",
        engagementFamily: "missile",
        pairedObjectIdPrefix: "BLUE_INTERCEPTOR_MSL",
        affiliations: ["HOSTILE"]
      }
    },
    { ...ukraineAirDefenseScenarioPayload.blocks[1], objectCount: 65 },
    {
      blockId: "air-sim-missile",
      enabled: true,
      objectCount: 16,
      updateRateHz: 1,
      patterns: ["SHORT_LIVED_TRACK"],
      parameters: {
        objectIdPrefix: "BLUE_INTERCEPTOR_MSL",
        routeModel: "UKRAINE_AIR_DEFENSE_DEMO",
        engagementRole: "FRIEND_INTERCEPTOR",
        engagementFamily: "missile",
        pairedObjectIdPrefix: "HOSTILE_MSL",
        affiliations: ["FRIEND"]
      }
    }
  ]
};

function testConfig(dataDir: string, overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    port: 0,
    dataDir,
    schemaDir: resolve("../../docs/api/schemas"),
    publisherMode: "DRY_RUN",
    sourceSystemId: "sim-air-situation-001",
    adapterVersion: "0.1.0",
    mainCopBaseUrl: "http://localhost/mock-cop",
    externalAiAllowed: false,
    ...overrides
  };
}

describe("SIM API contract baseline", () => {
  let dataDir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let context: Awaited<ReturnType<typeof createApp>>["context"];
  let config: ApiConfig;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "csm-sim-"));
    config = testConfig(dataDir);
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

  it("generates paired synthetic intercepts over Ukraine", () => {
    const scenario = { ...ukraineAirDefenseScenarioPayload, scenarioId: "00000000-0000-4000-8000-000000000004" };
    const initialEvents = generateScenarioEvents(scenario, {
      sourceSystemId: "sim-air-situation-001",
      adapterVersion: "0.1.0",
      tick: 0,
      elapsedSeconds: 0,
      tickIntervalSeconds: 1
    });

    expect(initialEvents).toHaveLength(19);
    expect(new Set(initialEvents.map((event) => event.payload.objectId)).size).toBe(19);
    expect(initialEvents.filter((event) => event.payload.affiliation === "HOSTILE")).toHaveLength(10);
    expect(initialEvents.filter((event) => event.payload.affiliation === "FRIEND")).toHaveLength(9);
    expect(initialEvents.find((event) => event.payload.objectId === "HOSTILE_UAV-0010")?.payload.attributes?.terminalMode).toBe("TRANSIT");

    const terminalEvents = generateScenarioEvents(scenario, {
      sourceSystemId: "sim-air-situation-001",
      adapterVersion: "0.1.0",
      tick: 1220,
      elapsedSeconds: 1220,
      tickIntervalSeconds: 1
    });
    const hostile = terminalEvents.find((event) => event.payload.objectId === "HOSTILE_UAV-0001");
    const interceptor = terminalEvents.find((event) => event.payload.objectId === "BLUE_INTERCEPTOR_UAV-0001");

    expect(hostile?.eventType).toBe("track.lost");
    expect(interceptor?.eventType).toBe("track.lost");
    expect(hostile?.payload.attributes?.pairedObjectId).toBe("BLUE_INTERCEPTOR_UAV-0001");
    expect(interceptor?.payload.attributes?.pairedObjectId).toBe("HOSTILE_UAV-0001");
    expect(hostile?.geo?.lat).toBe(interceptor?.geo?.lat);
    expect(hostile?.geo?.lon).toBe(interceptor?.geo?.lon);
  });

  it("keeps generated historical positions kinematically continuous", () => {
    const scenario = { ...trajectoryScenarioPayload, scenarioId: "00000000-0000-4000-8000-000000000003" };
    const previousByObjectId = new Map<string, NonNullable<ReturnType<typeof generateScenarioEvents>[number]["geo"]>>();

    for (let tick = 0; tick <= 240; tick += 1) {
      const events = generateScenarioEvents(scenario, {
        sourceSystemId: "sim-air-situation-001",
        adapterVersion: "0.1.0",
        tick,
        elapsedSeconds: tick,
        tickIntervalSeconds: 1
      });

      expect(events).toHaveLength(5);

      for (const event of events) {
        expect(event.geo?.lat).toBeTypeOf("number");
        expect(event.geo?.lon).toBeTypeOf("number");
        expectPositionInsideBbox(event.geo!, trajectoryScenarioPayload.area.bbox);

        const previous = previousByObjectId.get(event.payload.objectId);
        if (previous) {
          const displacementM = distanceMeters(previous, event.geo!);
          const expectedMaxM = (event.payload.speedMps ?? 0) * 1.15 + 10;
          expect(displacementM).toBeLessThanOrEqual(expectedMaxM);
        }
        previousByObjectId.set(event.payload.objectId, event.geo!);
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

  it("starts the Ukraine air-defense demo within runtime budgets", async () => {
    const created = await request(app).post("/api/v1/scenarios").send(ukraineFullDemoScenarioPayload).expect(201);
    const runtime = await request(app).post(`/api/v1/scenarios/${created.body.scenarioId}/start`).send({ dryRun: true }).expect(200);

    expect(runtime.body.generatedEvents).toBe(171);
    expect(runtime.body.activeObjects).toBe(171);
    expect(countActiveScenarioObjects({ ...ukraineFullDemoScenarioPayload, scenarioId: created.body.scenarioId })).toBe(171);
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

describe("SIM API security controls", () => {
  let dataDir = "";
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let context: Awaited<ReturnType<typeof createApp>>["context"] | undefined;

  afterEach(async () => {
    context?.runtimeRunner.dispose();
    clearJwksCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("requires bearer auth and the right role for protected SIM routes", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "csm-sim-sec-"));
    ({ app, context } = await createApp(
      testConfig(dataDir, {
        apiAuthRequired: true,
        apiPrincipals: [
          { actor: "viewer", token: "viewer-token", roles: ["SIM_VIEWER"] },
          { actor: "operator", token: "operator-token", roles: ["SIM_OPERATOR", "SIM_VIEWER"] }
        ]
      })
    ));

    await request(app).post("/api/v1/scenarios").send(scenarioPayload).expect(401);
    await request(app).post("/api/v1/scenarios").set("authorization", "Bearer viewer-token").send(scenarioPayload).expect(403);

    const created = await request(app).post("/api/v1/scenarios").set("authorization", "Bearer operator-token").send(scenarioPayload).expect(201);
    expect(created.body.scenarioId).toBeTruthy();

    const listed = await request(app).get("/api/v1/scenarios").set("authorization", "Bearer viewer-token").expect(200);
    expect(listed.body.items).toHaveLength(1);

    const auditLog = await readFile(join(dataDir, "sim-audit.jsonl"), "utf8");
    expect(auditLog).toContain("auth.failure");
    expect(auditLog).toContain("auth.forbidden");
  });

  it("allows configured public read-only dashboard routes without exposing mutations", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "csm-sim-sec-"));
    ({ app, context } = await createApp(
      testConfig(dataDir, {
        apiAuthRequired: true,
        apiPublicRead: true,
        apiPrincipals: [{ actor: "operator", token: "operator-token", roles: ["SIM_OPERATOR", "SIM_VIEWER"] }]
      })
    ));

    await request(app).get("/api/v1/scenarios").expect(200);
    await request(app).get("/api/v1/runtime/status").expect(200);
    await request(app).get("/api/v1/runtime/blocks").expect(200);
    await request(app).get("/api/v1/runtime/publisher").expect(200);
    await request(app).get("/api/v1/publisher/queue").expect(401);
    await request(app).post("/api/v1/scenarios").send(scenarioPayload).expect(401);
    await request(app).post("/api/v1/scenarios").set("authorization", "Bearer operator-token").send(scenarioPayload).expect(201);
  });

  it("accepts Keycloak OIDC operator tokens in hybrid mode", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "csm-sim-sec-"));
    const issuer = "https://login.zeleznalady.cz/realms/cop";
    const keyId = "sim-test-key";
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicJwk = {
      ...publicKey.export({ format: "jwk" }),
      alg: "RS256",
      kid: keyId,
      use: "sig"
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ keys: [publicJwk] })));
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(privateKey, keyId, {
      azp: "csm-sim-web",
      exp: now + 300,
      iat: now,
      iss: issuer,
      preferred_username: "sim.operator",
      realm_access: {
        roles: ["csm-sim-operator"]
      },
      sub: "sim-operator-1"
    });

    ({ app, context } = await createApp(
      testConfig(dataDir, {
        apiAuthMode: "hybrid",
        apiAuthRequired: true,
        apiOidcAllowedClients: ["csm-sim-web"],
        apiOidcClientId: "csm-sim-web",
        apiOidcIssuer: issuer,
        apiPrincipals: [{ actor: "fallback", token: "operator-token", roles: ["SIM_OPERATOR", "SIM_VIEWER"] }]
      })
    ));

    const created = await request(app).post("/api/v1/scenarios").set("authorization", `Bearer ${token}`).send(scenarioPayload).expect(201);
    expect(created.body.scenarioId).toBeTruthy();
    const listed = await request(app).get("/api/v1/scenarios").set("authorization", `Bearer ${token}`).expect(200);
    expect(listed.body.items).toHaveLength(1);
  });

  it("rejects OIDC tokens without SIM roles", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "csm-sim-sec-"));
    const issuer = "https://login.zeleznalady.cz/realms/cop";
    const keyId = "sim-test-key";
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicJwk = {
      ...publicKey.export({ format: "jwk" }),
      alg: "RS256",
      kid: keyId,
      use: "sig"
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ keys: [publicJwk] })));
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(privateKey, keyId, {
      azp: "csm-sim-web",
      exp: now + 300,
      iat: now,
      iss: issuer,
      realm_access: {
        roles: ["cop_operator"]
      },
      sub: "cop-only-user"
    });

    ({ app, context } = await createApp(
      testConfig(dataDir, {
        apiAuthMode: "oidc",
        apiAuthRequired: true,
        apiOidcAllowedClients: ["csm-sim-web"],
        apiOidcClientId: "csm-sim-web",
        apiOidcIssuer: issuer,
        apiPrincipals: []
      })
    ));

    await request(app).post("/api/v1/scenarios").set("authorization", `Bearer ${token}`).send(scenarioPayload).expect(401);
  });

  it("rate limits authenticated protected routes per actor and client", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "csm-sim-sec-"));
    ({ app, context } = await createApp(
      testConfig(dataDir, {
        apiAuthRequired: true,
        apiPrincipals: [{ actor: "viewer", token: "viewer-token", roles: ["SIM_VIEWER"] }],
        apiRateLimitWindowMs: 60_000,
        apiRateLimitMaxRequests: 1
      })
    ));

    await request(app).get("/api/v1/scenarios").set("authorization", "Bearer viewer-token").expect(200);
    const response = await request(app).get("/api/v1/scenarios").set("authorization", "Bearer viewer-token").expect(429);
    expect(response.body.error.code).toBe("RATE_LIMITED");
  });

  it("rejects oversized scenario payloads before they can be started", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "csm-sim-sec-"));
    ({ app, context } = await createApp(testConfig(dataDir, { scenarioMaxActiveObjects: 10 })));

    const oversized = {
      ...scenarioPayload,
      blocks: [{ ...scenarioPayload.blocks[0], objectCount: 11 }]
    };

    const createResponse = await request(app).post("/api/v1/scenarios").send(oversized).expect(400);
    expect(createResponse.body.error.code).toBe("SCENARIO_BUDGET_EXCEEDED");

    const legacyScenario = {
      ...oversized,
      scenarioId: "00000000-0000-4000-8000-000000000099",
      status: "DRAFT" as const
    };
    context!.store.data.scenarios.push(legacyScenario);
    await context!.store.save();

    const startResponse = await request(app).post(`/api/v1/scenarios/${legacyScenario.scenarioId}/start`).send({}).expect(400);
    expect(startResponse.body.error.code).toBe("SCENARIO_BUDGET_EXCEEDED");
  });

  it("rejects block counts above the schema cap", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "csm-sim-sec-"));
    ({ app, context } = await createApp(testConfig(dataDir)));

    const response = await request(app)
      .post("/api/v1/scenarios")
      .send({ ...scenarioPayload, blocks: [{ ...scenarioPayload.blocks[0], objectCount: 501 }] })
      .expect(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});

function expectPositionInsideBbox(geo: { lat?: number; lon?: number }, bbox: number[]): void {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  expect(geo.lat).toBeGreaterThanOrEqual(minLat);
  expect(geo.lat).toBeLessThanOrEqual(maxLat);
  expect(geo.lon).toBeGreaterThanOrEqual(minLon);
  expect(geo.lon).toBeLessThanOrEqual(maxLon);
}

function signJwt(privateKey: KeyObject, keyId: string, payload: Record<string, unknown>): string {
  const header = {
    alg: "RS256",
    kid: keyId,
    typ: "JWT"
  };
  const signedContent = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signedContent);
  signer.end();
  return `${signedContent}.${signer.sign(privateKey).toString("base64url")}`;
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function jsonResponse(body: unknown): Response {
  return {
    json: async () => body,
    ok: true,
    status: 200
  } as Response;
}

function distanceMeters(start: { lat?: number; lon?: number }, end: { lat?: number; lon?: number }): number {
  const lat1 = toRadians(start.lat ?? 0);
  const lat2 = toRadians(end.lat ?? 0);
  const dLat = toRadians((end.lat ?? 0) - (start.lat ?? 0));
  const dLon = toRadians((end.lon ?? 0) - (start.lon ?? 0));
  const haversine = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}
