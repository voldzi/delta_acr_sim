import { beforeEach, describe, expect, it, vi } from "vitest";
const pg = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), end: vi.fn(), on: vi.fn() }));
vi.mock("pg", () => ({ Pool: function() { return pg; } }));
import { PostgresDriverMeasurementStore, type DriverMeasurementStorageOptions } from "../src/driver-measurement-store.js";
import type { DriverPublicationLease } from "../src/driver-publication.js";

// Local mechanics only. No real Root generation lease or database is simulated
// as accepted. The unavailable branch must stop before any summary SQL.
beforeEach(() => { vi.resetAllMocks(); pg.end.mockResolvedValue(undefined); });
describe("guarded report publication stays unavailable without a real held barrier", () => {
  it.each(["aggregates", "quality"] as const)("%s cannot bypass an unbound guarded composition", async method => {
    const store = new PostgresDriverMeasurementStore("synthetic.invalid", "synthetic-storage-secret-at-least-thirty-two", { guarded: {} });
    const action = () => method === "quality" ? store.quality(new Date().toISOString()) : store.aggregates("synthetic-dataset", "2026-10-01T00:00:00.000Z", new Date().toISOString());
    await expect(action()).rejects.toMatchObject({ status: 503, code: "DRIVER_MEASUREMENTS_UNAVAILABLE" });
    expect(pg.query).not.toHaveBeenCalled(); expect(pg.connect).not.toHaveBeenCalled(); await store.close();
  });
  it.each(["aggregates", "quality"] as const)("%s does not mistake a short-lived read admission for publication authority", async method => {
    const inspect = vi.fn(async () => ({ ready: true }));
    const options = { guarded: { admission: { inspect } } } as unknown as DriverMeasurementStorageOptions;
    const store = new PostgresDriverMeasurementStore("synthetic.invalid", "synthetic-storage-secret-at-least-thirty-two", options);
    delete options.guarded; // Must not turn a constructed guarded instance into legacy.
    const action = () => method === "quality" ? store.quality(new Date().toISOString()) : store.aggregates("synthetic-dataset", "2026-10-01T00:00:00.000Z", new Date().toISOString());
    await expect(action()).rejects.toMatchObject({ status: 503, code: "DRIVER_MEASUREMENTS_UNAVAILABLE" });
    expect(inspect).not.toHaveBeenCalled(); expect(pg.query).not.toHaveBeenCalled(); expect(pg.connect).not.toHaveBeenCalled(); await store.close();
  });
  it.each(["aggregates", "quality"] as const)("%s rejects an invalid publication interface before SQL", async method => {
    const store = new PostgresDriverMeasurementStore("synthetic.invalid", "synthetic-storage-secret-at-least-thirty-two", { guarded: {} });
    const lease = {} as DriverPublicationLease;
    const action = () => method === "quality" ? store.quality("2026-10-15T00:00:00.000Z", lease) :
      store.aggregates("synthetic-dataset", "2026-10-01T00:00:00.000Z", "2026-10-15T00:00:00.000Z", lease);
    await expect(action()).rejects.toMatchObject({ status: 503, code: "DRIVER_MEASUREMENTS_UNAVAILABLE" });
    expect(pg.query).not.toHaveBeenCalled(); expect(pg.connect).not.toHaveBeenCalled(); await store.close();
  });
  it.each(["aggregates", "quality"] as const)("%s checks the held interface before and after actual queries (local stub only)", async method => {
    pg.query.mockResolvedValue({ rows: [] });
    const store = new PostgresDriverMeasurementStore("synthetic.invalid", "synthetic-storage-secret-at-least-thirty-two", { guarded: {} });
    const lease = { assertCurrent: vi.fn(async () => undefined) };
    if (method === "quality") await store.quality("2026-10-15T00:00:00.000Z", lease);
    else await store.aggregates("synthetic-dataset", "2026-10-01T00:00:00.000Z", "2026-10-15T00:00:00.000Z", lease);
    expect(lease.assertCurrent).toHaveBeenCalledTimes(2);
    expect(pg.query).toHaveBeenCalledTimes(method === "quality" ? 3 : 1);
    const calls = lease.assertCurrent.mock.invocationCallOrder;
    expect(calls[0]).toBeLessThan(pg.query.mock.invocationCallOrder[0]!);
    expect(calls[1]).toBeGreaterThan(pg.query.mock.invocationCallOrder.at(-1)!);
    await store.close();
  });
  it.each(["aggregates", "quality"] as const)("%s never returns rows when the final held-interface check fails", async method => {
    pg.query.mockResolvedValue({ rows: [] });
    const store = new PostgresDriverMeasurementStore("synthetic.invalid", "synthetic-storage-secret-at-least-thirty-two", { guarded: {} });
    const lease = { assertCurrent: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("synthetic revoked interface")) };
    const action = () => method === "quality" ? store.quality("2026-10-15T00:00:00.000Z", lease) :
      store.aggregates("synthetic-dataset", "2026-10-01T00:00:00.000Z", "2026-10-15T00:00:00.000Z", lease);
    await expect(action()).rejects.toMatchObject({ status: 503, code: "DRIVER_MEASUREMENTS_UNAVAILABLE" });
    expect(pg.query).toHaveBeenCalledTimes(method === "quality" ? 3 : 1); await store.close();
  });
});
