import { describe, expect, it, vi } from "vitest";
import { DriverGuardedOperationRunner, readDriverGuardedAdmission, snapshotDriverGuardedOperationContext } from "../src/driver-guarded-execution.js";
import type { DriverGuardedExecutionPort, DriverGuardedExecutionRequest, DriverGuardedExecutionResult, DriverGuardedOperationContext, DriverGuardedReadRequest, DriverGuardedRecordRef } from "../src/driver-guarded-execution-port.js";

// Synthetic mock ports test local adaptation only, not real Root verification.
const id = "10000000-0000-4000-8000-000000000001";
const ref = { recordId: "20000000-0000-4000-8000-000000000001", digest: "a".repeat(64) };
const scopeRef = { recordId: "30000000-0000-4000-8000-000000000001", digest: "c".repeat(64) };
const otherScopeRef = { recordId: "30000000-0000-4000-8000-000000000002", digest: "d".repeat(64) };
const context: DriverGuardedOperationContext = { operation: { operationId: id, kind: "revoke" } };
const body = { contractVersion: "sim-driver-guarded-db-v1" as const, contributorHash: "b".repeat(64) };
const pending: DriverGuardedExecutionResult = { contractVersion: "cop-driver-origin-result-v1", operationId: id, state: "pending", reason: "origin-unresolved" };
const committed: DriverGuardedExecutionResult = { contractVersion: "cop-driver-origin-result-v1", operationId: id,
  state: "origin-commit-known", sqlOutcomeRef: ref, effectQuiescenceRef: ref, revokeEffect: { deletedBatchCount: 2 } };
function fixture(first: unknown = committed) {
  const execute = vi.fn(async (_request: DriverGuardedExecutionRequest) => first as DriverGuardedExecutionResult);
  const probe = vi.fn(async (_operation: DriverGuardedOperationContext["operation"], _scope?: DriverGuardedRecordRef) => committed);
  return { execute, probe, runner: new DriverGuardedOperationRunner({ execute, probe }) };
}
describe("guarded local runner, synthetic ports only", () => {
  it("does not dispatch without an exact per-invocation Root reference or a bound port", async () => {
    const f = fixture();
    for (const c of [undefined, { operation: { operationId: id, kind: "erase" } },
      { operation: { operationId: "business-or-account-id", kind: "revoke" } }, { operation: context.operation, sql: "forbidden" }])
      await expect(f.runner.execute(c as DriverGuardedOperationContext, "revoke", body)).rejects.toThrow("DRIVER_GUARDED_UNAVAILABLE");
    await expect(new DriverGuardedOperationRunner().execute(context, "revoke", body)).rejects.toThrow("UNAVAILABLE");
    expect(f.execute).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
  });
  it("preserves the original reference and probes only after pending", async () => {
    const f = fixture(pending);
    expect((await f.runner.execute(context, "revoke", body)).state).toBe("pending");
    expect(await f.runner.execute(context, "revoke", body)).toEqual(committed);
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.probe).toHaveBeenCalledExactlyOnceWith(context.operation);
  });
  it("snapshots and freezes scoped context before queued dispatch instead of borrowing caller changes", async () => {
    const caller = { operation: { ...context.operation }, mutationScopeRef: { ...scopeRef } }, f = fixture();
    const flight = f.runner.execute(caller, "revoke", body);
    caller.operation.operationId = "10000000-0000-4000-8000-000000000002";
    caller.mutationScopeRef.recordId = otherScopeRef.recordId; caller.mutationScopeRef.digest = otherScopeRef.digest;
    expect(await flight).toEqual(committed);
    expect(f.execute).toHaveBeenCalledExactlyOnceWith({ operation: context.operation, body, mutationScopeRef: scopeRef });
    const sent = f.execute.mock.calls[0][0] as any;
    expect(Object.isFrozen(sent.mutationScopeRef)).toBe(true); expect(Object.isFrozen(sent.operation)).toBe(true);
  });
  it("keeps different origins and mutation scopes independent", async () => {
    const second = { operation: { ...context.operation, operationId: "10000000-0000-4000-8000-000000000002" }, mutationScopeRef: otherScopeRef };
    const execute = vi.fn(async (request: any) => ({ ...committed, operationId: request.operation.operationId }));
    const probe = vi.fn(async () => committed), runner = new DriverGuardedOperationRunner({ execute, probe });
    await Promise.all([runner.execute({ ...context, mutationScopeRef: scopeRef }, "revoke", body), runner.execute(second, "revoke", body)]);
    expect(execute).toHaveBeenCalledTimes(2); expect(execute.mock.calls.map(([request]) => request.mutationScopeRef)).toEqual([scopeRef, otherScopeRef]);
    expect(probe).not.toHaveBeenCalled();
  });
  it("does not coalesce a different scope or unscoped caller into an active scoped origin", async () => {
    let finish!: (value: DriverGuardedExecutionResult) => void;
    const execute = vi.fn(() => new Promise<DriverGuardedExecutionResult>(resolve => { finish = resolve; })), probe = vi.fn(async () => committed);
    const runner = new DriverGuardedOperationRunner({ execute, probe }), scoped = { ...context, mutationScopeRef: scopeRef };
    const first = runner.execute(scoped, "revoke", body), equal = runner.execute({ ...context, mutationScopeRef: { ...scopeRef } }, "revoke", body);
    expect(equal).toBe(first);
    await expect(runner.execute({ ...context, mutationScopeRef: otherScopeRef }, "revoke", body)).rejects.toThrow("UNAVAILABLE");
    await expect(runner.execute(context, "revoke", body)).rejects.toThrow("UNAVAILABLE");
    expect(execute).toHaveBeenCalledTimes(1); finish(committed); await first; expect(probe).not.toHaveBeenCalled();
  });
  it("does not lend an active legacy origin result to a new scoped caller", async () => {
    const f = fixture(), first = f.runner.execute(context, "revoke", body);
    await expect(f.runner.execute({ ...context, mutationScopeRef: scopeRef }, "revoke", body)).rejects.toThrow("UNAVAILABLE");
    await first; expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it("a new scope after pending probes only the same immutable origin and body", async () => {
    const f = fixture(pending);
    await f.runner.execute({ ...context, mutationScopeRef: scopeRef }, "revoke", body);
    await expect(f.runner.execute({ ...context, mutationScopeRef: otherScopeRef }, "revoke", { ...body, contributorHash: "e".repeat(64) })).rejects.toThrow("UNAVAILABLE");
    expect(await f.runner.execute({ ...context, mutationScopeRef: otherScopeRef }, "revoke", body)).toEqual(committed);
    expect(f.execute).toHaveBeenCalledExactlyOnceWith({ operation: context.operation, body, mutationScopeRef: scopeRef });
    expect(f.probe).toHaveBeenCalledExactlyOnceWith(context.operation, otherScopeRef);
    expect(Object.isFrozen((f.probe.mock.calls[0] as any)[1])).toBe(true);
  });
  it("rejects malformed, extra, proxy and accessor scope references without invoking getters", async () => {
    const getter = vi.fn(() => scopeRef.recordId), accessor = Object.defineProperty({ digest: scopeRef.digest }, "recordId", { enumerable: true, get: getter });
    const values = [undefined, null, {}, { ...scopeRef, extra: true }, { ...scopeRef, digest: "wrong" }, new Proxy(scopeRef, {}), accessor];
    const f = fixture();
    for (const mutationScopeRef of values)
      await expect(f.runner.execute({ ...context, mutationScopeRef } as any, "revoke", body)).rejects.toThrow("UNAVAILABLE");
    const top = Object.defineProperty({ ...context }, "mutationScopeRef", { enumerable: true, get: getter });
    await expect(f.runner.execute(top, "revoke", body)).rejects.toThrow("UNAVAILABLE");
    expect(getter).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
  });
  it("never accepts a mutation scope on expiration", async () => {
    const f = fixture();
    await expect(f.runner.execute({ operation: { operationId: id, kind: "expire" }, mutationScopeRef: scopeRef }, "expire", { contractVersion: body.contractVersion })).rejects.toThrow("UNAVAILABLE");
    expect(f.execute).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
  });
  it("exports an immutable exact ACK context snapshot and preserves publication/body equality", async () => {
    const publicationContext = { contractVersion: "cop-driver-publication-context-v1" as const, recordId: ref.recordId, recordDigest: ref.digest,
      storeIncarnation: scopeRef.recordId, operationDigest: ref.digest, readbackDigest: ref.digest, reportProtection: "no_report" as const,
      observedAtUTC: "2026-10-15T12:00:00.000Z" };
    const caller = { operation: { operationId: id, kind: "ack" as const }, publicationContext, mutationScopeRef: { ...scopeRef } };
    const snapshot = snapshotDriverGuardedOperationContext(caller, "ack");
    caller.publicationContext.recordDigest = "e".repeat(64); caller.mutationScopeRef.digest = "e".repeat(64);
    expect(snapshot.publicationContext?.recordDigest).toBe(ref.digest); expect(snapshot.mutationScopeRef).toEqual(scopeRef);
    expect([snapshot, snapshot.operation, snapshot.publicationContext, snapshot.mutationScopeRef].every(Object.isFrozen)).toBe(true);
    const ackBody = { contractVersion: body.contractVersion, operationHash: ref.digest, actorHash: ref.digest,
      requestHash: ref.digest, checkpointHash: ref.digest, contributors: Array.from({ length: 9 }, (_, n) => ({
        contributorDay: `2026-10-${String(n + 1).padStart(2, "0")}`, contributorHash: String(n).repeat(64) })) };
    const f = fixture();
    await expect(f.runner.execute(snapshot, "ack", { ...ackBody, publicationContext: caller.publicationContext })).rejects.toThrow("UNAVAILABLE");
    expect(f.execute).not.toHaveBeenCalled();
    const ackCommitted = { contractVersion: committed.contractVersion, operationId: id, state: "origin-commit-known" as const, sqlOutcomeRef: ref, effectQuiescenceRef: ref };
    const accepted = fixture(ackCommitted);
    expect(await accepted.runner.execute(snapshot, "ack", { ...ackBody, publicationContext: snapshot.publicationContext })).toEqual(ackCommitted);
    expect(() => snapshotDriverGuardedOperationContext(new Proxy(caller, {}), "ack")).toThrow("UNAVAILABLE");
    expect(() => snapshotDriverGuardedOperationContext({ ...context, publicationContext } as any, "revoke")).toThrow("UNAVAILABLE");
    expect(() => snapshotDriverGuardedOperationContext({ ...caller, unknown: true } as any, "ack")).toThrow("UNAVAILABLE");
  });
  it("captures port method references instead of allowing later replacement", async () => {
    const execute = vi.fn(async () => committed), probe = vi.fn(async () => committed), port = { execute, probe };
    const runner = new DriverGuardedOperationRunner(port), replacement = vi.fn(async () => pending);
    port.execute = replacement; port.probe = replacement as any;
    expect(await runner.execute(context, "revoke", body)).toEqual(committed);
    expect(execute).toHaveBeenCalledTimes(1); expect(replacement).not.toHaveBeenCalled();
  });
  it("a transport failure remains ambiguous and a changed retry body is rejected", async () => {
    const f = fixture(); f.execute.mockRejectedValueOnce(new Error("private transport detail"));
    await expect(f.runner.execute(context, "revoke", body)).rejects.toThrow("DRIVER_GUARDED_UNAVAILABLE");
    await expect(f.runner.execute(context, "revoke", { ...body, contributorHash: "c".repeat(64) })).rejects.toThrow("UNAVAILABLE");
    await f.runner.execute(context, "revoke", body);
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.probe).toHaveBeenCalledTimes(1);
  });
  it("a known revoke commit without its original scalar still retries probe-only", async () => {
    const noScalar = { ...committed }; delete noScalar.revokeEffect;
    const f = fixture(noScalar);
    await expect(f.runner.execute(context, "revoke", body)).rejects.toThrow("UNAVAILABLE");
    expect(await f.runner.execute(context, "revoke", body)).toEqual(committed);
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.probe).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["expire", { contractVersion: body.contractVersion, cutoff: "2026-10-15T00:00:00.000Z" }],
    ["revoke", { ...body, contributorHash: "raw-day-id" }],
    ["erase", { contractVersion: body.contractVersion, operationHash: "a".repeat(64), actorHash: "b".repeat(64),
      requestHash: "c".repeat(64), checkpointHash: "d".repeat(64), contributors: [] }],
    ["ack", { contractVersion: body.contractVersion, operationHash: "a".repeat(64), actorHash: "b".repeat(64),
      requestHash: "c".repeat(64), checkpointHash: "d".repeat(64), contributors: Array.from({ length: 9 }, (_, n) => ({
        contributorDay: `2026-10-${String(n + 1).padStart(2, "0")}`, contributorHash: String(n).repeat(64) })),
      publicationContext: { freeText: "not part of this contract" } }],
  ] as const)("rejects malformed fixed %s body before dispatch", async (kind, invalidBody) => {
    const f = fixture();
    await expect(f.runner.execute({ operation: { operationId: id, kind } }, kind, invalidBody as any)).rejects.toThrow("UNAVAILABLE");
    expect(f.execute).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
  });
  it("revalidates the exact JSON snapshot instead of trusting an array toJSON", async () => {
    const contributors = Array.from({ length: 9 }, (_, n) => ({ contributorDay: `2026-10-${String(n + 1).padStart(2, "0")}`,
      contributorHash: String(n).repeat(64) }));
    Object.defineProperty(contributors, "toJSON", { value: () => [] });
    const invalidBody = { contractVersion: body.contractVersion, operationHash: "a".repeat(64), actorHash: "b".repeat(64),
      requestHash: "c".repeat(64), checkpointHash: "d".repeat(64), contributors };
    const f = fixture();
    await expect(f.runner.execute({ operation: { operationId: id, kind: "erase" } }, "erase", invalidBody)).rejects.toThrow("UNAVAILABLE");
    expect(f.execute).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
  });
  it.each([
    { ...committed, operationId: "10000000-0000-4000-8000-000000000002" },
    { ...committed, sqlOutcomeRef: { ...ref, digest: "invalid" } },
    { ...committed, state: "origin-no-effects-closed" },
    { ...committed, revokeEffect: { deletedBatchCount: -1 } },
    { ...committed, revokeEffect: { deletedBatchCount: 0.5 } },
    { ...committed, revokeEffect: { deletedBatchCount: 2_147_483_648 } },
    { ...pending, revokeEffect: { deletedBatchCount: 2 } },
    { ...committed, sql: "forbidden" },
  ])("rejects malformed, mismatched or misplaced terminal effects", async value => {
    const f = fixture(value);
    await expect(f.runner.execute(context, "revoke", body)).rejects.toThrow("UNAVAILABLE");
    await f.runner.execute(context, "revoke", body);
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.probe).toHaveBeenCalledTimes(1);
  });
  it("coalesces concurrent calls and close waits for the actual port promise", async () => {
    let finish!: (result: DriverGuardedExecutionResult) => void;
    const execute = vi.fn(() => new Promise<DriverGuardedExecutionResult>(resolve => { finish = resolve; }));
    const port: DriverGuardedExecutionPort = { execute, probe: vi.fn(async () => committed) }, runner = new DriverGuardedOperationRunner(port);
    const first = runner.execute(context, "revoke", body), second = runner.execute(context, "revoke", body);
    expect(first).toBe(second); await Promise.resolve();
    let closed = false; const closing = runner.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
    await expect(runner.execute(context, "revoke", body)).rejects.toThrow("UNAVAILABLE");
    finish(committed); await first; await closing; expect(execute).toHaveBeenCalledTimes(1);
  });
  it("caps unresolved local origins without generating or replacing identities", async () => {
    const execute = vi.fn(async (request: any) => ({ ...pending, operationId: request.operation.operationId }));
    const runner = new DriverGuardedOperationRunner({ execute, probe: vi.fn(async () => pending) });
    for (let n = 1; n <= 128; n++) await runner.execute({ operation: { kind: "revoke", operationId: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}` } }, "revoke", body);
    await expect(runner.execute({ operation: { kind: "revoke", operationId: "10000000-0000-4000-8000-000000000129" } }, "revoke", body)).rejects.toThrow("UNAVAILABLE");
    expect(execute).toHaveBeenCalledTimes(128);
  });
});

describe("guarded read admission, synthetic verification port only", () => {
  const request = { owner: "sim_driver_measurements" as const, scope: "online_driver_scope" as const,
    purpose: "receipt" as const, actorHash: "b".repeat(64), operationHash: "c".repeat(64) };
  const admission = { ...request, contractVersion: "sim-driver-guarded-read-admission-v1" as const,
    checkpointHash: "d".repeat(64), reportProtection: "no_report" as const, reference: ref };
  it("requires an explicit purpose/actor/operation-bound admission, never legacy booleans", async () => {
    expect(await readDriverGuardedAdmission({}, request)).toBeUndefined();
    expect(await readDriverGuardedAdmission(undefined, request)).toBeUndefined();
    expect(await readDriverGuardedAdmission({ admission: { inspect: vi.fn(async () => admission) } }, request)).toEqual(admission);
    for (const changed of [{ ...admission, purpose: "status" }, { ...admission, actorHash: "e".repeat(64) },
      { ...admission, operationHash: "e".repeat(64) }, { ...admission, ready: true }, true])
      expect(await readDriverGuardedAdmission({ admission: { inspect: vi.fn(async () => changed as any) } }, request)).toBeUndefined();
    expect(await readDriverGuardedAdmission({ admission: { inspect: vi.fn(async () => { throw new Error("private details"); }) } }, request)).toBeUndefined();
  });
  const scoped = { ...admission, contractVersion: "sim-driver-mutation-read-admission-v2" as const, mutationScopeRef: scopeRef };
  it("requires exact v2 scope binding and forwards immutable scope/request snapshots", async () => {
    let finish!: (value: typeof scoped) => void;
    const inspect = vi.fn((_request: DriverGuardedReadRequest, _scope?: DriverGuardedRecordRef) => new Promise<typeof scoped>(resolve => { finish = resolve; }));
    const mutableRequest = { ...request }, mutableScope = { ...scopeRef };
    const flight = readDriverGuardedAdmission({ admission: { inspect } }, mutableRequest, mutableScope);
    mutableRequest.actorHash = "f".repeat(64); mutableScope.digest = "f".repeat(64);
    finish({ ...scoped, mutationScopeRef: { ...scopeRef } });
    expect(await flight).toEqual(scoped); expect(inspect).toHaveBeenCalledExactlyOnceWith(request, scopeRef);
    expect(inspect.mock.calls[0].every(Object.isFrozen)).toBe(true);
    const value = await readDriverGuardedAdmission({ admission: { inspect: vi.fn(async () => scoped) } }, request, scopeRef);
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen((value as typeof scoped).mutationScopeRef)).toBe(true);
  });
  it.each([
    admission,
    { ...scoped, mutationScopeRef: otherScopeRef },
    { ...admission, contractVersion: "sim-driver-mutation-read-admission-v2" },
    { ...scoped, mutationScopeRef: undefined },
    { ...scoped, mutationScopeRef: { ...scopeRef, extra: true } },
    { ...scoped, ready: true },
    { ...scoped, actorHash: "e".repeat(64) },
    { ...scoped, mutationScopeRef: new Proxy(scopeRef, {}) },
  ])("refuses scoped downgrade, missing reference and mismatched/extra v2 values: %j", async value => {
    const inspect = vi.fn(async () => value as any);
    expect(await readDriverGuardedAdmission({ admission: { inspect } }, request, scopeRef)).toBeUndefined();
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it("does not accept v2 or a scope-bearing v1 admission without a requested scope", async () => {
    for (const value of [scoped, { ...admission, mutationScopeRef: scopeRef }])
      expect(await readDriverGuardedAdmission({ admission: { inspect: vi.fn(async () => value) } }, request)).toBeUndefined();
  });
  it("requires actor/operation only for bound purposes and refuses v2 capability/intake", async () => {
    const inspect = vi.fn(async () => scoped);
    for (const purpose of ["capability", "intake"] as const) {
      const ownerWide = { owner: request.owner, scope: request.scope, purpose };
      expect(await readDriverGuardedAdmission({ admission: { inspect } }, ownerWide, scopeRef)).toBeUndefined();
      expect(await readDriverGuardedAdmission({ admission: { inspect } }, { ...ownerWide, actorHash: request.actorHash })).toBeUndefined();
      const v1 = { ...ownerWide, contractVersion: admission.contractVersion, checkpointHash: admission.checkpointHash, reportProtection: admission.reportProtection, reference: ref };
      expect(await readDriverGuardedAdmission({ admission: { inspect: vi.fn(async () => v1) } }, ownerWide)).toEqual(v1);
    }
    for (const purpose of ["preflight", "status", "receipt"] as const)for (const missing of ["actorHash", "operationHash"]) {
      const invalid: any = { ...request, purpose }; delete invalid[missing];
      expect(await readDriverGuardedAdmission({ admission: { inspect } }, invalid)).toBeUndefined();
    }
    expect(inspect).not.toHaveBeenCalled();
  });
  it("rejects expected/reference/request accessors and proxies without evaluating them", async () => {
    const getter = vi.fn(() => scopeRef.recordId), expected = Object.defineProperty({ digest: scopeRef.digest }, "recordId", { enumerable: true, get: getter });
    const inspect = vi.fn(async () => scoped);
    for (const invalid of [expected, new Proxy(scopeRef, {}), null, { ...scopeRef, extra: true }])
      expect(await readDriverGuardedAdmission({ admission: { inspect } }, request, invalid as any)).toBeUndefined();
    const invalidRequest = Object.defineProperty({ ...request }, "actorHash", { enumerable: true, get: getter });
    expect(await readDriverGuardedAdmission({ admission: { inspect } }, invalidRequest, scopeRef)).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
    const invalidValue = Object.defineProperty({ ...scoped }, "mutationScopeRef", { enumerable: true, get: getter });
    expect(await readDriverGuardedAdmission({ admission: { inspect: vi.fn(async () => invalidValue) } }, request, scopeRef)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });
});
