import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ load: vi.fn(), settings: vi.fn(), construct: vi.fn(),
  init: vi.fn(), start: vi.fn(), once: vi.fn(), close: vi.fn(), events: [] as string[] }));
vi.mock("../src/driver-owner-composition.js", () => ({ loadProductionDriverOwnerComposition: state.load }));
vi.mock("../src/driver-measurements.js", () => ({ driverSettings: state.settings }));
vi.mock("../src/driver-measurement-store.js", () => ({ PostgresDriverMeasurementStore: class {
  constructor(...args: unknown[]) { state.construct(...args); }
  init = state.init; startRetention = state.start; runRetentionOnce = state.once; close = state.close;
} }));
import { createProductionDriverMaintenanceControl } from "../src/driver-maintenance-owner.js";
import { runDriverMaintenance } from "../src/driver-maintenance-cli.js";

const consumer = { owner: "sim_driver_measurements", execute: vi.fn() };
const guarded = { execution: {}, admission: {} };
const settings = { enabled: false, revocationEnabled: true, databaseUrl: "postgresql://synthetic.invalid/sim_driver_measurements",
  hashSecret: "synthetic-configuration-secret-not-a-real-key", driverAccountErasureEnabled: false,
  driverAccountErasureActorSecret: "synthetic-actor-secret-at-least-thirty-two", driverAccountErasureIssuer: "https://synthetic.invalid/realm",
  driverAccountErasureReplayCheckpoint: "synthetic-reviewed-checkpoint" };
beforeEach(() => {
  vi.resetAllMocks(); state.events.length = 0;
  state.load.mockResolvedValue({ driverMeasurements: { guarded, retentionConsumer: consumer } });
  state.settings.mockReturnValue({ ...settings });
  for (const [fn, name] of [[state.init, "init"], [state.start, "start"], [state.once, "once"], [state.close, "close"]] as const)
    fn.mockImplementation(async () => { state.events.push(name); });
});
describe("fixed Driver maintenance composition (mock ports/storage, not Root acceptance)", () => {
  it("missing Root consumer denies before configuration or database construction", async () => {
    state.load.mockResolvedValue({ driverMeasurements: { guarded: {} } });
    const control = await createProductionDriverMaintenanceControl();
    await expect(control.init()).rejects.toMatchObject({ code: "DRIVER_RETENTION_UNBOUND" });
    await expect(control.runOnce()).rejects.toMatchObject({ code: "DRIVER_RETENTION_UNBOUND" }); await control.close();
    expect(state.settings).not.toHaveBeenCalled(); expect(state.construct).not.toHaveBeenCalled();
  });
  it("passes the same guarded execution/read ports and explicit maintenance consumer", async () => {
    await createProductionDriverMaintenanceControl();
    expect(state.construct).toHaveBeenCalledWith(settings.databaseUrl, settings.hashSecret, {
      enabled: false, identityConfigured: true, expectedCheckpoint: settings.driverAccountErasureReplayCheckpoint,
      guarded, retentionConsumer: consumer,
    });
  });
  it("never silently selects legacy DML if an incomplete composition omits guarded", async () => {
    state.load.mockResolvedValue({ driverMeasurements: { retentionConsumer: consumer } });
    await createProductionDriverMaintenanceControl(); expect(state.construct.mock.calls[0]![2].guarded).toEqual({});
  });
  it("rejects missing storage configuration before constructing a store", async () => {
    for (const invalid of [{ ...settings, databaseUrl: undefined }, { ...settings, hashSecret: "short" }]) {
      state.settings.mockReturnValue(invalid);
      await expect(createProductionDriverMaintenanceControl()).rejects.toMatchObject({ code: "DRIVER_RETENTION_UNAVAILABLE" });
    }
    expect(state.construct).not.toHaveBeenCalled();
  });
  it("standalone CLI uses the fixed default composition and awaits init, actual work and close", async () => {
    await runDriverMaintenance(); expect(state.events).toEqual(["init", "once", "close"]);
    expect(state.load).toHaveBeenCalledTimes(1);
  });
  it("standalone CLI closes on cleanup failure without a second dispatch", async () => {
    state.once.mockImplementation(async () => { state.events.push("once"); throw Error("synthetic cleanup failure"); });
    await expect(runDriverMaintenance()).rejects.toThrow("synthetic cleanup failure");
    expect(state.events).toEqual(["init", "once", "close"]); expect(state.once).toHaveBeenCalledTimes(1);
  });
});
