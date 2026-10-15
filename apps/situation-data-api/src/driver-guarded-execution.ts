import { createHash } from "node:crypto";
import { types } from "node:util";
import type {
  DriverGuardedExecutionPort, DriverGuardedExecutionRequest, DriverGuardedExecutionResult,
  DriverGuardedKind, DriverGuardedOperationContext, DriverGuardedReadAdmission,
  DriverGuardedReadRequest, DriverGuardedRecordRef, DriverGuardedStoreOptions,
} from "./driver-guarded-execution-port.js";

/** Safe local failure only; never wraps SQL/transport/body/credential payloads. */
export class DriverGuardedUnavailable extends Error {
  constructor() { super("DRIVER_GUARDED_UNAVAILABLE"); this.name = "DriverGuardedUnavailable"; }
}
const unavailable = (): never => { throw new DriverGuardedUnavailable(); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HEX = /^[0-9a-f]{64}$/u;
const pendingReasons = new Set(["origin-busy", "origin-unresolved", "store-unavailable", "authority-unavailable", "transport-unavailable", "effect-observation-unavailable"]);
function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === null || prototype === Object.prototype) && Reflect.ownKeys(value).every(key => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" && d?.enumerable === true && "value" in d;
  });
}
function keys(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return plain(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function reference(value: unknown): value is DriverGuardedRecordRef {
  return keys(value, ["recordId", "digest"]) && typeof value.recordId === "string" && UUID.test(value.recordId) &&
    typeof value.digest === "string" && HEX.test(value.digest);
}
function publicationContext(value: unknown): boolean {
  if (!keys(value, ["contractVersion", "recordId", "recordDigest", "storeIncarnation", "operationDigest", "readbackDigest", "reportProtection", "observedAtUTC"]) ||
    value.contractVersion !== "cop-driver-publication-context-v1" || typeof value.recordId !== "string" || !UUID.test(value.recordId) ||
    typeof value.storeIncarnation !== "string" || !UUID.test(value.storeIncarnation) || typeof value.observedAtUTC !== "string") return false;
  for (const name of ["recordDigest", "operationDigest", "readbackDigest"]) if (typeof value[name] !== "string" || !HEX.test(value[name] as string)) return false;
  const at = Date.parse(value.observedAtUTC);
  return Number.isFinite(at) && new Date(at).toISOString() === value.observedAtUTC &&
    typeof value.reportProtection === "string" && ["no_report", "enforced_single_writer", "shared_generation_fence"].includes(value.reportProtection);
}
/** Own immutable shape snapshot only, never authentication or Root authority. */
export function snapshotDriverGuardedOperationContext(value: DriverGuardedOperationContext | undefined,
  kind: DriverGuardedKind): DriverGuardedOperationContext {
  if (!["expire", "revoke", "erase", "ack"].includes(kind) ||
    !keys(value, ["operation"], ["publicationContext", "mutationScopeRef"]) || !keys(value.operation, ["operationId", "kind"]) ||
    value.operation.kind !== kind || typeof value.operation.operationId !== "string" || !UUID.test(value.operation.operationId) ||
    (Object.hasOwn(value, "publicationContext") && (kind !== "ack" || !publicationContext(value.publicationContext))) ||
    (Object.hasOwn(value, "mutationScopeRef") && (kind === "expire" || !reference(value.mutationScopeRef)))) return unavailable();
  const snapshot = structuredClone(value) as DriverGuardedOperationContext;
  Object.freeze(snapshot.operation);
  if (snapshot.publicationContext) Object.freeze(snapshot.publicationContext);
  if (snapshot.mutationScopeRef) Object.freeze(snapshot.mutationScopeRef);
  return Object.freeze(snapshot);
}
function bodyShape(kind: DriverGuardedKind, body: unknown): boolean {
  if (!plain(body) || body.contractVersion !== "sim-driver-guarded-db-v1") return false;
  if (kind === "expire") return keys(body, ["contractVersion"]);
  if (kind === "revoke") return keys(body, ["contractVersion", "contributorHash"]) && typeof body.contributorHash === "string" && HEX.test(body.contributorHash);
  if (!keys(body, ["contractVersion", "operationHash", "actorHash", "requestHash", "contributors", "checkpointHash"], kind === "ack" ? ["publicationContext"] : [])) return false;
  for (const name of ["operationHash", "actorHash", "requestHash", "checkpointHash"]) if (typeof body[name] !== "string" || !HEX.test(body[name] as string)) return false;
  if (!Array.isArray(body.contributors) || types.isProxy(body.contributors) || body.contributors.length < 9 || body.contributors.length > 40) return false;
  const pairs = new Set<string>();
  for (const row of body.contributors) {
    if (!keys(row, ["contributorDay", "contributorHash"]) || typeof row.contributorDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(row.contributorDay) ||
      typeof row.contributorHash !== "string" || !HEX.test(row.contributorHash)) return false;
    const time = Date.parse(`${row.contributorDay}T00:00:00Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== row.contributorDay) return false;
    const key = `${row.contributorDay}:${row.contributorHash}`;
    if (pairs.has(key)) return false;
    pairs.add(key);
  }
  return !Object.hasOwn(body, "publicationContext") || publicationContext(body.publicationContext);
}
/** Shape/correlation only. Cryptographic/current-frontier verification belongs
 * to the accepted protected port implementation, which is not supplied here. */
function result(value: unknown, operationId: string, kind: DriverGuardedKind): DriverGuardedExecutionResult {
  if (!plain(value) || value.contractVersion !== "cop-driver-origin-result-v1" || value.operationId !== operationId) return unavailable();
  if (value.state === "pending") {
    if (!keys(value, ["contractVersion", "operationId", "state", "reason"]) || typeof value.reason !== "string" || !pendingReasons.has(value.reason)) return unavailable();
  } else if (value.state === "origin-commit-known" || value.state === "origin-no-effects-closed") {
    if (!keys(value, ["contractVersion", "operationId", "state", "sqlOutcomeRef", "effectQuiescenceRef"], ["revokeEffect"]) ||
      !reference(value.sqlOutcomeRef) || !reference(value.effectQuiescenceRef)) return unavailable();
    if (Object.hasOwn(value, "revokeEffect")) {
      if (kind !== "revoke" || value.state !== "origin-commit-known" || !keys(value.revokeEffect, ["deletedBatchCount"]) ||
        !Number.isSafeInteger(value.revokeEffect.deletedBatchCount) || (value.revokeEffect.deletedBatchCount as number) < 0 ||
        (value.revokeEffect.deletedBatchCount as number) > 2_147_483_647) return unavailable();
    }
    if (kind === "revoke" && value.state === "origin-commit-known" && !Object.hasOwn(value, "revokeEffect")) return unavailable();
  } else return unavailable();
  // Own immutable scalar/reference projection; no getters or caller mutation.
  return structuredClone(value) as unknown as DriverGuardedExecutionResult;
}

/** No production factory/transport or positive verifier. An absent admission
 * remains unavailable; neither booleans nor a catalog flag create this result. */
export async function readDriverGuardedAdmission(options: DriverGuardedStoreOptions | undefined,
  request: DriverGuardedReadRequest, expectedMutationScopeRef?: DriverGuardedRecordRef): Promise<DriverGuardedReadAdmission | undefined> {
  try {
    if (!plain(request) || !["capability", "intake", "preflight", "status", "receipt"].includes(request.purpose as string)) return undefined;
    const actorBound = ["preflight", "status", "receipt"].includes(request.purpose);
    const requestKeys = ["owner", "scope", "purpose", ...(actorBound ? ["operationHash", "actorHash"] : [])];
    if (!keys(request, requestKeys) || request.owner !== "sim_driver_measurements" || request.scope !== "online_driver_scope") return undefined;
    if (actorBound && (typeof request.operationHash !== "string" || !HEX.test(request.operationHash) ||
      typeof request.actorHash !== "string" || !HEX.test(request.actorHash))) return undefined;
    if (expectedMutationScopeRef !== undefined && (!actorBound || !reference(expectedMutationScopeRef))) return undefined;
    const requestSnapshot = Object.freeze({ ...request });
    const scopeSnapshot = expectedMutationScopeRef === undefined ? undefined : Object.freeze({ ...expectedMutationScopeRef });
    if (!options?.admission || typeof options.admission.inspect !== "function") return undefined;
    const value = scopeSnapshot === undefined ? await options.admission.inspect(requestSnapshot) : await options.admission.inspect(requestSnapshot, scopeSnapshot);
    if (!keys(value, [...requestKeys, "contractVersion", "checkpointHash", "reportProtection", "reference", ...(scopeSnapshot ? ["mutationScopeRef"] : [])]) ||
      value.contractVersion !== (scopeSnapshot ? "sim-driver-mutation-read-admission-v2" : "sim-driver-guarded-read-admission-v1") ||
      value.owner !== requestSnapshot.owner || value.scope !== requestSnapshot.scope || value.purpose !== requestSnapshot.purpose ||
      value.operationHash !== requestSnapshot.operationHash || value.actorHash !== requestSnapshot.actorHash ||
      typeof value.checkpointHash !== "string" || !HEX.test(value.checkpointHash) || !reference(value.reference) ||
      typeof value.reportProtection !== "string" || !["no_report", "enforced_single_writer", "shared_generation_fence"].includes(value.reportProtection)) return undefined;
    if (scopeSnapshot && (!reference(value.mutationScopeRef) || value.mutationScopeRef.recordId !== scopeSnapshot.recordId ||
      value.mutationScopeRef.digest !== scopeSnapshot.digest)) return undefined;
    const snapshot = structuredClone(value) as unknown as DriverGuardedReadAdmission;
    Object.freeze(snapshot.reference);
    if (snapshot.contractVersion === "sim-driver-mutation-read-admission-v2") Object.freeze(snapshot.mutationScopeRef);
    return Object.freeze(snapshot);
  } catch { return undefined; }
}

/** Tracks local ambiguous attempts without persisting bodies or identities.
 * Root remains responsible for durable probe-only recovery after a restart. */
export class DriverGuardedOperationRunner {
  #port?: DriverGuardedExecutionPort;
  #pending = new Map<string, string>();
  #flights = new Map<string, { fingerprint: string; scopeFingerprint: string; promise: Promise<DriverGuardedExecutionResult> }>();
  #closed = false;
  constructor(port?: DriverGuardedExecutionPort) {
    if (port && typeof port.execute === "function" && typeof port.probe === "function")
      this.#port = Object.freeze({ execute: port.execute.bind(port), probe: port.probe.bind(port) });
  }

  execute(context: DriverGuardedOperationContext | undefined, kind: DriverGuardedKind,
    body: DriverGuardedExecutionRequest["body"]): Promise<DriverGuardedExecutionResult> {
    try {
      if (this.#closed || !this.#port || typeof this.#port.execute !== "function" || typeof this.#port.probe !== "function" ||
        !context) return Promise.reject(new DriverGuardedUnavailable());
      const captured = snapshotDriverGuardedOperationContext(context, kind);
      if (!bodyShape(kind, body) || (kind === "ack" && JSON.stringify(captured.publicationContext) !==
        JSON.stringify((body as { publicationContext?: unknown }).publicationContext))) return Promise.reject(new DriverGuardedUnavailable());
      const operation = Object.freeze({ operationId: captured.operation.operationId, kind });
      const mutationScopeRef = captured.mutationScopeRef;
      const scopeFingerprint = mutationScopeRef ? `${mutationScopeRef.recordId}:${mutationScopeRef.digest}` : "";
      // This hash is local retry correlation ONLY, never the PG/Root bodyDigest.
      const bodyText = JSON.stringify(body);
      if (typeof bodyText !== "string" || Buffer.byteLength(bodyText, "utf8") > 16_384) return Promise.reject(new DriverGuardedUnavailable());
      const fingerprint = createHash("sha256").update(kind).update("\0").update(bodyText).digest("hex");
      const active = this.#flights.get(operation.operationId);
      if (active) return active.fingerprint === fingerprint && active.scopeFingerprint === scopeFingerprint ? active.promise : Promise.reject(new DriverGuardedUnavailable());
      const previous = this.#pending.get(operation.operationId);
      if ((previous !== undefined && previous !== fingerprint) || (previous === undefined && this.#pending.size >= 128)) return Promise.reject(new DriverGuardedUnavailable());
      const snapshot = JSON.parse(bodyText) as DriverGuardedExecutionRequest["body"];
      // Arrays may have custom toJSON/iterators/accessors even when their
      // initially inspected rows were valid. Validate the exact sent snapshot.
      if (!bodyShape(kind, snapshot)) return Promise.reject(new DriverGuardedUnavailable());
      // Reserve before any injected port work. Errors/invalid responses remain
      // ambiguous and cannot make a repeated call dispatch execute again.
      this.#pending.set(operation.operationId, fingerprint);
      const promise = Promise.resolve().then(async () => {
        try {
          const raw = previous !== undefined ? await (mutationScopeRef ? this.#port!.probe(operation, mutationScopeRef) : this.#port!.probe(operation)) :
            await this.#port!.execute({ operation, body: snapshot, ...(mutationScopeRef ? { mutationScopeRef } : {}) } as DriverGuardedExecutionRequest);
          const checked = result(raw, operation.operationId, kind);
          if (checked.state !== "pending") this.#pending.delete(operation.operationId);
          return checked;
        } catch { return unavailable(); }
      });
      this.#flights.set(operation.operationId, { fingerprint, scopeFingerprint, promise });
      void promise.then(() => this.#flights.delete(operation.operationId), () => this.#flights.delete(operation.operationId));
      return promise;
    } catch { return Promise.reject(new DriverGuardedUnavailable()); }
  }

  /** Waits for actual local calls only; does not claim Root drain/SQL abort. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#flights.values()].map(row => row.promise));
  }
}
