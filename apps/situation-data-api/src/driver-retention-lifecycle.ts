import { types } from "node:util";
import type { DriverGuardedOperationRef } from "./driver-guarded-execution-port.js";

/** Local lifecycle seam ONLY, not a native protocol, grant or producer proof. */
export interface DriverRetentionOperationContext {
  readonly owner: "sim_driver_measurements";
  readonly cutoff: string;
  /** Protected-delivery routing metadata only; never application authority. */
  readonly operation?: DriverGuardedOperationRef<"expire">;
}
/**
 * An accepted owner-bound consumer must admit and track this precise maintenance
 * operation using independently reviewed authority/replay controls. The owner
 * literal, Object.freeze and date shape are routing metadata, not that authority.
 * No such production consumer or transport is provided by this module.
 */
export interface DriverRetentionConsumer {
  readonly owner: "sim_driver_measurements";
  execute(work: (operation: DriverRetentionOperationContext) => Promise<void>): Promise<void>;
}
export interface DriverRetentionScheduler {
  set(callback: () => void, intervalMs: number): unknown;
  clear(handle: unknown): void;
}
export interface DriverRetentionControl {
  init(): Promise<void>;
  start(): Promise<void>;
  runOnce(): Promise<void>;
  close(): Promise<void>;
}
export interface DriverRetentionLifecycleOptions {
  readonly initialize: () => Promise<void>;
  readonly cleanup: (operation: DriverRetentionOperationContext) => Promise<void>;
  readonly consumer?: DriverRetentionConsumer;
  readonly scheduler?: DriverRetentionScheduler;
}
export type DriverRetentionLifecycleErrorCode = "DRIVER_RETENTION_UNBOUND" | "DRIVER_RETENTION_INIT_REQUIRED" |
  "DRIVER_RETENTION_CLOSED" | "DRIVER_RETENTION_INVALID_CONTEXT" | "DRIVER_RETENTION_UNAVAILABLE";
/** Fixed safe codes; never include SQL errors, connection strings or owner data. */
export class DriverRetentionLifecycleError extends Error {
  constructor(readonly code: DriverRetentionLifecycleErrorCode) { super(code); this.name = "DriverRetentionLifecycleError"; }
}
function need(condition: unknown, code: DriverRetentionLifecycleErrorCode): asserts condition {
  if (!condition) throw new DriverRetentionLifecycleError(code);
}
function own(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  need(value !== null && typeof value === "object" && !types.isProxy(value), "DRIVER_RETENTION_INVALID_CONTEXT");
  const prototype = Object.getPrototypeOf(value);
  need(prototype === null || prototype === Object.prototype, "DRIVER_RETENTION_INVALID_CONTEXT");
  const names = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  need(keys.every(key => names.includes(key)) && names.every(key => typeof key === "string" &&
    (keys.includes(key) || optional.includes(key)) && descriptors[key] && "value" in descriptors[key]! && descriptors[key]!.enumerable), "DRIVER_RETENTION_INVALID_CONTEXT");
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of names as string[]) snapshot[key] = descriptors[key]!.value;
  return snapshot;
}
function operation(value: unknown): DriverRetentionOperationContext {
  const v = own(value, ["owner", "cutoff"], ["operation"]);
  need(Object.isFrozen(value) && v.owner === "sim_driver_measurements", "DRIVER_RETENTION_INVALID_CONTEXT");
  need(typeof v.cutoff === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v.cutoff), "DRIVER_RETENTION_INVALID_CONTEXT");
  const time = Date.parse(v.cutoff);
  need(Number.isFinite(time) && new Date(time).toISOString() === v.cutoff, "DRIVER_RETENTION_INVALID_CONTEXT");
  if(Object.hasOwn(v,"operation")){
    const root = own(v.operation,["operationId","kind"]);
    need(root.kind==="expire"&&typeof root.operationId==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(root.operationId),"DRIVER_RETENTION_INVALID_CONTEXT");
    return Object.freeze({owner:"sim_driver_measurements",cutoff:v.cutoff,operation:Object.freeze({operationId:root.operationId,kind:"expire"})});
  }
  return Object.freeze({ owner: "sim_driver_measurements", cutoff: v.cutoff });
}
const unavailable = (): never => { throw new DriverRetentionLifecycleError("DRIVER_RETENTION_UNAVAILABLE"); };

/** Constructor has no timer, initializer, dependency dispatch or cleanup call. */
export class DriverRetentionLifecycle implements DriverRetentionControl {
  #initialize: DriverRetentionLifecycleOptions["initialize"];
  #cleanup: DriverRetentionLifecycleOptions["cleanup"];
  #consumer?: DriverRetentionConsumer;
  #scheduler: DriverRetentionScheduler;
  #init?: Promise<void>; #initialized = false;
  #start?: Promise<void>; #started = false;
  #flight?: Promise<void>;
  #close?: Promise<void>; #closed = false;
  #timer: unknown; #timerKnown = false;
  constructor(options: DriverRetentionLifecycleOptions) {
    const o = own(options, ["initialize", "cleanup"], ["consumer", "scheduler"]);
    need(typeof o.initialize === "function" && !types.isProxy(o.initialize) && typeof o.cleanup === "function" && !types.isProxy(o.cleanup), "DRIVER_RETENTION_INVALID_CONTEXT");
    this.#initialize = o.initialize as DriverRetentionLifecycleOptions["initialize"];
    this.#cleanup = o.cleanup as DriverRetentionLifecycleOptions["cleanup"];
    if (o.consumer !== undefined) {
      const c = own(o.consumer, ["owner", "execute"]);
      need(c.owner === "sim_driver_measurements" && typeof c.execute === "function" && !types.isProxy(c.execute), "DRIVER_RETENTION_INVALID_CONTEXT");
      this.#consumer = Object.freeze({ owner: "sim_driver_measurements", execute: c.execute as DriverRetentionConsumer["execute"] });
    }
    if (o.scheduler === undefined) this.#scheduler = Object.freeze({
      set(callback: () => void, intervalMs: number) { const timer = setInterval(callback, intervalMs); timer.unref(); return timer; },
      clear(handle: unknown) { clearInterval(handle as ReturnType<typeof setInterval>); },
    });
    else {
      const s = own(o.scheduler, ["set", "clear"]);
      need(typeof s.set === "function" && !types.isProxy(s.set) && typeof s.clear === "function" && !types.isProxy(s.clear), "DRIVER_RETENTION_INVALID_CONTEXT");
      this.#scheduler = Object.freeze({ set: s.set as DriverRetentionScheduler["set"], clear: s.clear as DriverRetentionScheduler["clear"] });
    }
  }
  init(): Promise<void> {
    if (this.#closed) return Promise.reject(new DriverRetentionLifecycleError("DRIVER_RETENTION_CLOSED"));
    if (!this.#init) this.#init = Promise.resolve().then(async () => {
      need(!this.#closed, "DRIVER_RETENTION_CLOSED");
      try { await this.#initialize(); } catch { return unavailable(); }
      need(!this.#closed, "DRIVER_RETENTION_CLOSED");
      this.#initialized = true;
    });
    return this.#init;
  }
  start(): Promise<void> {
    if (this.#closed) return Promise.reject(new DriverRetentionLifecycleError("DRIVER_RETENTION_CLOSED"));
    // Check missing authority before even considering an initialization attempt.
    if (!this.#consumer) return Promise.reject(new DriverRetentionLifecycleError("DRIVER_RETENTION_UNBOUND"));
    if (!this.#initialized) return Promise.reject(new DriverRetentionLifecycleError("DRIVER_RETENTION_INIT_REQUIRED"));
    if (!this.#start) this.#start = Promise.resolve().then(() => {
      need(!this.#closed, "DRIVER_RETENTION_CLOSED"); this.#started = true;
      try { this.#timer = this.#scheduler.set(() => {
        if (!this.#closed && this.#started) void this.runOnce().catch(() => undefined);
      }, 60_000); this.#timerKnown = true; }
      catch { this.#started = false; return unavailable(); }
      if (this.#closed) {
        try { this.#clearTimer(); } catch { return unavailable(); }
        throw new DriverRetentionLifecycleError("DRIVER_RETENTION_CLOSED");
      }
    });
    return this.#start;
  }
  runOnce(): Promise<void> {
    if (this.#closed) return Promise.reject(new DriverRetentionLifecycleError("DRIVER_RETENTION_CLOSED"));
    if (!this.#consumer) return Promise.reject(new DriverRetentionLifecycleError("DRIVER_RETENTION_UNBOUND"));
    if (!this.#initialized) return Promise.reject(new DriverRetentionLifecycleError("DRIVER_RETENTION_INIT_REQUIRED"));
    if (this.#flight) return this.#flight;
    // Reserve before invoking any injected callback, including a synchronous one.
    const work = Promise.resolve().then(() => this.#dispatch()); this.#flight = work;
    void work.then(() => { if (this.#flight === work) this.#flight = undefined; },
      () => { if (this.#flight === work) this.#flight = undefined; });
    return work;
  }
  async #dispatch(): Promise<void> {
    need(!this.#closed && this.#initialized && this.#consumer, "DRIVER_RETENTION_CLOSED");
    let callbacksOpen = true, invoked = false, rejected = false, dispatchFailed = false;
    let actualWork: Promise<void> | undefined;
    const work = (value: DriverRetentionOperationContext): Promise<void> => {
      let pending: Promise<void>;
      try {
        need(callbacksOpen && !this.#closed && !invoked, "DRIVER_RETENTION_CLOSED"); invoked = true;
        const context = operation(value);
        actualWork = Promise.resolve().then(async () => {
          need(!this.#closed, "DRIVER_RETENTION_CLOSED");
          try { await this.#cleanup(context); } catch { return unavailable(); }
        });
        pending = actualWork;
      } catch (error) {
        rejected = true;
        pending = Promise.reject(error instanceof DriverRetentionLifecycleError ? error : new DriverRetentionLifecycleError("DRIVER_RETENTION_UNAVAILABLE"));
      }
      // A defective consumer ignoring its callback's rejection must not create an
      // unhandled raw exception. It still receives the original rejected promise.
      void pending.catch(() => undefined); return pending;
    };
    try { await this.#consumer.execute(work); } catch { dispatchFailed = true; }
    finally { callbacksOpen = false; }
    // Consumer settlement is NOT cleanup settlement: always await actual SQL.
    if (actualWork) { try { await actualWork; } catch { dispatchFailed = true; } }
    if (!actualWork || dispatchFailed || rejected) unavailable();
  }
  #clearTimer(): void {
    if (this.#timerKnown) { this.#timerKnown = false; this.#scheduler.clear(this.#timer); }
  }
  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closed = true; this.#started = false;
    let clearFailed = false;
    try { this.#clearTimer(); } catch { clearFailed = true; }
    this.#close = Promise.allSettled([this.#init, this.#start, this.#flight].filter((p): p is Promise<void> => !!p))
      .then(() => { if (clearFailed) unavailable(); });
    return this.#close;
  }
}

/**
 * No accepted production maintenance/replay consumer exists yet. This factory
 * deliberately reads no settings/secrets and creates no pool, timer or producer.
 * It is not a production-ready implementation and cannot be made ready by flags.
 */
export function createProductionDriverRetentionLifecycle(): DriverRetentionControl {
  let closed = false;
  const deny = (): Promise<void> => Promise.reject(new DriverRetentionLifecycleError(closed ? "DRIVER_RETENTION_CLOSED" : "DRIVER_RETENTION_UNBOUND"));
  return Object.freeze({ init: deny, start: deny, runOnce: deny, close: async () => { closed = true; } });
}
