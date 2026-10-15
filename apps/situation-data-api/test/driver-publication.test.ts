import { EventEmitter } from "node:events";
import type { Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriverMeasurementError } from "../src/driver-measurements.js";
import {
  publishDriverReport,
  type DriverPublicationLease,
  type DriverPublicationPort
} from "../src/driver-publication.js";

// Synthetic response/port tests only. No Root metadata lock, exclusive writer,
// native producer, lease/release proof, enrollment or production acceptance.
class SyntheticResponse extends EventEmitter {
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  closed = false;
  autoFinish = false;
  autoClose = true;
  json = vi.fn((_value: unknown) => {
    this.headersSent = true;
    this.writableEnded = true;
    if (this.autoFinish) queueMicrotask(() => this.finish());
    return this;
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
    if (this.autoClose) queueMicrotask(() => this.close());
    return this;
  });
  finish() { this.writableFinished = true; this.emit("finish"); }
  close() { this.destroyed = true; this.closed = true; this.emit("close"); }
  response(): Response { return this as unknown as Response; }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function syntheticPort(lease: DriverPublicationLease = { assertCurrent: vi.fn(async () => undefined) }) {
  let released = false, callbackSettled = false;
  const withLease = vi.fn(async (_request: unknown, work: (value: DriverPublicationLease) => Promise<unknown>) => {
    try { return await work(lease); }
    finally { callbackSettled = true; released = true; }
  });
  return { lease, withLease, port: { withLease } as DriverPublicationPort, released: () => released, callbackSettled: () => callbackSettled };
}
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
function cleaned(response: SyntheticResponse) {
  for (const event of ["finish", "close", "error"]) expect(response.listenerCount(event)).toBe(0);
}
const fixed = { status: 503, code: "DRIVER_MEASUREMENTS_UNAVAILABLE" };
const warning = JSON.stringify({ event: "driver_report_publication_unavailable", code: "DRIVER_MEASUREMENTS_UNAVAILABLE" });
beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Driver report publication: local lifecycle mechanics only", () => {
  it("an unbound port fails before SQL work or response listeners", async () => {
    const response = new SyntheticResponse(), work = vi.fn(async () => ({ private: "not sent" }));
    await expect(publishDriverReport(response.response(), "aggregates", undefined, work)).rejects.toMatchObject(fixed);
    expect(work).not.toHaveBeenCalled(); expect(response.json).not.toHaveBeenCalled(); cleaned(response);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("port acquisition failure before headers returns only the fixed 503", async () => {
    const response = new SyntheticResponse(), work = vi.fn();
    const port = { withLease: vi.fn(async () => { throw new Error("synthetic secret provider failure"); }) } as DriverPublicationPort;
    await expect(publishDriverReport(response.response(), "quality", port, work)).rejects.toMatchObject(fixed);
    expect(work).not.toHaveBeenCalled(); expect(response.json).not.toHaveBeenCalled(); cleaned(response);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("orders actual SQL, current check and JSON; holds the callback until actual finish", async () => {
    const response = new SyntheticResponse(), sql = deferred<unknown>(), root = syntheticPort(), order: string[] = [];
    const work = vi.fn(async () => {
      for (const event of ["finish", "close", "error"]) expect(response.listenerCount(event)).toBe(1);
      order.push("sql-start"); const value = await sql.promise; order.push("sql-settled"); return value;
    });
    vi.mocked(root.lease.assertCurrent).mockImplementation(async () => { order.push("assert-current"); });
    response.json.mockImplementation(value => { order.push("json"); response.headersSent = true; response.writableEnded = true; return response; });
    let done = false;
    const publication = publishDriverReport(response.response(), "aggregates", root.port, work).then(() => { done = true; });
    await flush(); expect(root.withLease).toHaveBeenCalledWith({ kind: "aggregates" }, expect.any(Function));
    expect(root.released()).toBe(false); expect(response.json).not.toHaveBeenCalled();
    sql.resolve({ aggregateCount: 4 }); await flush();
    expect(order).toEqual(["sql-start", "sql-settled", "assert-current", "json"]);
    expect(response.json).toHaveBeenCalledExactlyOnceWith({ aggregateCount: 4 });
    expect(done).toBe(false); expect(root.callbackSettled()).toBe(false);
    response.finish(); await publication;
    expect(root.released()).toBe(true); expect(done).toBe(true); cleaned(response);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("a client close during SQL never releases the callback before the query settles", async () => {
    const response = new SyntheticResponse(), sql = deferred<unknown>(), root = syntheticPort();
    const publication = publishDriverReport(response.response(), "quality", root.port, () => sql.promise);
    response.close(); await flush();
    expect(root.released()).toBe(false); expect(root.lease.assertCurrent).not.toHaveBeenCalled();
    sql.resolve({ count: 0 }); await publication;
    expect(root.lease.assertCurrent).toHaveBeenCalledTimes(1); expect(root.released()).toBe(true);
    expect(response.json).not.toHaveBeenCalled(); expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning); cleaned(response);
  });

  it("a pre-header query failure becomes a fixed 503 after actual SQL rejection", async () => {
    const response = new SyntheticResponse(), sql = deferred<unknown>(), root = syntheticPort();
    const result = publishDriverReport(response.response(), "aggregates", root.port, () => sql.promise);
    const rejection = expect(result).rejects.toMatchObject(fixed);
    sql.reject(new Error("synthetic query failure with raw secret")); await rejection;
    expect(root.released()).toBe(true); expect(root.lease.assertCurrent).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled(); expect(console.warn).not.toHaveBeenCalled(); cleaned(response);
  });

  it("a current-check failure cannot publish a pre-header 200", async () => {
    const response = new SyntheticResponse(), root = syntheticPort({ assertCurrent: vi.fn(async () => { throw new Error("synthetic stale generation"); }) });
    await expect(publishDriverReport(response.response(), "quality", root.port, async () => ({ count: 1 }))).rejects.toBeInstanceOf(DriverMeasurementError);
    expect(response.json).not.toHaveBeenCalled(); expect(root.released()).toBe(true); cleaned(response);
  });

  it("a failure after headers destroys HTTP and awaits actual close without a second write", async () => {
    const response = new SyntheticResponse(); response.autoClose = false;
    const root = syntheticPort(); let settled = false;
    const result = publishDriverReport(response.response(), "aggregates", root.port, async () => {
      response.headersSent = true; throw new Error("synthetic failure after headers");
    }).then(() => { settled = true; });
    await flush(); expect(response.destroy).toHaveBeenCalled(); expect(settled).toBe(false); expect(root.released()).toBe(false);
    response.close(); await result;
    expect(response.json).not.toHaveBeenCalled(); expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning); cleaned(response);
  });

  it("a release error after a finished response is only a fixed safe warning", async () => {
    const response = new SyntheticResponse(); response.autoFinish = true;
    const port = { withLease: vi.fn(async (_input: unknown, work: (lease: DriverPublicationLease) => Promise<unknown>) => {
      await work({ assertCurrent: async () => undefined }); throw new Error("synthetic release secret");
    }) } as DriverPublicationPort;
    await expect(publishDriverReport(response.response(), "quality", port, async () => ({ count: 2 }))).resolves.toBeUndefined();
    expect(response.json).toHaveBeenCalledExactlyOnceWith({ count: 2 });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning); cleaned(response);
  });

  it("a 15s response timeout destroys only HTTP, still awaiting unsettled SQL and actual close", async () => {
    vi.useFakeTimers();
    const response = new SyntheticResponse(); response.autoClose = false;
    const root = syntheticPort(), sql = deferred<unknown>(); let settled = false;
    const result = publishDriverReport(response.response(), "aggregates", root.port, () => sql.promise).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(14_999); expect(response.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(response.destroy).toHaveBeenCalledTimes(1);
    expect(root.released()).toBe(false); expect(settled).toBe(false); expect(response.closed).toBe(false);
    sql.resolve({ count: 3 }); await flush();
    expect(root.released()).toBe(false); expect(response.json).not.toHaveBeenCalled();
    response.close(); await result;
    expect(root.released()).toBe(true); expect(settled).toBe(true); expect(vi.getTimerCount()).toBe(0);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning); cleaned(response);
  });

  it("a response error is handled, never abandons SQL, and never logs its contents", async () => {
    const response = new SyntheticResponse(), root = syntheticPort(), sql = deferred<unknown>();
    const result = publishDriverReport(response.response(), "quality", root.port, () => sql.promise);
    expect(() => response.emit("error", new Error("synthetic raw response details"))).not.toThrow();
    await flush(); expect(root.released()).toBe(false);
    sql.resolve({ count: 0 }); await result;
    expect(response.json).not.toHaveBeenCalled(); expect(root.released()).toBe(true);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning); cleaned(response);
  });

  it("writableEnded without finish is not proof that publication has drained", async () => {
    const response = new SyntheticResponse(); response.headersSent = true; response.writableEnded = true;
    const root = syntheticPort();
    const result = publishDriverReport(response.response(), "quality", root.port, async () => ({ count: 0 }));
    await flush(); expect(root.released()).toBe(false); expect(response.json).not.toHaveBeenCalled();
    response.finish(); await result; expect(root.released()).toBe(true); cleaned(response);
  });

  it("a port that resolves without calling its callback cannot produce a success", async () => {
    const response = new SyntheticResponse(), work = vi.fn(async () => ({ count: 0 }));
    let late!: (lease: DriverPublicationLease) => Promise<unknown>;
    const port = { withLease: async (_input: unknown, callback: typeof late) => { late = callback; } } as unknown as DriverPublicationPort;
    await expect(publishDriverReport(response.response(), "quality", port, work)).rejects.toMatchObject(fixed);
    await expect(late({ assertCurrent: async () => undefined })).rejects.toMatchObject(fixed);
    expect(work).not.toHaveBeenCalled(); expect(response.json).not.toHaveBeenCalled(); cleaned(response);
  });

  it.each(["resolve", "reject"] as const)("a port that %ss before SQL settles cannot publish later, but still awaits SQL", async outcome => {
    const response = new SyntheticResponse(), sql = deferred<unknown>(); let done = false;
    const port = { withLease: async (_input: unknown, callback: (lease: DriverPublicationLease) => Promise<unknown>) => {
      void callback({ assertCurrent: async () => undefined }).catch(() => undefined);
      if(outcome === "reject") throw new Error("synthetic early transport failure");
    } } as unknown as DriverPublicationPort;
    const publication = publishDriverReport(response.response(), "quality", port, () => sql.promise);
    const checked = expect(publication).rejects.toMatchObject(fixed).then(() => { done = true; });
    await flush(); expect(done).toBe(false); expect(response.json).not.toHaveBeenCalled();
    sql.resolve({ count: 0 }); await checked;
    expect(done).toBe(true); expect(response.json).not.toHaveBeenCalled(); cleaned(response);
  });

  it.each(["resolve", "reject"] as const)("a port that %ss after JSON but before finish immediately aborts HTTP and still awaits close", async outcome => {
    const response = new SyntheticResponse(); response.autoClose = false;
    const exit = deferred<void>(); let done = false;
    const port = { withLease: async (_input: unknown, callback: (lease: DriverPublicationLease) => Promise<unknown>) => {
      void callback({ assertCurrent: async () => undefined }).catch(() => undefined);
      await exit.promise;
      if(outcome === "reject") throw new Error("synthetic early release");
    } } as unknown as DriverPublicationPort;
    const publication = publishDriverReport(response.response(), "quality", port, async () => ({ count: 0 })).then(() => { done = true; });
    await flush(); expect(response.json).toHaveBeenCalledTimes(1); expect(response.destroy).not.toHaveBeenCalled();
    exit.resolve(); await flush(); expect(response.destroy).toHaveBeenCalledTimes(1); expect(done).toBe(false);
    response.close(); await publication;
    expect(response.json).toHaveBeenCalledTimes(1); expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning); cleaned(response);
  });
});
