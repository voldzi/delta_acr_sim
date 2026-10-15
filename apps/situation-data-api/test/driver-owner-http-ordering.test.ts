import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const pg = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), end: vi.fn(), on: vi.fn() }));
vi.mock("pg", () => ({ Pool: function() { return pg; } }));
import { composeDriverOwnerBindings, type DriverRootRequestScope } from "../src/driver-owner-composition.js";
import { registerDriverMeasurementRoutes } from "../src/driver-measurements.js";
import type { SituationDataConfig } from "../src/config.js";
import type { DriverRetentionControl } from "../src/driver-retention-lifecycle.js";

const PREFIX = "/api/v1/internal/driver-measurements/v1", token = "synthetic-service-token-at-least-thirty-two";
let control: DriverRetentionControl | undefined;
beforeEach(() => { vi.resetAllMocks(); pg.end.mockResolvedValue(undefined); });
afterEach(async () => { await control?.close(); control = undefined; });
function fixture() {
  const run: DriverRootRequestScope["run"] = () => { throw Error("Synthetic local scope rejection, not Root authority"); };
  const current = vi.fn(async () => undefined);
  const owner = composeDriverOwnerBindings({ execution: { execute: vi.fn(), probe: vi.fn() }, admission: { inspect: vi.fn() },
    requestScope: { run, context: { current } }, retentionConsumer: { owner: "sim_driver_measurements", execute: vi.fn() } });
  const app = express(); app.use(express.json()); app.use(owner.driverScopeMiddleware);
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  control = registerDriverMeasurementRoutes(app, {} as SituationDataConfig, { enabled: true, revocationEnabled: true,
    databaseUrl: "postgresql://synthetic.invalid/sim_driver_measurements", token, hashSecret: "synthetic-storage-secret-at-least-thirty-two",
    ratePerMinute: 120, driverAccountErasureEnabled: true, driverAccountErasureIssuer: "https://synthetic.invalid/realm",
    driverAccountErasureActorSecret: "synthetic-actor-secret-at-least-thirty-two", driverAccountErasureReplayCheckpoint: undefined },
  { ...owner.driverMeasurements, matcher: { match: vi.fn(), dataset: vi.fn() } });
  return { app, current };
}
function noSql() { expect(pg.query).not.toHaveBeenCalled(); expect(pg.connect).not.toHaveBeenCalled(); }
describe("actual Driver HTTP ordering with rejected local scope (no native authority)", () => {
  it("keeps 401 without service authentication before any operation context", async () => {
    const { app, current } = fixture(); await request(app).delete(PREFIX + "/contributions").send({}).expect(401);
    expect(current).not.toHaveBeenCalled(); noSql();
  });
  it("keeps 400 for invalid revoke input instead of a generic scope error", async () => {
    const { app, current } = fixture(); await request(app).delete(PREFIX + "/contributions").set("authorization", "Bearer " + token)
      .send({ contractVersion: "sim-driver-measurements-v1", contributorIdDay: "invalid" }).expect(400);
    expect(current).not.toHaveBeenCalled(); noSql();
  });
  it("keeps 400 for malformed account erasure before context or SQL", async () => {
    const { app, current } = fixture(); await request(app).post(PREFIX + "/account-erasure-operations").set("authorization", "Bearer " + token).send({}).expect(400);
    expect(current).not.toHaveBeenCalled(); noSql();
  });
  it("returns 503 for valid revoke without current protected delivery, never legacy DELETE", async () => {
    const { app, current } = fixture(); await request(app).delete(PREFIX + "/contributions").set("authorization", "Bearer " + token)
      .send({ contractVersion: "sim-driver-measurements-v1", contributorIdDay: "x".repeat(43) }).expect(503);
    expect(current).toHaveBeenCalledExactlyOnceWith("revoke"); noSql();
  });
  it("preserves an unrelated healthy endpoint", async () => {
    const { app, current } = fixture(); await request(app).get("/health").expect(200, { status: "ok" });
    expect(current).not.toHaveBeenCalled(); noSql();
  });
});
