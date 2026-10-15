import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composeDriverOwnerBindings,
  loadProductionDriverOwnerComposition,
  type DriverOwnerBindings,
  type DriverRootHttpScope,
  type DriverRootRequestScope
} from "../src/driver-owner-composition.js";

// Synthetic ports/filesystem only. These tests are neither actual COP factories,
// signed Root authority, enrollment/lease/drain evidence nor production proof.
const fs = vi.hoisted(() => ({ lstat: vi.fn(), realpath: vi.fn(), readdir: vi.fn() }));
vi.mock("node:fs/promises", () => fs);
const PREFIX = "/api/v1/internal/driver-measurements/v1";
const ROOT = "/opt/cop-account-safety";
const MODULE_NAMES = ["driver-root-channel.mjs", "driver-root-inspect.mjs", "driver-root-context.mjs", "driver-root-retention.mjs"];
function item(file = false, changes: Record<string, unknown> = {}) {
  return { uid: 0, mode: file ? 0o644 : 0o755, nlink: 1, isSymbolicLink: () => false,
    isFile: () => file, isDirectory: () => !file, ...changes };
}
function bindings(run?: DriverRootRequestScope["run"]): DriverOwnerBindings {
  return {
    execution: { execute: vi.fn(), probe: vi.fn() },
    admission: { inspect: vi.fn(async () => undefined) },
    requestScope: { context: { current: vi.fn(async () => undefined) }, run: run ?? ((_scope, work) => work()) },
    retentionConsumer: { owner: "sim_driver_measurements", execute: vi.fn(async () => undefined) }
  };
}
function request(method: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return { method, path, body, get: vi.fn((name: string) => headers[name]) } as unknown as Request;
}
function response(): Response {
  return Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false }) as unknown as Response;
}
function invoke(owner: ReturnType<typeof composeDriverOwnerBindings>, input: Request, next = vi.fn(), output = response()) {
  owner.driverScopeMiddleware(input, output, next as NextFunction);
  return next;
}
beforeEach(() => {
  vi.clearAllMocks();
  fs.lstat.mockImplementation(async (path: string) => item(path.endsWith(".mjs")));
  fs.realpath.mockImplementation(async (path: string) => path);
  fs.readdir.mockImplementation(async (path: string) => path === ROOT ? MODULE_NAMES : []);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("Driver owner composition: synthetic local mechanics only", () => {
  it("composes the exact supplied ports without invoking or minting authority", () => {
    const supplied = bindings(), composed = composeDriverOwnerBindings(supplied);
    expect(composed.driverMeasurements.guarded).toEqual({ execution: supplied.execution, admission: supplied.admission });
    expect(composed.driverMeasurements.guardedRequestContext).toBe(supplied.requestScope.context);
    expect(composed.driverMeasurements.retentionConsumer).toBe(supplied.retentionConsumer);
    expect(supplied.execution.execute).not.toHaveBeenCalled();
    expect(supplied.execution.probe).not.toHaveBeenCalled();
    expect(supplied.admission.inspect).not.toHaveBeenCalled();
    expect(supplied.retentionConsumer.execute).not.toHaveBeenCalled();
    expect(Object.isFrozen(composed.driverMeasurements.guarded)).toBe(true);
  });

  it.each([["DELETE", "/contributions"], ["POST", "/account-erasure-operations"]])(
    "passes only the exact six routing fields for %s %s", (method, suffix) => {
      const run = vi.fn((_scope: DriverRootHttpScope, work: () => unknown, _settled: AbortSignal) => work());
      const body = { contractVersion: "synthetic-test-only" };
      const input = request(method, PREFIX + suffix, body, { authorization: "Bearer synthetic", "x-cop-actor": "actor", "x-cop-actor-signature": "signature", "x-extra": "not-forwarded" });
      const next = invoke(composeDriverOwnerBindings(bindings(run as DriverRootRequestScope["run"])), input);
      expect(next).toHaveBeenCalledExactlyOnceWith();
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).toEqual({ method, path: PREFIX + suffix, authorization: "Bearer synthetic", actor: "actor", actorSignature: "signature", body });
      expect(run.mock.calls[0]?.[0].body).toBe(body);
      expect(run.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
      expect(run.mock.calls[0]?.[2].aborted).toBe(false);
    });

  it.each([
    ["POST", "/batches"], ["POST", "/account-erasure-operations/preflight"],
    ["GET", "/account-erasure-operations/capability"], ["GET", "/account-erasure-operations/id"],
    ["GET", "/contributions"], ["POST", "/contributions"], ["DELETE", "/contributions/"],
    ["POST", "/account-erasure-operations/"], ["OPTIONS", "/account-erasure-operations"]
  ])("never forwards GPS/other route bodies to Root scope: %s %s", (method, suffix) => {
    const run = vi.fn((_scope: DriverRootHttpScope, work: () => unknown) => work());
    const input = request(method, PREFIX + suffix, { points: [{ lat: 50.1, lon: 14.2 }] }), output = response();
    expect(invoke(composeDriverOwnerBindings(bindings(run as DriverRootRequestScope["run"])), input, vi.fn(), output)).toHaveBeenCalledExactlyOnceWith();
    expect(run).not.toHaveBeenCalled(); expect(input.get).not.toHaveBeenCalled();
    expect(output.listenerCount("finish")).toBe(0); expect(output.listenerCount("close")).toBe(0);
  });

  it("continues unbound when scope validation throws before forwarding, preserving handler 401/400 ordering", () => {
    const current = vi.fn(async () => undefined);
    const run = vi.fn((_scope: DriverRootHttpScope, _work: () => unknown): never => { throw new Error("synthetic invalid scope"); });
    const supplied = bindings(run); supplied.requestScope.context.current = current;
    const next = invoke(composeDriverOwnerBindings(supplied), request("POST", `${PREFIX}/account-erasure-operations`, undefined));
    expect(next).toHaveBeenCalledExactlyOnceWith(); expect(current).not.toHaveBeenCalled();
    expect(run.mock.calls[0]?.[0]).toMatchObject({ authorization: "", actor: "", actorSignature: "" });
  });

  it("never forwards twice if the scope wrapper throws after invoking work", () => {
    let signal!: AbortSignal;
    const run: DriverRootRequestScope["run"] = (_scope, work, settled) => { signal = settled; work(); throw new Error("synthetic after-forward failure"); };
    const output = response();
    expect(invoke(composeDriverOwnerBindings(bindings(run)), request("DELETE", `${PREFIX}/contributions`), vi.fn(), output)).toHaveBeenCalledExactlyOnceWith();
    expect(signal.aborted).toBe(true); expect(output.listenerCount("finish")).toBe(0); expect(output.listenerCount("close")).toBe(0);
  });

  it.each(["finish", "close"])("synchronously aborts on %s during forwarding and removes both one-shot listeners", event => {
    const output = response(), aborted = vi.fn(); let signal!: AbortSignal;
    const run: DriverRootRequestScope["run"] = (_scope, work, settled) => {
      signal = settled; expect(settled.aborted).toBe(false); settled.addEventListener("abort", aborted); return work();
    };
    const next = vi.fn(() => { output.emit(event); expect(signal.aborted).toBe(true); });
    invoke(composeDriverOwnerBindings(bindings(run)), request("POST", `${PREFIX}/account-erasure-operations`), next, output);
    expect(next).toHaveBeenCalledExactlyOnceWith(); expect(aborted).toHaveBeenCalledTimes(1);
    expect(output.listenerCount("finish")).toBe(0); expect(output.listenerCount("close")).toBe(0);
    output.emit("finish"); output.emit("close"); expect(aborted).toHaveBeenCalledTimes(1);
  });

  it("aborts and cleans up before an unbound continuation when scope validation throws", () => {
    const output = response(); let signal!: AbortSignal;
    const run: DriverRootRequestScope["run"] = (_scope, _work, settled) => { signal = settled; throw new Error("synthetic invalid scope"); };
    const next = vi.fn(() => { expect(signal.aborted).toBe(true); });
    invoke(composeDriverOwnerBindings(bindings(run)), request("POST", `${PREFIX}/account-erasure-operations`), next, output);
    expect(next).toHaveBeenCalledExactlyOnceWith(); expect(output.listenerCount("finish")).toBe(0); expect(output.listenerCount("close")).toBe(0);
  });

  it("uses different settlement controllers for concurrent responses without a TTL release", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [], run: DriverRootRequestScope["run"] = (_scope, work, settled) => { signals.push(settled); return work(); };
      const owner = composeDriverOwnerBindings(bindings(run)), first = response(), second = response();
      for (const output of [first, second]) invoke(owner, request("POST", `${PREFIX}/account-erasure-operations`), vi.fn(), output);
      expect(signals).toHaveLength(2); expect(signals[0]).not.toBe(signals[1]);
      await vi.advanceTimersByTimeAsync(60_000); expect(signals.every(signal => !signal.aborted)).toBe(true);
      first.emit("close"); expect(signals[0].aborted).toBe(true); expect(signals[1].aborted).toBe(false);
      expect(second.listenerCount("finish")).toBe(1); expect(second.listenerCount("close")).toBe(1);
      second.emit("finish"); expect(signals[1].aborted).toBe(true);
      for (const output of [first, second]) { expect(output.listenerCount("finish")).toBe(0); expect(output.listenerCount("close")).toBe(0); }
    } finally { vi.useRealTimers(); }
  });

  it("keeps concurrent local async scopes separate without treating ALS as authority", async () => {
    const storage = new AsyncLocalStorage<DriverRootHttpScope>();
    const supplied = bindings((scope, work) => storage.run(scope, work));
    const observed: (DriverRootHttpScope | undefined)[] = [];
    const owner = composeDriverOwnerBindings(supplied);
    let release!: () => void;
    const barrier = new Promise<void>(yes => { release = yes; });
    const pending: Promise<void>[] = [];
    for (const actor of ["synthetic-a", "synthetic-b"]) {
      invoke(owner, request("POST", `${PREFIX}/account-erasure-operations`, {}, { "x-cop-actor": actor }), vi.fn(() => {
        pending.push((async () => { await barrier; observed.push(storage.getStore()); })());
      }));
    }
    release(); await Promise.all(pending);
    expect(observed.map(scope => scope?.actor)).toEqual(["synthetic-a", "synthetic-b"]);
    expect(storage.getStore()).toBeUndefined();
    expect(supplied.requestScope.context.current).not.toHaveBeenCalled();
  });
});

describe("fixed production loader fails closed before imports", () => {
  async function unavailable() {
    const owner = await loadProductionDriverOwnerComposition();
    expect(owner.driverMeasurements).toEqual({ guarded: {} });
    expect(owner.driverMeasurements.guarded).not.toBeUndefined();
    expect(invoke(owner, request("POST", `${PREFIX}/account-erasure-operations`))).toHaveBeenCalledExactlyOnceWith();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "driver_owner_authority_unavailable", code: "OWNER_BINDING_UNAVAILABLE" }));
  }
  it("does not select legacy SQL when the fixed owner module is missing", async () => {
    fs.lstat.mockRejectedValue(new Error("synthetic missing module")); await unavailable();
  });
  it.each([
    { uid: 501 }, { mode: 0o666 }, { nlink: 2 }, { isSymbolicLink: () => true },
    { isFile: () => false, isDirectory: () => false }
  ])("rejects non-root/mutable/linked/non-ordinary fixed modules: %j", async change => {
    fs.lstat.mockImplementation(async (path: string) => item(path.endsWith(".mjs"), path.endsWith("driver-root-channel.mjs") ? change : {}));
    await unavailable(); expect(fs.readdir).not.toHaveBeenCalled();
  });
  it("checks all four fixed entry paths including retention and rejects a redirected path", async () => {
    fs.realpath.mockImplementation(async (path: string) => path.endsWith("driver-root-retention.mjs") ? "/synthetic/redirect.mjs" : path);
    await unavailable(); expect(fs.realpath).toHaveBeenCalledWith(`${ROOT}/driver-root-retention.mjs`);
    expect(fs.readdir).not.toHaveBeenCalled();
  });
  it("rejects a mutable imported dependency in the entire closure before importing an entry", async () => {
    fs.readdir.mockImplementation(async (path: string) => path === ROOT ? [...MODULE_NAMES, "helpers"] : ["unsafe.mjs"]);
    fs.lstat.mockImplementation(async (path: string) => item(path.endsWith(".mjs"), path.endsWith("unsafe.mjs") ? { mode: 0o666 } : {}));
    await unavailable(); expect(fs.readdir).toHaveBeenCalledWith(`${ROOT}/helpers`);
  });
  it("rejects a symlinked dependency directory without traversing it", async () => {
    fs.readdir.mockResolvedValue(["linked"]);
    fs.lstat.mockImplementation(async (path: string) => item(path.endsWith(".mjs"), path === `${ROOT}/linked` ? { isSymbolicLink: () => true } : {}));
    await unavailable(); expect(fs.readdir).not.toHaveBeenCalledWith(`${ROOT}/linked`);
  });
  it("bounds the full closure before executing any fixed owner module", async () => {
    fs.readdir.mockResolvedValue(Array.from({ length: 20_001 }, (_, index) => `helper-${index}.mjs`));
    await unavailable(); expect(fs.lstat.mock.calls.length).toBe(20_007);
  });
});
