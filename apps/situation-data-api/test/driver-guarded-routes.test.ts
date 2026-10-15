import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DriverGuardedOperationContext } from "../src/driver-guarded-execution-port.js";

const fixtureState = vi.hoisted(() => ({ store: undefined as any, options: undefined as any }));
vi.mock("../src/driver-measurement-store.js", () => ({ PostgresDriverMeasurementStore: class {
  constructor(_url: string, _secret: string, options: unknown) { fixtureState.options = options; return fixtureState.store; }
} }));
import { registerDriverMeasurementRoutes, type DriverSettings } from "../src/driver-measurements.js";
import { driverErasureRequiredDays, type DriverErasureReceipt } from "../src/driver-account-erasure.js";
import type { SituationDataConfig } from "../src/config.js";

// Route/DI mechanics only; no actual Root authority, database or provider calls.
const now = Date.parse("2026-10-15T09:00:00.000Z"), token = "t".repeat(40), secret = "s".repeat(40), actorSecret = "a".repeat(40);
const businessId = "30000000-0000-4000-8000-000000000001", originId = "40000000-0000-4000-8000-000000000001";
const prefix = "/api/v1/internal/driver-measurements/v1", issuer = "https://identity.example/realms/cop";
const body = () => ({ contractVersion: "sim-account-erasure-v1", operationId: businessId,
  contributors: driverErasureRequiredDays(now).map((day, i) => ({ contributorDay: day, contributorIdDay: `synthetic-${i}`.padEnd(40, "x") })),
  attestation: "cop-account-erasure-contributors-reviewed-v1" });
const headers = () => {
  const actor = Buffer.from(JSON.stringify({ iss: issuer, sub: "synthetic-subject", aud: "sim-account-erasure", iat: now / 1000,
    exp: now / 1000 + 60, operationId: businessId, routerUserId: `cop_${"r".repeat(43)}` })).toString("base64url");
  return { Authorization: `Bearer ${token}`, "x-cop-actor": actor,
    "x-cop-actor-signature": createHmac("sha256", actorSecret).update(actor).digest("hex") };
};
const revokeHeaders = () => {
  const actor = Buffer.from(JSON.stringify({ iss: issuer, sub: "synthetic-subject", aud: "sim-driver-revocation", iat: now / 1000,
    exp: now / 1000 + 60, contributorDay: "2026-10-15", contributorIdDay: "d".repeat(40), actorSource: "consent_ledger" })).toString("base64url");
  return { Authorization: `Bearer ${token}`, "x-cop-actor": actor,
    "x-cop-actor-signature": createHmac("sha256", actorSecret).update(actor).digest("hex") };
};
function pending(): DriverErasureReceipt {
  return { contractVersion: "sim-account-erasure-v1", operationId: businessId, status: "pending", scope: "online_driver_scope",
    wholeAccountComplete: false, backupReplayRequired: true, acceptedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    contributorCount: 9, deletedBatchCount: 3, remainingBatchCount: 0, databaseZeroVerified: true, derivedReportAcknowledged: false,
    reportProtection: "no_report", publicationFenceVerified: true, replayReady: true, retentionReviewed: true, pendingReason: "derived_report_pending" };
}
beforeEach(() => {
  fixtureState.options = undefined;
  fixtureState.store = { lookup: vi.fn(), commit: vi.fn(), aggregates: vi.fn(), quality: vi.fn(),
    revoke: vi.fn(async () => 3), close: vi.fn(async () => {}), accountErasure: vi.fn(async () => pending()),
    acknowledgeAccountErasure: vi.fn(async () => ({ ...pending(), status: "completed", derivedReportAcknowledged: true, pendingReason: null })),
    accountErasureStatus: vi.fn(async () => pending()), accountErasurePreflight: vi.fn(async () => { throw new Error("synthetic passive fixture"); }) };
});
function fixture(current = vi.fn(async (_kind: string) => undefined as DriverGuardedOperationContext | undefined)) {
  const app = express(); app.use(express.json());
  const settings: DriverSettings = { enabled: false, revocationEnabled: true, token, hashSecret: secret, ratePerMinute: 120,
    databaseUrl: "postgresql://synthetic.invalid/never-connected", driverAccountErasureEnabled: true,
    driverAccountErasureActorSecret: actorSecret, driverAccountErasureIssuer: issuer };
  const guarded = {};
  registerDriverMeasurementRoutes(app, {} as SituationDataConfig, settings, { guarded, guardedRequestContext: { current }, now: () => now });
  return { app, current, guarded, store: fixtureState.store };
}
describe("guarded route composition, synthetic constructor/ports only", () => {
  it("passes guarded options into actual store composition and never trusts HTTP origin fields", async () => {
    const f = fixture(); expect(fixtureState.options.guarded).toBe(f.guarded);
    const r = await request(f.app).delete(`${prefix}/contributions`).set("Authorization", `Bearer ${token}`)
      .send({ contractVersion: "sim-driver-measurements-v1", contributorIdDay: "d".repeat(40), operationId: originId });
    expect(r.status).toBe(400); expect(f.current).not.toHaveBeenCalled(); expect(f.store.revoke).not.toHaveBeenCalled();
  });
  it("missing delivery fails closed before revoke or erase store calls", async () => {
    const f = fixture();
    const revoke = await request(f.app).delete(`${prefix}/contributions`).set(revokeHeaders())
      .send({ contractVersion: "sim-driver-measurements-v1", contributorIdDay: "d".repeat(40) });
    expect(revoke.status).toBe(503); expect(revoke.body.error.code).toBe("DRIVER_MEASUREMENTS_UNAVAILABLE");
    const erase = await request(f.app).post(`${prefix}/account-erasure-operations`).set(headers()).send(body());
    expect(erase.status).toBe(503); expect(f.store.revoke).not.toHaveBeenCalled(); expect(f.store.accountErasure).not.toHaveBeenCalled();
  });
  it("delivers only the internal revoke context alongside server HMAC, not raw day ID", async () => {
    const context = { operation: { operationId: originId, kind: "revoke" as const } }, f = fixture(vi.fn(async () => context));
    const r = await request(f.app).delete(`${prefix}/contributions`).set(revokeHeaders())
      .send({ contractVersion: "sim-driver-measurements-v1", contributorIdDay: "d".repeat(40) });
    expect(r.status).toBe(200); expect(r.body.deletedBatchCount).toBe(3);
    expect(f.store.revoke).toHaveBeenCalledExactlyOnceWith("cop", createHmac("sha256", secret).update(`cop:${"d".repeat(40)}`).digest("hex"), context);
  });
  it("no_report alone does not manufacture ACK and preserves accepted pending HTTP202", async () => {
    const eraseContext = { operation: { operationId: originId, kind: "erase" as const } };
    const f = fixture(vi.fn(async kind => kind === "erase" ? eraseContext : undefined));
    const r = await request(f.app).post(`${prefix}/account-erasure-operations`).set(headers()).send(body());
    expect(r.status).toBe(202); expect(r.body.wholeAccountComplete).toBe(false); expect(f.store.acknowledgeAccountErasure).not.toHaveBeenCalled();
    expect(f.store.accountErasure.mock.calls[0][0].operationId).toBe(businessId);
    expect(f.store.accountErasure.mock.calls[0][1]).toBe(eraseContext);
  });
  it("uses a distinct internally delivered ACK origin, not the HTTP business UUID", async () => {
    const erase = { operation: { operationId: originId, kind: "erase" as const } };
    const ack = { operation: { operationId: "40000000-0000-4000-8000-000000000002", kind: "ack" as const },
      publicationContext: { contractVersion: "cop-driver-publication-context-v1" as const, recordId: "50000000-0000-4000-8000-000000000001",
        recordDigest: "a".repeat(64), storeIncarnation: "60000000-0000-4000-8000-000000000001", operationDigest: "b".repeat(64),
        readbackDigest: "c".repeat(64), reportProtection: "no_report" as const, observedAtUTC: new Date(now).toISOString() } };
    const f = fixture(vi.fn(async kind => kind === "erase" ? erase : ack));
    const r = await request(f.app).post(`${prefix}/account-erasure-operations`).set(headers()).send(body());
    expect(r.status).toBe(200); expect(f.store.acknowledgeAccountErasure.mock.calls[0][1]).toBe(ack);
  });
  it("an ACK origin alone without publication context cannot complete the route", async () => {
    const f = fixture(vi.fn(async kind => ({ operation: { operationId: originId, kind: kind as "erase" | "ack" } })));
    const r = await request(f.app).post(`${prefix}/account-erasure-operations`).set(headers()).send(body());
    expect(r.status).toBe(202); expect(f.store.acknowledgeAccountErasure).not.toHaveBeenCalled();
  });
  it("read-only status and preflight never request a Root execution/probe context", async () => {
    const f = fixture();
    expect((await request(f.app).get(`${prefix}/account-erasure-operations/${businessId}`).set(headers())).status).toBe(202);
    await request(f.app).post(`${prefix}/account-erasure-operations/preflight`).set(headers()).send(body());
    expect(f.current).not.toHaveBeenCalled(); expect(f.store.accountErasure).not.toHaveBeenCalled(); expect(f.store.acknowledgeAccountErasure).not.toHaveBeenCalled();
  });
  it("rejects guarded options with a preconstructed store that would ignore them", () => {
    expect(() => registerDriverMeasurementRoutes(express(), {} as SituationDataConfig, {} as DriverSettings,
      { guarded: {}, store: fixtureState.store })).toThrow("DRIVER_GUARDED_STORE_COMPOSITION_INVALID");
  });
});
