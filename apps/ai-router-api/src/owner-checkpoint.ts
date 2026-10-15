import { lstat, realpath, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Checkpoint, OwnerCheckpointVerifier } from "./account-erasure.js";

interface CheckpointRequest {
  readonly owner: "sim_ai_router";
  readonly scope: "cop_router_primary_database";
  readonly purpose: "checkpoint";
  readonly expectedSnapshot: {
    readonly checkpointId: string; readonly generation: string;
    readonly operationDigest: string; readonly schemaDigest: string;
  };
}
interface CheckpointAdmission {
  readonly contractVersion: "sim-ai-router-checkpoint-admission-v1";
  readonly request: CheckpointRequest;
  readonly reference: { readonly recordId: string; readonly digest: string };
}
export interface OwnerCheckpointAdmissionPort {
  inspect(request: CheckpointRequest): Promise<CheckpointAdmission | undefined>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX = /^[0-9a-f]{64}$/u;
const GENERATION = /^(?:0|[1-9][0-9]{0,18})$/u;
const COST = "aggregate-costs-current-month-v1";
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length && keys.every(k => descriptors[k] && "value" in descriptors[k]!);
}

/** Composition only, not cryptographic verification. The production port below
 * is COP's fixed native client; it verifies current signed Root evidence and
 * observed kernel peer. No database flag, cache or app callback substitutes it. */
export function ownerCheckpointVerifier(port: OwnerCheckpointAdmissionPort): OwnerCheckpointVerifier {
  return async checkpoint => {
    try {
      if (!exact(checkpoint, ["identity_reviewed", "replay_ready", "cost_policy", "checkpoint_id", "checkpoint_generation", "operation_digest", "schema_digest"]) ||
        checkpoint.identity_reviewed !== true || checkpoint.replay_ready !== true || checkpoint.cost_policy !== COST ||
        typeof checkpoint.checkpoint_id !== "string" || !UUID.test(checkpoint.checkpoint_id) ||
        typeof checkpoint.checkpoint_generation !== "string" || !GENERATION.test(checkpoint.checkpoint_generation) || BigInt(checkpoint.checkpoint_generation) > 9223372036854775807n ||
        typeof checkpoint.operation_digest !== "string" || !HEX.test(checkpoint.operation_digest) ||
        typeof checkpoint.schema_digest !== "string" || !HEX.test(checkpoint.schema_digest)) return false;
      const expectedSnapshot = Object.freeze({ checkpointId: checkpoint.checkpoint_id, generation: checkpoint.checkpoint_generation,
        operationDigest: checkpoint.operation_digest, schemaDigest: checkpoint.schema_digest });
      const request: CheckpointRequest = Object.freeze({ owner: "sim_ai_router", scope: "cop_router_primary_database", purpose: "checkpoint", expectedSnapshot });
      // Always inspect afresh. An HTTP request can have several checks, including
      // after provider I/O; background maintenance needs its own Root owner lease.
      const admission: unknown = await port.inspect(request);
      if (!exact(admission, ["contractVersion", "request", "reference"]) || admission.contractVersion !== "sim-ai-router-checkpoint-admission-v1" ||
        !exact(admission.request, ["owner", "scope", "purpose", "expectedSnapshot"]) ||
        admission.request.owner !== request.owner || admission.request.scope !== request.scope || admission.request.purpose !== request.purpose ||
        !exact(admission.request.expectedSnapshot, ["checkpointId", "generation", "operationDigest", "schemaDigest"]) ||
        !exact(admission.reference, ["recordId", "digest"]) || typeof admission.reference.recordId !== "string" || !UUID.test(admission.reference.recordId) ||
        typeof admission.reference.digest !== "string" || !HEX.test(admission.reference.digest)) return false;
      const returnedSnapshot = admission.request.expectedSnapshot;
      if (!Object.entries(expectedSnapshot).every(([key, value]) => returnedSnapshot[key] === value)) return false;
      return true;
    } catch { return false; }
  };
}

/** No environment-selected path, module, verifier or transport. Root code-tree
 * validation inside the native client additionally checks its whole closure.
 * Missing installation stays unavailable; an erasure-disabled flag is no bypass. */
export async function loadProductionOwnerCheckpointVerifier(): Promise<OwnerCheckpointVerifier> {
  try {
    const modulePath = "/opt/cop-account-safety/ai-root-inspect.mjs";
    for (const path of ["/", "/opt", "/opt/cop-account-safety", modulePath]) {
      const s = await lstat(path);
      if (s.uid !== 0 || (s.mode & 0o022) || s.isSymbolicLink() ||
        (path === modulePath ? !s.isFile() || s.nlink !== 1 : !s.isDirectory())) throw new Error("owner_code_custody");
    }
    if (await realpath(modulePath) !== modulePath) throw new Error("owner_code_path");
    // Check the whole dependency tree BEFORE importing any of it. Checking only
    // the entry file would execute a writable imported helper before the native
    // factory had the opportunity to enforce its own code-tree custody.
    let entries = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 64) throw new Error("owner_code_depth");
      for (const name of await readdir(directory)) {
        if (++entries > 20_000) throw new Error("owner_code_size");
        const path = directory + "/" + name, s = await lstat(path);
        if (s.uid !== 0 || (s.mode & 0o022) || (!s.isDirectory() && (!s.isFile() || s.nlink !== 1))) throw new Error("owner_code_custody");
        if (s.isDirectory()) await visit(path, depth + 1);
      }
    };
    await visit("/opt/cop-account-safety", 0);
    const module: unknown = await import(pathToFileURL(modulePath).href);
    const factory = (module as { createProductionAiCheckpointAdmissionPort?: unknown }).createProductionAiCheckpointAdmissionPort;
    if (typeof factory !== "function") throw new Error("owner_factory_missing");
    const port: unknown = factory();
    if (!port || typeof (port as OwnerCheckpointAdmissionPort).inspect !== "function") throw new Error("owner_port_missing");
    return ownerCheckpointVerifier(port as OwnerCheckpointAdmissionPort);
  } catch {
    console.warn(JSON.stringify({ event: "ai_router_checkpoint_authority_unavailable", code: "OWNER_BINDING_UNAVAILABLE" }));
    return async (_checkpoint: Checkpoint) => false;
  }
}
