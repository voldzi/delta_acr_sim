import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const pg = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), end: vi.fn(), on: vi.fn() }));
vi.mock("pg", () => ({ Pool: function() { return pg; } }));
import { composeDriverOwnerBindings, type DriverRootRequestScope } from "../src/driver-owner-composition.js";
import { registerDriverMeasurementRoutes } from "../src/driver-measurements.js";
import type { SituationDataConfig } from "../src/config.js";
import type { DriverRetentionControl } from "../src/driver-retention-lifecycle.js";

const PREFIX = "/api/v1/internal/driver-measurements/v1", token = "synthetic-service-token-at-least-thirty-two";
const actorSecret = "synthetic-actor-secret-at-least-thirty-two", issuer = "https://synthetic.invalid/realm", now = Date.parse("2026-10-15T12:00:00.000Z");
function revocationHeaders(actorSource: "verified_session" | "consent_ledger" = "consent_ledger") {
  const actor = Buffer.from(JSON.stringify({ iss: issuer, sub: "synthetic-user", aud: "sim-driver-revocation", iat: now / 1000,
    exp: now / 1000 + 60, contributorDay: "2026-10-15", contributorIdDay: "x".repeat(43), actorSource })).toString("base64url");
  return { "x-cop-actor": actor, "x-cop-actor-signature": createHmac("sha256", actorSecret).update(actor).digest("hex") };
}
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
  const dataset = vi.fn(async () => "sim-routing-2026-10-15-1792022400");
  control = registerDriverMeasurementRoutes(app, {} as SituationDataConfig, { enabled: true, revocationEnabled: true,
    databaseUrl: "postgresql://synthetic.invalid/sim_driver_measurements", token, hashSecret: "synthetic-storage-secret-at-least-thirty-two",
    ratePerMinute: 120, driverAccountErasureEnabled: true, driverAccountErasureIssuer: issuer,
    driverAccountErasureActorSecret: actorSecret, driverAccountErasureReplayCheckpoint: undefined },
  { ...owner.driverMeasurements, now: () => now, matcher: { match: vi.fn(), dataset } });
  return { app, current, dataset };
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
  it("returns 401 for a guarded revoke without its signed actor, before Root context or SQL", async () => {
    const { app, current } = fixture(); const result = await request(app).delete(PREFIX + "/contributions").set("authorization", "Bearer " + token)
      .send({ contractVersion: "sim-driver-measurements-v1", contributorIdDay: "x".repeat(43) }).expect(401);
    expect(result.body.error.code).toBe("DRIVER_REVOCATION_ACTOR_INVALID"); expect(current).not.toHaveBeenCalled(); noSql();
  });
  it.each(["verified_session", "consent_ledger"] as const)("returns 503 for signed %s revoke without current protected delivery, never legacy DELETE", async source => {
    const { app, current } = fixture(); await request(app).delete(PREFIX + "/contributions").set("authorization", "Bearer " + token)
      .set(revocationHeaders(source))
      .send({ contractVersion: "sim-driver-measurements-v1", contributorIdDay: "x".repeat(43) }).expect(503);
    expect(current).toHaveBeenCalledExactlyOnceWith("revoke"); noSql();
  });
  it("preserves an unrelated healthy endpoint", async () => {
    const { app, current } = fixture(); await request(app).get("/health").expect(200, { status: "ok" });
    expect(current).not.toHaveBeenCalled(); noSql();
  });
  it.each(["aggregates", "quality"])("keeps %s unavailable without a held publication port before SQL or matcher", async path => {
    const { app, dataset } = fixture(); await request(app).get(PREFIX + "/" + path).set("authorization", "Bearer " + token).expect(503);
    expect(dataset).not.toHaveBeenCalled(); noSql();
  });
  it("keeps an invalid report query 400 before the missing publication gate", async () => {
    const { app, dataset } = fixture(); await request(app).get(PREFIX + "/aggregates?unknown=true").set("authorization", "Bearer " + token).expect(400);
    expect(dataset).not.toHaveBeenCalled(); noSql();
  });
  it("does not accept a publication port selected by an HTTP query", async () => {
    const { app, dataset } = fixture(); await request(app).get(PREFIX + "/aggregates?publication=anything").set("authorization", "Bearer " + token).expect(400);
    expect(dataset).not.toHaveBeenCalled(); noSql();
  });
});
