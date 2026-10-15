import { describe, expect, it, vi } from "vitest";
import type { Checkpoint } from "./account-erasure.js";
import { ownerCheckpointVerifier, type OwnerCheckpointAdmissionPort } from "./owner-checkpoint.js";

const checkpoint: Checkpoint = { identity_reviewed: true, replay_ready: true, cost_policy: "aggregate-costs-current-month-v1",
  checkpoint_id: "00000000-0000-4000-8000-000000000001", checkpoint_generation: "9223372036854775807",
  operation_digest: "a".repeat(64), schema_digest: "b".repeat(64) };
const reference = { recordId: "00000000-0000-4000-8000-000000000002", digest: "c".repeat(64) };
// Stub ports below exercise ONLY the composition boundary. They are not Root
// signatures, native peer or deployment acceptance; the Linux test is separate.
function port(change?: (value: any) => unknown) {
  const inspect = vi.fn(async request => {
    expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.expectedSnapshot)).toBe(true);
    const admission = { contractVersion: "sim-ai-router-checkpoint-admission-v1", request: structuredClone(request), reference: { ...reference } };
    return change ? change(admission) : admission;
  });
  return { inspect } as unknown as OwnerCheckpointAdmissionPort & { inspect: typeof inspect };
}
describe("Root checkpoint consumer composition (not authority proof)", () => {
  it("passes exactly the existing snapshot, preserving bigint text and no identity/key selectors", async () => {
    const p = port(); expect(await ownerCheckpointVerifier(p)(checkpoint)).toBe(true);
    expect(p.inspect.mock.calls[0]![0]).toEqual({ owner: "sim_ai_router", scope: "cop_router_primary_database", purpose: "checkpoint",
      expectedSnapshot: { checkpointId: checkpoint.checkpoint_id, generation: checkpoint.checkpoint_generation,
        operationDigest: checkpoint.operation_digest, schemaDigest: checkpoint.schema_digest } });
  });
  it("inspects afresh for repeated and changed checkpoints instead of caching an HTTP permit", async () => {
    const p = port(), verify = ownerCheckpointVerifier(p);
    expect(await verify(checkpoint)).toBe(true); expect(await verify(checkpoint)).toBe(true);
    expect(await verify({ ...checkpoint, operation_digest: "d".repeat(64) })).toBe(true);
    expect(p.inspect).toHaveBeenCalledTimes(3); expect(p.inspect.mock.calls[2]![0].expectedSnapshot.operationDigest).toBe("d".repeat(64));
  });
  it("denies unavailable, throwing, boolean and empty replies without a positive fallback", async () => {
    for (const result of [undefined, null, true, {}, { ready: true }]) expect(await ownerCheckpointVerifier(port(() => result))(checkpoint)).toBe(false);
    expect(await ownerCheckpointVerifier({ inspect: async () => { throw Error("synthetic outage"); } })(checkpoint)).toBe(false);
  });
  it("denies every mismatched snapshot field", async () => {
    for (const key of ["checkpointId", "generation", "operationDigest", "schemaDigest"])
      expect(await ownerCheckpointVerifier(port(a => { a.request.expectedSnapshot[key] = "wrong"; return a; }))(checkpoint)).toBe(false);
  });
  it("denies wrong owner, scope, purpose, contract and malformed references", async () => {
    for (const key of ["owner", "scope", "purpose"])
      expect(await ownerCheckpointVerifier(port(a => { a.request[key] = "wrong"; return a; }))(checkpoint)).toBe(false);
    expect(await ownerCheckpointVerifier(port(a => ({ ...a, contractVersion: "wrong" })))(checkpoint)).toBe(false);
    for (const r of [{ ...reference, digest: "wrong" }, { ...reference, recordId: "wrong" }, { ...reference, extra: true }])
      expect(await ownerCheckpointVerifier(port(a => ({ ...a, reference: r })))(checkpoint)).toBe(false);
  });
  it("denies unknown keys and accessor-bearing admissions without invoking getters", async () => {
    for (const change of [(a: any) => ({ ...a, extra: true }), (a: any) => { a.request.extra = true; return a; },
      (a: any) => { a.request.expectedSnapshot.extra = true; return a; }])
      expect(await ownerCheckpointVerifier(port(change))(checkpoint)).toBe(false);
    let invoked = false;
    expect(await ownerCheckpointVerifier(port(a => { Object.defineProperty(a, "reference", { get() { invoked = true; return reference; } }); return a; }))(checkpoint)).toBe(false);
    expect(invoked).toBe(false);
  });
  it("denies non-reviewed states before asking the native client", async () => {
    const p = port(), verify = ownerCheckpointVerifier(p);
    for (const cp of [{ ...checkpoint, identity_reviewed: false }, { ...checkpoint, replay_ready: false },
      { ...checkpoint, cost_policy: "pending_requires_review" as const }]) expect(await verify(cp)).toBe(false);
    expect(p.inspect).not.toHaveBeenCalled();
  });
  it("rejects noncanonical generations, snapshot shapes and hashes before dispatch", async () => {
    const p = port(), verify = ownerCheckpointVerifier(p);
    for (const generation of ["01", "-1", "1.0", "9223372036854775808", 1])
      expect(await verify({ ...checkpoint, checkpoint_generation: generation } as Checkpoint)).toBe(false);
    for (const cp of [{ ...checkpoint, checkpoint_id: "not-a-uuid" }, { ...checkpoint, operation_digest: "A".repeat(64) },
      { ...checkpoint, extra: true }]) expect(await verify(cp)).toBe(false);
    expect(p.inspect).not.toHaveBeenCalled();
  });
});
