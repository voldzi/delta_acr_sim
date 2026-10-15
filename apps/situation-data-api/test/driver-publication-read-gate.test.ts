import { beforeEach, describe, expect, it, vi } from "vitest";
const pg = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), end: vi.fn(), on: vi.fn() }));
vi.mock("pg", () => ({ Pool: function() { return pg; } }));
import { PostgresDriverMeasurementStore, type DriverMeasurementStorageOptions } from "../src/driver-measurement-store.js";

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
});
