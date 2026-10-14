/**
 * OFFLINE V5 FIXTURE COMPANION ONLY — no application import or built-in transport.
 * Constructor binding is explicit fixture configuration, NOT enrollment.
 * CAS snapshots, opaque registry digests and historical markers prove no actual
 * identity/admission/lease provenance. The server owes origin, refs, registry,
 * grant and fence checks; this client never invents their authority or outcomes.
 */
import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalAsciiFixtureBytes, parseStrictFixturePacket } from "./dormant-fixture-json.mjs";

export const DORMANT_V5_PROTOCOL = "cop-dormant-boundary-fixture-v5" as const;
export type DormantMethod = "current" | "admit" | "begin_commit" | "unknown" | "settle" | "drain";
export type DormantOperationCode = "cop-actor-read" | "cop-actor-write" | "cop-actor-cleanup" |
  "cop-actor-background" | "cop-actor-new-login" | "cop-actor-publish" | "cop-actor-cache" |
  "cop-actor-quality" | "cop-actor-maintenance" | "cop-actor-replay" | "cop-owner-publish" |
  "cop-owner-cache" | "cop-owner-quality" | "cop-owner-maintenance" | "cop-owner-replay";
export interface DormantOperation {
  readonly operationId: string; readonly bodyDigest: string;
  readonly schemaDigest: string; readonly operationCode: DormantOperationCode;
}
export interface DormantCas {
  readonly scopeRef: string; readonly orderSequence: number; readonly orderDigest: string;
  readonly checkpointId: string; readonly checkpointGeneration: number; readonly checkpointDigest: string;
  readonly fenceSequence: number; readonly fenceDigest: string;
}
/** requestDigest is opaque server-registry data, never the request/frame hash. */
export interface DormantLease { readonly leaseId: string; readonly requestDigest: string; readonly historical: boolean }
export interface DormantPermit { readonly permitId: string; readonly leaseId: string; readonly requestDigest: string }
export interface DormantReference { readonly recordId: string; readonly recordDigest: string }
export interface DormantRefs {
  readonly "identity-ownership": DormantReference; readonly "retention-decision": DormantReference;
  readonly "report-protection": DormantReference; readonly "operation-schema": DormantReference;
}
export interface DormantArgs {
  current: Readonly<Record<string, never>>;
  admit: { readonly cas: DormantCas; readonly refs: DormantRefs; readonly leaseSeconds: number };
  begin_commit: { readonly cas: DormantCas; readonly lease: DormantLease };
  unknown: { readonly lease: DormantLease; readonly reason: "death" | "exec" | "timeout" | "disconnect" | "unknown" };
  settle: { readonly lease: DormantLease; readonly observed: DormantReference };
  drain: { readonly cas: DormantCas };
}
export interface DormantResults {
  current: { readonly cas: DormantCas };
  admit: { readonly lease: DormantLease; readonly ack: "historical-only" | "fixture-registered" };
  begin_commit: { readonly permit: DormantPermit };
  unknown: { readonly state: "registered-pending" };
  settle: { readonly state: "synthetic-original-terminal-recorded" | "historical-terminal-ack" };
  drain: { readonly state: "pending" | "fixture-drained"; readonly pending: number; readonly scope: "principal" | "owner-wide" };
}
export interface DormantRequest<M extends DormantMethod = DormantMethod> {
  readonly protocol: typeof DORMANT_V5_PROTOCOL; readonly mode: "own-fixture-only";
  readonly requestId: string; readonly bindingDigest: string; readonly method: M;
  readonly operation: DormantOperation; readonly args: DormantArgs[M];
}
export interface DormantFalseFlags {
  readonly productionAuthorization: false; readonly actualProducer: false; readonly actualAdmission: false;
  readonly actualIdentity: false; readonly actualOwnerEvidence: false; readonly actualIndependentAnchor: false;
  readonly actualProvider: false; readonly actualSimPreservation: false; readonly actualRestore: false;
  readonly ownerWideReplayComplete: false; readonly kernelDatabaseAtomicityClaim: false;
}
export interface DormantSuccess<M extends DormantMethod = DormantMethod> {
  readonly protocol: typeof DORMANT_V5_PROTOCOL; readonly mode: "own-fixture-only";
  readonly requestId: string; readonly bindingDigest: string; readonly method: M;
  readonly frameDigest: string; readonly correlationDigest: string;
  readonly result: DormantResults[M]; readonly flags: DormantFalseFlags;
}
export interface DormantErrorResponse {
  readonly protocol: typeof DORMANT_V5_PROTOCOL; readonly mode: "own-fixture-only";
  readonly correlation: null | { readonly requestId: string; readonly frameDigest: string; readonly correlationDigest: string };
  readonly error: { readonly code: "denied-or-unknown"; readonly state: "unresolved"; readonly operationOutcome: "unknown-not-settled" };
  readonly flags: DormantFalseFlags;
}
export type DormantCodecErrorCode = "INVALID_REQUEST" | "INVALID_RESPONSE" | "CORRELATION_MISMATCH" |
  "BINDING_MISMATCH" | "FIXTURE_MODE_REQUIRED" | "INVALID_OPTIONS" | "CAPACITY_LIMIT";
export class DormantCodecError extends Error {
  constructor(readonly code: DormantCodecErrorCode) { super(code); this.name = "DormantCodecError"; }
}
export class DormantIndeterminateError extends Error {
  readonly code = "INDETERMINATE" as const;
  constructor(readonly reason: "CALLER_DEADLINE" | "CALLER_ABORTED" | "EXCHANGE_UNKNOWN" | "FIXTURE_UNKNOWN") {
    super("INDETERMINATE"); this.name = "DormantIndeterminateError";
  }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const METHODS: readonly DormantMethod[] = ["current", "admit", "begin_commit", "unknown", "settle", "drain"];
const CODES: readonly DormantOperationCode[] = ["cop-actor-read", "cop-actor-write", "cop-actor-cleanup", "cop-actor-background",
  "cop-actor-new-login", "cop-actor-publish", "cop-actor-cache", "cop-actor-quality", "cop-actor-maintenance", "cop-actor-replay",
  "cop-owner-publish", "cop-owner-cache", "cop-owner-quality", "cop-owner-maintenance", "cop-owner-replay"];
const FLAGS = ["productionAuthorization", "actualProducer", "actualAdmission", "actualIdentity", "actualOwnerEvidence",
  "actualIndependentAnchor", "actualProvider", "actualSimPreservation", "actualRestore", "ownerWideReplayComplete", "kernelDatabaseAtomicityClaim"] as const;
const CAS_KEYS = ["scopeRef", "orderSequence", "orderDigest", "checkpointId", "checkpointGeneration", "checkpointDigest", "fenceSequence", "fenceDigest"];
const REF_KEYS = ["identity-ownership", "retention-decision", "report-protection", "operation-schema"];
function need(condition: unknown, code: DormantCodecErrorCode): asserts condition {
  if (!condition) throw new DormantCodecError(code);
}
function record(value: unknown, required: readonly string[], code: DormantCodecErrorCode, optional: readonly string[] = []): Record<string, unknown> {
  need(value !== null && typeof value === "object" && !types.isProxy(value), code);
  const prototype = Object.getPrototypeOf(value);
  need(prototype === null || prototype === Object.prototype, code);
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  need(keys.every(key => typeof key === "string" && (required.includes(key) || optional.includes(key))), code);
  need(required.every(key => keys.includes(key)), code);
  need(keys.every(key => typeof key === "string" && descriptors[key] && "value" in descriptors[key]! && descriptors[key]!.enumerable), code);
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) snapshot[key] = descriptors[key]!.value;
  return snapshot;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
const uuid = (value: unknown, code: DormantCodecErrorCode): string => { need(typeof value === "string" && UUID.test(value), code); return value; };
const digest = (value: unknown, code: DormantCodecErrorCode): string => { need(typeof value === "string" && DIGEST.test(value), code); return value; };
const counter = (value: unknown, code: DormantCodecErrorCode): number => { need(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, code); return value; };
function operation(value: unknown, code: DormantCodecErrorCode): DormantOperation {
  const v = record(value, ["operationId", "bodyDigest", "schemaDigest", "operationCode"], code);
  uuid(v.operationId, code); digest(v.bodyDigest, code); digest(v.schemaDigest, code);
  need(typeof v.operationCode === "string" && CODES.includes(v.operationCode as DormantOperationCode), code);
  return v as unknown as DormantOperation;
}
function cas(value: unknown, operationId: string, code: DormantCodecErrorCode): DormantCas {
  const v = record(value, CAS_KEYS, code);
  need(uuid(v.scopeRef, code) === operationId, code); uuid(v.checkpointId, code);
  for (const key of ["orderSequence", "checkpointGeneration", "fenceSequence"]) counter(v[key], code);
  for (const key of ["orderDigest", "checkpointDigest", "fenceDigest"]) digest(v[key], code);
  return v as unknown as DormantCas;
}
function lease(value: unknown, code: DormantCodecErrorCode): DormantLease {
  const v = record(value, ["leaseId", "requestDigest", "historical"], code);
  uuid(v.leaseId, code); digest(v.requestDigest, code); need(typeof v.historical === "boolean", code);
  return v as unknown as DormantLease;
}
function reference(value: unknown, code: DormantCodecErrorCode): DormantReference {
  const v = record(value, ["recordId", "recordDigest"], code);
  uuid(v.recordId, code); digest(v.recordDigest, code); return v as unknown as DormantReference;
}
function request(value: unknown): DormantRequest {
  const code = "INVALID_REQUEST" as const;
  const v = record(value, ["protocol", "mode", "requestId", "bindingDigest", "method", "operation", "args"], code);
  need(v.protocol === DORMANT_V5_PROTOCOL && v.mode === "own-fixture-only", code);
  uuid(v.requestId, code); digest(v.bindingDigest, code);
  need(typeof v.method === "string" && METHODS.includes(v.method as DormantMethod), code);
  const op = operation(v.operation, code), method = v.method as DormantMethod;
  switch (method) {
    case "current": record(v.args, [], code); break;
    case "admit": {
      const a = record(v.args, ["cas", "refs", "leaseSeconds"], code); cas(a.cas, op.operationId, code);
      const refs = record(a.refs, REF_KEYS, code); for (const key of REF_KEYS) reference(refs[key], code);
      need(counter(a.leaseSeconds, code) >= 1 && (a.leaseSeconds as number) <= 300, code); break;
    }
    case "begin_commit": { const a = record(v.args, ["cas", "lease"], code); cas(a.cas, op.operationId, code); lease(a.lease, code); break; }
    case "unknown": {
      const a = record(v.args, ["lease", "reason"], code); lease(a.lease, code);
      need(typeof a.reason === "string" && ["death", "exec", "timeout", "disconnect", "unknown"].includes(a.reason), code); break;
    }
    case "settle": { const a = record(v.args, ["lease", "observed"], code); lease(a.lease, code); reference(a.observed, code); break; }
    case "drain": { const a = record(v.args, ["cas"], code); cas(a.cas, op.operationId, code); break; }
  }
  return freeze(v as unknown as DormantRequest);
}
export function decodeDormantRequest(bytes: Uint8Array): DormantRequest { return request(parseStrictFixturePacket(bytes)); }
export function encodeDormantRequest(value: unknown): Uint8Array {
  return canonicalAsciiFixtureBytes(decodeDormantRequest(canonicalAsciiFixtureBytes(value)));
}
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export function dormantRequestDigests(value: unknown): Readonly<{ frameDigest: string; correlationDigest: string }> {
  const normalized = decodeDormantRequest(encodeDormantRequest(value));
  const frameDigest = sha(canonicalAsciiFixtureBytes(normalized));
  const correlationDigest = sha(canonicalAsciiFixtureBytes({ protocol: DORMANT_V5_PROTOCOL, requestId: normalized.requestId,
    method: normalized.method, operationId: normalized.operation.operationId, frameDigest }));
  return Object.freeze({ frameDigest, correlationDigest });
}
export function decodeDormantResponse<M extends DormantMethod>(bytes: Uint8Array, expected: DormantRequest<M>): DormantSuccess<M> | DormantErrorResponse {
  const req = decodeDormantRequest(encodeDormantRequest(expected)), code = "INVALID_RESPONSE" as const;
  const values = dormantRequestDigests(req), parsed = parseStrictFixturePacket(bytes);
  const base = record(parsed, [], code, ["protocol", "mode", "requestId", "bindingDigest", "method", "frameDigest", "correlationDigest", "result", "flags", "correlation", "error"]);
  need(base.protocol === DORMANT_V5_PROTOCOL && base.mode === "own-fixture-only", code);
  const flags = record(base.flags, FLAGS, code); need(FLAGS.every(key => flags[key] === false), code);
  if (Object.hasOwn(base, "error")) {
    const v = record(base, ["protocol", "mode", "correlation", "error", "flags"], code);
    const error = record(v.error, ["code", "state", "operationOutcome"], code);
    need(error.code === "denied-or-unknown" && error.state === "unresolved" && error.operationOutcome === "unknown-not-settled", code);
    if (v.correlation !== null) {
      const c = record(v.correlation, ["requestId", "frameDigest", "correlationDigest"], code);
      need(uuid(c.requestId, code) === req.requestId && digest(c.frameDigest, code) === values.frameDigest &&
        digest(c.correlationDigest, code) === values.correlationDigest, "CORRELATION_MISMATCH");
    }
    return freeze(v as unknown as DormantErrorResponse);
  }
  const v = record(base, ["protocol", "mode", "requestId", "bindingDigest", "method", "frameDigest", "correlationDigest", "result", "flags"], code);
  need(digest(v.bindingDigest, code) === req.bindingDigest, "BINDING_MISMATCH");
  need(uuid(v.requestId, code) === req.requestId && v.method === req.method && digest(v.frameDigest, code) === values.frameDigest &&
    digest(v.correlationDigest, code) === values.correlationDigest, "CORRELATION_MISMATCH");
  switch (req.method) {
    case "current": { const r = record(v.result, ["cas"], code); cas(r.cas, req.operation.operationId, code); break; }
    case "admit": {
      const r = record(v.result, ["lease", "ack"], code), l = lease(r.lease, code);
      need(r.ack === (l.historical ? "historical-only" : "fixture-registered"), code); break;
    }
    case "begin_commit": {
      const r = record(v.result, ["permit"], code), p = record(r.permit, ["permitId", "leaseId", "requestDigest"], code);
      uuid(p.permitId, code); digest(p.requestDigest, code);
      need(uuid(p.leaseId, code) === (req.args as DormantArgs["begin_commit"]).lease.leaseId, code); break;
    }
    case "unknown": { const r = record(v.result, ["state"], code); need(r.state === "registered-pending", code); break; }
    case "settle": {
      const r = record(v.result, ["state"], code);
      need(r.state === "synthetic-original-terminal-recorded" || r.state === "historical-terminal-ack", code); break;
    }
    case "drain": {
      const r = record(v.result, ["state", "pending", "scope"], code), pending = counter(r.pending, code);
      need(r.state === (pending > 0 ? "pending" : "fixture-drained"), code);
      need(r.scope === (req.operation.operationCode.startsWith("cop-owner-") ? "owner-wide" : "principal"), code); break;
    }
  }
  return freeze(v as unknown as DormantSuccess<M>);
}

export interface DormantFixtureScheduler {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
export interface DormantV5FixtureOptions {
  readonly mode: "own-fixture-only"; readonly operation: DormantOperation; readonly bindingDigest: string;
  /** Explicit injected in-memory fixture exchange; no transport is supplied. */
  readonly exchange: (bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
  readonly deadlineMs?: number; readonly scheduler?: DormantFixtureScheduler;
}
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
export class DormantV5FixtureClient {
  #operation: DormantOperation; #binding: string; #exchange: DormantV5FixtureOptions["exchange"];
  #deadline: number; #scheduler: DormantFixtureScheduler; #pending = 0;
  get productionReady(): false { return false; }
  constructor(options: DormantV5FixtureOptions) {
    const o = record(options, ["mode", "operation", "bindingDigest", "exchange"], "INVALID_OPTIONS", ["deadlineMs", "scheduler"]);
    need(o.mode === "own-fixture-only", "FIXTURE_MODE_REQUIRED");
    this.#operation = freeze(operation(parseStrictFixturePacket(canonicalAsciiFixtureBytes(o.operation)), "INVALID_OPTIONS"));
    this.#binding = digest(o.bindingDigest, "INVALID_OPTIONS");
    need(typeof o.exchange === "function" && !types.isProxy(o.exchange), "INVALID_OPTIONS");
    this.#exchange = o.exchange as DormantV5FixtureOptions["exchange"];
    const deadline = o.deadlineMs === undefined ? 1000 : o.deadlineMs;
    need(typeof deadline === "number" && Number.isSafeInteger(deadline) && deadline >= 1 && deadline <= 1000, "INVALID_OPTIONS");
    this.#deadline = deadline;
    if (o.scheduler === undefined) this.#scheduler = Object.freeze({
      set: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    else {
      const s = record(o.scheduler, ["set", "clear"], "INVALID_OPTIONS");
      need(typeof s.set === "function" && !types.isProxy(s.set) && typeof s.clear === "function" && !types.isProxy(s.clear), "INVALID_OPTIONS");
      this.#scheduler = Object.freeze({ set: s.set as DormantFixtureScheduler["set"], clear: s.clear as DormantFixtureScheduler["clear"] });
    }
    Object.freeze(this);
  }
  /** No auto-admit, historical-marker flip, retry, abort RPC, settlement or CAS authority inference. */
  async call<M extends DormantMethod>(method: M, args: DormantArgs[M], options: { readonly requestId: string; readonly signal?: AbortSignal }): Promise<DormantSuccess<M>> {
    const o = record(options, ["requestId"], "INVALID_OPTIONS", ["signal"]);
    uuid(o.requestId, "INVALID_OPTIONS");
    const caller = o.signal as AbortSignal | undefined;
    if (caller !== undefined) {
      need(!types.isProxy(caller), "INVALID_OPTIONS");
      let aborted: boolean;
      try { aborted = signalAborted.call(caller) as boolean; } catch { throw new DormantCodecError("INVALID_OPTIONS"); }
      if (aborted) throw new DormantIndeterminateError("CALLER_ABORTED");
    }
    const bytes = encodeDormantRequest({ protocol: DORMANT_V5_PROTOCOL, mode: "own-fixture-only", requestId: o.requestId,
      bindingDigest: this.#binding, operation: this.#operation, method, args });
    const req = decodeDormantRequest(bytes) as DormantRequest<M>;
    need(this.#pending < 4, "CAPACITY_LIMIT"); this.#pending++;
    return new Promise<DormantSuccess<M>>((resolve, reject) => {
      const controller = new AbortController(); let done = false, timerKnown = false, timer: unknown;
      const cleanup = (): void => {
        if (timerKnown) { try { this.#scheduler.clear(timer); } catch { /* No authority or payload is inferred from a fixture scheduler failure. */ } }
        if (caller) EventTarget.prototype.removeEventListener.call(caller, "abort", onAbort);
      };
      const unknown = (reason: DormantIndeterminateError["reason"]): void => {
        if (done) return; done = true; cleanup();
        // Cancels only the caller's fixture wait signal; never proves native abort/settlement.
        controller.abort(); reject(new DormantIndeterminateError(reason));
      };
      const onAbort = (): void => unknown("CALLER_ABORTED");
      if (caller) EventTarget.prototype.addEventListener.call(caller, "abort", onAbort, { once: true });
      try { timer = this.#scheduler.set(() => unknown("CALLER_DEADLINE"), this.#deadline); timerKnown = true; }
      catch { this.#pending--; unknown("EXCHANGE_UNKNOWN"); return; }
      if (done) { this.#pending--; cleanup(); return; }
      // Slots are released ONLY when the underlying injected promise settles,
      // even if its caller deadline/abort has already made the result unknown.
      const underlying = Promise.resolve().then(() => {
        if (done) throw new DormantIndeterminateError("EXCHANGE_UNKNOWN");
        return this.#exchange(new Uint8Array(bytes), controller.signal);
      });
      void underlying.then(response => {
        this.#pending--; if (done) return;
        try {
          const value = decodeDormantResponse(response, req);
          if (Object.hasOwn(value, "error")) { unknown("FIXTURE_UNKNOWN"); return; }
          done = true; cleanup(); resolve(value as DormantSuccess<M>);
        } catch { unknown("EXCHANGE_UNKNOWN"); }
      }, () => { this.#pending--; unknown("EXCHANGE_UNKNOWN"); });
    });
  }
}

const NEGATIVE_BRIDGE = Object.freeze({ compatible: false as const, productionReady: false as const,
  reason: "DORMANT_FIXTURE_NOT_RUNTIME_AUTHORITY" as const });
/** Deliberately not a positive OwnerCheckpointVerifier/Driver proof factory. */
export function negativeDormantProductionProofBridge(): typeof NEGATIVE_BRIDGE { return NEGATIVE_BRIDGE; }
