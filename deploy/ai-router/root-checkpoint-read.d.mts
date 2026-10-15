/** Private native-broker interface. The application supplies neither a permit
 * UUID nor a peer identity. The actual Root broker resolves its protected
 * ai-router-read-delivery reference and supplies its kernel-observed peer. */
export interface AiCheckpointSnapshot {
  readonly checkpointId: string;
  /** Canonical decimal bigint text; never a JavaScript number conversion. */
  readonly generation: string;
  readonly operationDigest: string;
  readonly schemaDigest: string;
}
export interface AiCheckpointReadRequest {
  readonly owner: 'sim_ai_router';
  readonly scope: 'cop_router_primary_database';
  readonly purpose: 'checkpoint';
  readonly expectedSnapshot: AiCheckpointSnapshot;
}
export interface KernelAiCheckpointPeer {
  readonly device: string;
  readonly inode: string;
  readonly uid: number;
  readonly gid: number;
}
export interface AiCheckpointReadAdmission {
  readonly contractVersion: 'sim-ai-router-checkpoint-admission-v1';
  readonly request: AiCheckpointReadRequest;
  readonly reference: { readonly recordId: string; readonly digest: string };
}
export function inspectRootAiCheckpoint(readPermitId: string, request: AiCheckpointReadRequest, peer: KernelAiCheckpointPeer): Promise<{
  readonly admission: AiCheckpointReadAdmission;
  /** Canonical inline Ed25519 Root record, including its trailing newline.
   * Lifetime is at most five seconds and bounded by every current Root proof. */
  readonly record: string;
}>;
