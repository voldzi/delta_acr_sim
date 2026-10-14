import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DriverRetentionLifecycle,
  createProductionDriverRetentionLifecycle,
  type DriverRetentionConsumer,
  type DriverRetentionOperationContext
} from "../src/driver-retention-lifecycle.js";
import { runDriverMaintenance } from "../src/driver-maintenance-cli.js";
import { PostgresDriverMeasurementStore } from "../src/driver-measurement-store.js";
import express from "express";
import { registerDriverMeasurementRoutes, type DriverStore } from "../src/driver-measurements.js";
import type { SituationDataConfig } from "../src/config.js";

type Work = Parameters<DriverRetentionConsumer["execute"]>[0];

// All database observations below are synthetic spies. This file never creates
// a PostgreSQL connection or accepts a production URL, producer or authority.
const postgres = vi.hoisted(() => ({ construct: vi.fn(), connect: vi.fn(), query: vi.fn(), end: vi.fn(), on: vi.fn() }));
vi.mock("pg", () => ({
  Pool: function SyntheticPool(options: unknown) {
    postgres.construct(options);
    return { connect: postgres.connect, query: postgres.query, end: postgres.end, on: postgres.on };
  }
}));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function microtasks() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
function context(): DriverRetentionOperationContext {
  return Object.freeze({ owner: "sim_driver_measurements", cutoff: "2026-10-14T12:00:00.000Z" });
}
function syntheticConsumer(execute?: DriverRetentionConsumer["execute"]): DriverRetentionConsumer {
  return { owner: "sim_driver_measurements", execute: execute ?? (async work => { await work(context()); }) };
}
function scheduler() {
  const callbacks: Array<() => void> = [];
  const set = vi.fn((callback: () => void, _milliseconds: number) => { callbacks.push(callback); return callbacks.length; });
  const clear = vi.fn();
  return { port: { set, clear }, set, clear, fire: () => { callbacks.at(-1)?.(); } };
}

beforeEach(() => {
  vi.clearAllMocks();
  postgres.connect.mockReset(); postgres.query.mockReset(); postgres.end.mockReset();
  postgres.end.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("driver retention lifecycle: synthetic boundary only", () => {
  it("construction performs no initialization, timer, consumer dispatch or SQL", async () => {
    const initialize = vi.fn(async () => undefined), cleanup = vi.fn(async () => undefined), timing = scheduler();
    const execute = vi.fn(async (work: Work) => { await work(context()); });
    const life = new DriverRetentionLifecycle({ initialize, cleanup, consumer: syntheticConsumer(execute), scheduler: timing.port });
    await microtasks();
    expect(initialize).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled(); expect(timing.set).not.toHaveBeenCalled();
    expect(postgres.construct).not.toHaveBeenCalled(); expect(postgres.query).not.toHaveBeenCalled();
    await life.close();
  });

  it("requires the actual initializer to finish before scheduling or running", async () => {
    const accepted = deferred(), initialize = vi.fn(() => accepted.promise), cleanup = vi.fn(async () => undefined), timing = scheduler();
    const life = new DriverRetentionLifecycle({ initialize, cleanup, consumer: syntheticConsumer(), scheduler: timing.port });
    await expect(life.runOnce()).rejects.toMatchObject({ code: "DRIVER_RETENTION_INIT_REQUIRED" });
    await expect(Promise.resolve().then(() => life.start())).rejects.toMatchObject({ code: "DRIVER_RETENTION_INIT_REQUIRED" });
    const initializing = life.init(); await microtasks();
    expect(initialize).toHaveBeenCalledTimes(1);
    await expect(Promise.resolve().then(() => life.start())).rejects.toMatchObject({ code: "DRIVER_RETENTION_INIT_REQUIRED" });
    expect(timing.set).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
    accepted.resolve(); await initializing; await life.start();
    expect(timing.set).toHaveBeenCalledTimes(1); expect(timing.set.mock.calls[0]?.[1]).toBe(60000);
    await life.close();
  });

  it("does not turn a rejected initializer into a scheduled consumer", async () => {
    const cleanup = vi.fn(async () => undefined), timing = scheduler();
    const life = new DriverRetentionLifecycle({ initialize: async () => { throw new Error("synthetic init rejected"); }, cleanup, consumer: syntheticConsumer(), scheduler: timing.port });
    await expect(life.init()).rejects.toThrow();
    await expect(life.runOnce()).rejects.toMatchObject({ code: "DRIVER_RETENTION_INIT_REQUIRED" });
    expect(cleanup).not.toHaveBeenCalled(); expect(timing.set).not.toHaveBeenCalled();
    await life.close();
  });

  it("initialization, starts and closes are idempotent", async () => {
    const initialize = vi.fn(async () => undefined), timing = scheduler();
    const life = new DriverRetentionLifecycle({ initialize, cleanup: async () => undefined, consumer: syntheticConsumer(), scheduler: timing.port });
    await Promise.all([life.init(), life.init()]); await life.init();
    await life.start(); await life.start();
    expect(initialize).toHaveBeenCalledTimes(1); expect(timing.set).toHaveBeenCalledTimes(1);
    await Promise.all([life.close(), life.close()]); await life.close();
    expect(timing.clear).toHaveBeenCalledTimes(1);
    await expect(Promise.resolve().then(() => life.start())).rejects.toThrow();
  });

  it("closing during initialization cannot resurrect a timer or start", async () => {
    const initializing = deferred(), timing = scheduler();
    const life = new DriverRetentionLifecycle({ initialize: () => initializing.promise, cleanup: async () => undefined, consumer: syntheticConsumer(), scheduler: timing.port });
    const initialResult = life.init().catch(() => undefined);
    await microtasks(); // The initializer has actually begun, not merely been queued.
    let closed = false; const closing = life.close().then(() => { closed = true; });
    await microtasks(); expect(closed).toBe(false); expect(timing.set).not.toHaveBeenCalled();
    initializing.resolve(); await initialResult; await closing;
    await expect(Promise.resolve().then(() => life.start())).rejects.toThrow();
    expect(timing.set).not.toHaveBeenCalled();
  });

  it("close wins a queued start without scheduling a timer", async () => {
    const timing = scheduler();
    const life = new DriverRetentionLifecycle({ initialize: async () => undefined, cleanup: async () => undefined, consumer: syntheticConsumer(), scheduler: timing.port });
    await life.init(); const starting = life.start(), closing = life.close();
    await expect(starting).rejects.toMatchObject({ code: "DRIVER_RETENTION_CLOSED" }); await closing;
    expect(timing.set).not.toHaveBeenCalled(); expect(timing.clear).not.toHaveBeenCalled();
  });

  it("joins overlapping runOnce calls instead of dispatching another cleanup", async () => {
    const sql = deferred(), cleanup = vi.fn(() => sql.promise), execute = vi.fn(async (work: Work) => { await work(context()); });
    const life = new DriverRetentionLifecycle({ initialize: async () => undefined, cleanup, consumer: syntheticConsumer(execute) });
    await life.init(); const first = life.runOnce(), second = life.runOnce(); await microtasks();
    expect(execute).toHaveBeenCalledTimes(1); expect(cleanup).toHaveBeenCalledTimes(1);
    sql.resolve(); await Promise.all([first, second]); await life.close();
  });

  it("periodic callbacks also join a running cleanup", async () => {
    const sql = deferred(), cleanup = vi.fn(() => sql.promise), timing = scheduler();
    const life = new DriverRetentionLifecycle({ initialize: async () => undefined, cleanup, consumer: syntheticConsumer(), scheduler: timing.port });
    await life.init(); await life.start(); timing.fire(); timing.fire(); await microtasks();
    expect(cleanup).toHaveBeenCalledTimes(1);
    sql.resolve(); await life.close(); expect(timing.clear).toHaveBeenCalledTimes(1);
    timing.fire(); await microtasks(); expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("close waits for actual cleanup after an early consumer success", async () => {
    const sql = deferred(), cleanup = vi.fn(() => sql.promise);
    const life = new DriverRetentionLifecycle({ initialize: async () => undefined, cleanup,
      consumer: syntheticConsumer(async work => { void work(context()); }) });
    await life.init(); let runSettled = false, closeSettled = false;
    const running = life.runOnce().finally(() => { runSettled = true; }); await microtasks();
    const closing = life.close().then(() => { closeSettled = true; }); await microtasks();
    expect(cleanup).toHaveBeenCalledTimes(1); expect(runSettled).toBe(false); expect(closeSettled).toBe(false);
    sql.resolve(); await running; await closing;
  });

  it("a consumer error cannot mark an in-flight cleanup as settled", async () => {
    const sql = deferred(), cleanup = vi.fn(() => sql.promise);
    const life = new DriverRetentionLifecycle({ initialize: async () => undefined, cleanup,
      consumer: syntheticConsumer(async work => { void work(context()); throw new Error("synthetic unknown outcome"); }) });
    await life.init(); let runSettled = false, closeSettled = false;
    const running = life.runOnce().then(() => { throw new Error("unknown must not become success"); }, () => { runSettled = true; });
    await microtasks(); const closing = life.close().then(() => { closeSettled = true; }); await microtasks();
    expect(runSettled).toBe(false); expect(closeSettled).toBe(false);
    sql.resolve(); await running; await closing;
  });

  it("rejects an unknown zero-callback dispatch and forbids its late callback", async () => {
    let late!: (value: DriverRetentionOperationContext) => Promise<void>;
    const cleanup = vi.fn(async () => undefined);
    const life = new DriverRetentionLifecycle({ initialize: async () => undefined, cleanup,
      consumer: syntheticConsumer(async work => { late = work; }) });
    await life.init(); await expect(life.runOnce()).rejects.toThrow();
    await expect(late(context())).rejects.toThrow(); expect(cleanup).not.toHaveBeenCalled();
    await life.close();
  });

  it("allows at most one callback per dispatch", async () => {
    const cleanup = vi.fn(async () => undefined); let duplicateRejected = false;
    const life = new DriverRetentionLifecycle({ initialize: async () => undefined, cleanup,
      consumer: syntheticConsumer(async work => {
        await work(context());
        try { await work(context()); } catch { duplicateRejected = true; }
      }) });
    await life.init(); await expect(life.runOnce()).rejects.toThrow();
    expect(duplicateRejected).toBe(true); expect(cleanup).toHaveBeenCalledTimes(1);
    await life.close();
  });

  it.each([
    { owner: "foreign", cutoff: "2026-10-14T12:00:00.000Z" },
    { owner: "sim_driver_measurements", cutoff: "2026-10-14T14:00:00.000+02:00" },
    { owner: "sim_driver_measurements", cutoff: "2026-10-14T12:00:00Z" },
    { owner: "sim_driver_measurements", cutoff: "2026-10-14T12:00:00.000Z", extra: true },
    { owner: "sim_driver_measurements", cutoff: "not-a-time" }
  ])("rejects malformed operation context before cleanup (%#)", async value => {
    const cleanup = vi.fn(async () => undefined);
    const life = new DriverRetentionLifecycle({ initialize: async () => undefined, cleanup,
      consumer: syntheticConsumer(async work => { await work(Object.freeze(value) as DriverRetentionOperationContext); }) });
    await life.init(); await expect(life.runOnce()).rejects.toThrow(); expect(cleanup).not.toHaveBeenCalled(); await life.close();
  });

  it("rejects a context accessor without invoking it", async () => {
    const getter = vi.fn(() => "2026-10-14T12:00:00.000Z"), cleanup = vi.fn(async () => undefined);
    const value = Object.freeze(Object.defineProperty({ owner: "sim_driver_measurements" }, "cutoff", { enumerable: true, get: getter }));
    const life = new DriverRetentionLifecycle({ initialize: async () => undefined, cleanup,
      consumer: syntheticConsumer(async work => { await work(value as DriverRetentionOperationContext); }) });
    await life.init(); await expect(life.runOnce()).rejects.toThrow(); expect(getter).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled(); await life.close();
  });

  it("rejects a mutable cutoff context before cleanup", async () => {
    const cleanup = vi.fn(async () => undefined), value = { ...context() };
    const life = new DriverRetentionLifecycle({ initialize: async () => undefined, cleanup,
      consumer: syntheticConsumer(async work => { await work(value); }) });
    await life.init(); await expect(life.runOnce()).rejects.toThrow(); expect(cleanup).not.toHaveBeenCalled(); await life.close();
  });
});

function syntheticStore(consumer = syntheticConsumer(), timing = scheduler()) {
  // Neither this string nor this fixed test secret is a real credential.
  const store = new PostgresDriverMeasurementStore("synthetic-not-a-connection", "synthetic-storage-secret-only-0000000000", {
    retentionConsumer: consumer, retentionScheduler: timing.port
  });
  return { store, timing };
}
function acceptedDatabaseInitialization() {
  postgres.query.mockResolvedValue({ rows: [{ database_name: "sim_driver_measurements", receipts: true, revocations: true }], rowCount: 1 });
}
function syntheticClient(query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 0 }))) {
  const release = vi.fn(); postgres.connect.mockResolvedValue({ query, release });
  return { query, release };
}

describe("driver retention SQL wiring: synthetic pg only", () => {
  it("store construction has zero SQL and no timer", async () => {
    const { store, timing } = syntheticStore(); await microtasks();
    expect(postgres.construct).toHaveBeenCalledWith(expect.objectContaining({ max: 4, connectionTimeoutMillis: 1500, statement_timeout: 5000 }));
    expect(postgres.query).not.toHaveBeenCalled(); expect(postgres.connect).not.toHaveBeenCalled(); expect(timing.set).not.toHaveBeenCalled();
    await store.close(); expect(postgres.end).toHaveBeenCalledTimes(1);
  });

  it("requires the read-only initialization before cleanup or timers", async () => {
    acceptedDatabaseInitialization(); const { store, timing } = syntheticStore();
    await expect(store.runRetentionOnce()).rejects.toMatchObject({ code: "DRIVER_RETENTION_INIT_REQUIRED" });
    await expect(Promise.resolve().then(() => store.startRetention())).rejects.toMatchObject({ code: "DRIVER_RETENTION_INIT_REQUIRED" });
    expect(postgres.query).not.toHaveBeenCalled(); expect(postgres.connect).not.toHaveBeenCalled();
    await store.init(); expect(postgres.query).toHaveBeenCalledTimes(1);
    expect(postgres.query.mock.calls[0]?.[0]).toMatch(/^SELECT\s/i);
    expect(postgres.query.mock.calls[0]?.[0]).toContain("current_database()");
    await store.startRetention(); expect(timing.set).toHaveBeenCalledTimes(1); await store.close();
  });

  it("uses one transaction and one immutable supplied cutoff for both expiration deletes", async () => {
    acceptedDatabaseInitialization(); const client = syntheticClient(), { store } = syntheticStore();
    await store.init(); await store.runRetentionOnce();
    const calls = client.query.mock.calls;
    expect(calls[0]?.[0]).toBe("BEGIN"); expect(calls.at(-1)?.[0]).toBe("COMMIT");
    const deletes = calls.filter(([sql]) => sql.startsWith("DELETE "));
    expect(deletes).toHaveLength(2);
    expect(deletes[0]?.[0]).toContain("driver_measurement_receipts");
    expect(deletes[1]?.[0]).toContain("driver_measurement_revocations");
    for (const [sql, values] of deletes) {
      expect(sql).not.toMatch(/now\s*\(/i); expect(sql).toContain("expires_at");
      expect(values).toEqual([context().cutoff]);
      expect(sql).not.toMatch(/account_erasure|account_revocation/i);
    }
    expect(postgres.connect).toHaveBeenCalledTimes(1); expect(client.release).toHaveBeenCalledTimes(1);
    expect(postgres.query).toHaveBeenCalledTimes(1); // Initialization only, no pool-level DELETE.
    await store.close();
  });

  it("rolls back rather than retaining a partially completed expiration cleanup", async () => {
    acceptedDatabaseInitialization();
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (/^DELETE FROM (?:public\.)?driver_measurement_revocations/.test(sql)) throw new Error("synthetic delete failure");
      return { rows: [], rowCount: 0 };
    });
    const client = syntheticClient(query), { store } = syntheticStore();
    await store.init(); await expect(store.runRetentionOnce()).rejects.toThrow();
    expect(query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
    expect(query.mock.calls.every(([sql]) => !sql.includes("account_erasure") && !sql.includes("account_revocation"))).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1); await store.close();
  });

  it("close waits for SQL commit and release even when the boundary returns early", async () => {
    acceptedDatabaseInitialization(); const sql = deferred<{ rows: never[]; rowCount: number }>();
    const order: string[] = [];
    const query = vi.fn(async (statement: string, _values?: unknown[]) => {
      order.push(statement);
      if (/^DELETE FROM (?:public\.)?driver_measurement_receipts/.test(statement)) return await sql.promise;
      return { rows: [] as never[], rowCount: 0 };
    });
    const client = syntheticClient(query);
    client.release.mockImplementation(() => { order.push("RELEASE"); });
    postgres.end.mockImplementation(async () => { order.push("END"); });
    const { store } = syntheticStore(syntheticConsumer(async work => { void work(context()); }));
    await store.init(); const running = store.runRetentionOnce(); await microtasks();
    const closing = store.close(); await microtasks();
    expect(order.some(value => /^DELETE FROM (?:public\.)?driver_measurement_receipts/.test(value))).toBe(true);
    expect(order).not.toContain("COMMIT"); expect(client.release).not.toHaveBeenCalled(); expect(postgres.end).not.toHaveBeenCalled();
    sql.resolve({ rows: [], rowCount: 0 }); await running; await closing;
    expect(order.slice(-3)).toEqual(["COMMIT", "RELEASE", "END"]);
    await store.close(); expect(postgres.end).toHaveBeenCalledTimes(1);
  });

  it("a mismatched initialized database cannot run a cleanup", async () => {
    postgres.query.mockResolvedValue({ rows: [{ database_name: "foreign", receipts: true, revocations: true }], rowCount: 1 });
    const { store, timing } = syntheticStore();
    await expect(store.init()).rejects.toThrow();
    await expect(store.runRetentionOnce()).rejects.toMatchObject({ code: "DRIVER_RETENTION_INIT_REQUIRED" });
    expect(postgres.connect).not.toHaveBeenCalled(); expect(timing.set).not.toHaveBeenCalled(); await store.close();
  });
});

describe("standalone driver retention: production default unavailable", () => {
  it("has no bound consumer or SQL by default", async () => {
    const life = createProductionDriverRetentionLifecycle();
    await expect(life.init()).rejects.toMatchObject({ code: "DRIVER_RETENTION_UNBOUND" });
    await expect(Promise.resolve().then(() => life.start())).rejects.toMatchObject({ code: "DRIVER_RETENTION_UNBOUND" });
    await expect(life.runOnce()).rejects.toMatchObject({ code: "DRIVER_RETENTION_UNBOUND" });
    await life.close(); await life.close();
    expect(postgres.construct).not.toHaveBeenCalled(); expect(postgres.connect).not.toHaveBeenCalled(); expect(postgres.query).not.toHaveBeenCalled();
  });

  it("cannot accept a connection URL or enable flag as a standalone bypass", async () => {
    vi.stubEnv("DRIVER_MEASUREMENTS_DATABASE_URL", "synthetic-not-a-connection");
    vi.stubEnv("DRIVER_MEASUREMENTS_ENABLED", "true");
    vi.stubEnv("DRIVER_ACCOUNT_ERASURE_ENABLED", "true");
    await expect(runDriverMaintenance()).rejects.toMatchObject({ code: "DRIVER_RETENTION_UNBOUND" });
    expect(postgres.construct).not.toHaveBeenCalled(); expect(postgres.connect).not.toHaveBeenCalled(); expect(postgres.query).not.toHaveBeenCalled();
  });
});

function composedRetention(bound = true) {
  const store = {
    lookup: vi.fn(async () => undefined),
    commit: vi.fn<DriverStore["commit"]>(async (_owner, _contributor, _hash, _batch, _intervals, receipt) => receipt),
    aggregates: vi.fn(async () => []), quality: vi.fn(async () => ({})), revoke: vi.fn(async () => 0),
    init: vi.fn<() => Promise<void>>(async () => undefined), startRetention: vi.fn<() => Promise<void>>(async () => undefined),
    runRetentionOnce: vi.fn<() => Promise<void>>(async () => undefined), close: vi.fn<() => Promise<void>>(async () => undefined)
  };
  const matcher = { match: vi.fn(async () => { throw new Error("Synthetic matcher must not run"); }), dataset: vi.fn(async () => "synthetic-unused-dataset") };
  // Express registration only: no listener, requests, sockets or provider calls.
  const app = express();
  const control = registerDriverMeasurementRoutes(app, {} as SituationDataConfig,
    { enabled: false, revocationEnabled: true, token: "synthetic-service-token-only-000000000000", hashSecret: "synthetic-route-secret-only-0000000000000", ratePerMinute: 120 },
    { store, matcher, ...(bound ? { retentionConsumer: syntheticConsumer() } : {}) });
  return { app, store, matcher, control };
}

describe("driver retention route composition: no listener or HTTP", () => {
  it("route registration does not initialize, start or dispatch storage", async () => {
    const { control, store, matcher } = composedRetention(); await microtasks();
    expect(store.init).not.toHaveBeenCalled(); expect(store.startRetention).not.toHaveBeenCalled();
    expect(store.runRetentionOnce).not.toHaveBeenCalled(); expect(matcher.match).not.toHaveBeenCalled(); expect(matcher.dataset).not.toHaveBeenCalled();
    expect(postgres.construct).not.toHaveBeenCalled(); await control.close();
  });

  it("awaits actual asynchronous store.init before startRetention", async () => {
    const { control, store } = composedRetention(), initialization = deferred();
    store.init.mockImplementation(() => initialization.promise);
    const starting = control.start(); await microtasks();
    expect(store.init).toHaveBeenCalledTimes(1); expect(store.startRetention).not.toHaveBeenCalled();
    initialization.resolve(); await starting;
    expect(store.startRetention).toHaveBeenCalledTimes(1); expect(store.runRetentionOnce).not.toHaveBeenCalled();
    await control.init(); expect(store.init).toHaveBeenCalledTimes(1); await control.close();
  });

  it("rejects unbound start and runOnce before calling store.init", async () => {
    const { control, store } = composedRetention(false);
    await expect(control.start()).rejects.toMatchObject({ code: "DRIVER_RETENTION_UNBOUND" });
    await expect(control.runOnce()).rejects.toMatchObject({ code: "DRIVER_RETENTION_UNBOUND" });
    expect(store.init).not.toHaveBeenCalled(); expect(store.startRetention).not.toHaveBeenCalled(); expect(store.runRetentionOnce).not.toHaveBeenCalled();
    await control.close(); expect(store.close).toHaveBeenCalledTimes(1);
  });

  it("does not replace missing store.init with a fake successful initialization", async () => {
    const { store, matcher } = composedRetention();
    const legacy: DriverStore = { ...store }; delete legacy.init;
    const control = registerDriverMeasurementRoutes(express(), {} as SituationDataConfig,
      { enabled: false, ratePerMinute: 120 }, { store: legacy, matcher, retentionConsumer: syntheticConsumer() });
    await expect(control.start()).rejects.toMatchObject({ code: "DRIVER_RETENTION_UNAVAILABLE" });
    expect(store.startRetention).not.toHaveBeenCalled(); await control.close();
  });

  it("close immediately closes storage during initialization and prevents start", async () => {
    const { control, store } = composedRetention(), initialization = deferred(), storageClose = deferred();
    store.init.mockImplementation(() => initialization.promise); store.close.mockImplementation(() => storageClose.promise);
    const starting = control.start(), startRejected = expect(starting).rejects.toMatchObject({ code: "DRIVER_RETENTION_CLOSED" });
    await microtasks(); expect(store.init).toHaveBeenCalledTimes(1);
    let closed = false; const closing = control.close().then(() => { closed = true; });
    expect(store.close).toHaveBeenCalledTimes(1); expect(store.startRetention).not.toHaveBeenCalled();
    await microtasks(); expect(closed).toBe(false);
    initialization.resolve(); await startRejected; await microtasks(); expect(closed).toBe(false);
    storageClose.resolve(); await closing;
    expect(store.startRetention).not.toHaveBeenCalled();
    await expect(control.start()).rejects.toMatchObject({ code: "DRIVER_RETENTION_CLOSED" });
  });

  it("close does not wait for a pending start before stopping storage admission", async () => {
    const { control, store } = composedRetention(), storageStart = deferred();
    store.startRetention.mockImplementation(() => storageStart.promise);
    const starting = control.start(); await microtasks(); expect(store.startRetention).toHaveBeenCalledTimes(1);
    let closed = false; const closing = control.close().then(() => { closed = true; });
    expect(store.close).toHaveBeenCalledTimes(1); await microtasks(); expect(closed).toBe(false);
    await expect(control.start()).rejects.toMatchObject({ code: "DRIVER_RETENTION_CLOSED" });
    storageStart.resolve(); await starting; await closing;
    expect(store.startRetention).toHaveBeenCalledTimes(1); expect(store.runRetentionOnce).not.toHaveBeenCalled();
  });

  it("concurrent route starts share actual initialization and start once", async () => {
    const { control, store } = composedRetention(), initialization = deferred();
    store.init.mockImplementation(() => initialization.promise);
    const first = control.start(), second = control.start(), explicitInit = control.init();
    await microtasks(); expect(store.init).toHaveBeenCalledTimes(1); expect(store.startRetention).not.toHaveBeenCalled();
    initialization.resolve(); await Promise.all([first, second, explicitInit]); await control.start();
    expect(store.startRetention).toHaveBeenCalledTimes(1); await control.close();
  });

  it.each(["runOnce", "storageClose"] as const)("close awaits both actual runOnce and storage.close when %s settles first", async first => {
    const { control, store } = composedRetention(), storageRun = deferred(), storageClose = deferred();
    store.runRetentionOnce.mockImplementation(() => storageRun.promise); store.close.mockImplementation(() => storageClose.promise);
    const running = control.runOnce(); await microtasks(); expect(store.runRetentionOnce).toHaveBeenCalledTimes(1);
    let closed = false; const closing = control.close().then(() => { closed = true; });
    expect(store.close).toHaveBeenCalledTimes(1);
    (first === "runOnce" ? storageRun : storageClose).resolve(); await microtasks(); expect(closed).toBe(false);
    (first === "runOnce" ? storageClose : storageRun).resolve(); await running; await closing; await control.close();
    expect(store.close).toHaveBeenCalledTimes(1);
    await expect(control.runOnce()).rejects.toMatchObject({ code: "DRIVER_RETENTION_CLOSED" });
  });

  it("a rejected actual storage.close is not reported as a successful drain", async () => {
    const { control, store } = composedRetention(); store.close.mockRejectedValue(new Error("synthetic storage detail"));
    await expect(control.close()).rejects.toMatchObject({ code: "DRIVER_RETENTION_UNAVAILABLE", message: "DRIVER_RETENTION_UNAVAILABLE" });
    expect(store.close).toHaveBeenCalledTimes(1);
  });
});
