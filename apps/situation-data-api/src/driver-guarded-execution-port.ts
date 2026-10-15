/**
 * Internal application boundary proposal; type declarations only.
 *
 * No runtime implementation, transport, registrar, factory or positive verifier
 * exists in this module. These fields do not prove authority. A real protected
 * delivery must bind each operation to its registered Root permit/body/schema,
 * current owner/store/frontier and authenticated request before execution and
 * validate signed terminal records before returning a terminal result.
 * Ordinary HTTP input must never select or mint a Root operation reference.
 */
export type DriverGuardedKind = "expire" | "revoke" | "erase" | "ack";

export interface DriverGuardedOperationRef<K extends DriverGuardedKind = DriverGuardedKind> {
  // Root origin UUID, NOT the public erasure business operation ID or its HMAC.
  readonly operationId: string;
  readonly kind: K;
}

export interface DriverGuardedExpireBody {
  readonly contractVersion: "sim-driver-guarded-db-v1";
}

export interface DriverGuardedRevokeBody extends DriverGuardedExpireBody {
  readonly contributorHash: string;
}

export interface DriverGuardedErasureBody extends DriverGuardedExpireBody {
  readonly operationHash: string;
  readonly actorHash: string;
  readonly requestHash: string;
  readonly contributors: readonly {
    readonly contributorDay: string;
    readonly contributorHash: string;
  }[];
  readonly checkpointHash: string;
}

/** Root-supplied typed context, never synthesized from application DB flags. */
export interface DriverGuardedPublicationContext {
  readonly contractVersion: "cop-driver-publication-context-v1";
  readonly recordId: string;
  readonly recordDigest: string;
  readonly storeIncarnation: string;
  readonly operationDigest: string;
  readonly readbackDigest: string;
  readonly reportProtection: "no_report" | "enforced_single_writer" | "shared_generation_fence";
  readonly observedAtUTC: string;
}

export interface DriverGuardedAckBody extends DriverGuardedErasureBody {
  readonly publicationContext?: DriverGuardedPublicationContext;
}

interface BodyByKind {
  expire: DriverGuardedExpireBody;
  revoke: DriverGuardedRevokeBody;
  erase: DriverGuardedErasureBody;
  ack: DriverGuardedAckBody;
}

/** Transient in-memory body only; no SQL, URL, credential or XID selectors. */
export type DriverGuardedExecutionRequest = {
  [K in DriverGuardedKind]: {
    readonly operation: DriverGuardedOperationRef<K>;
    readonly body: BodyByKind[K];
  }
}[DriverGuardedKind];

export interface DriverGuardedRecordRef {
  readonly recordId: string;
  readonly digest: string;
}

interface DriverGuardedResultBinding {
  readonly contractVersion: "cop-driver-origin-result-v1";
  // Adapter preserves request correlation for pending wire results that omit it.
  // Local correlation is not a verified Root record or evidence of dispatch.
  readonly operationId: string;
}

export type DriverGuardedExecutionResult = DriverGuardedResultBinding & (
  | {
      readonly state: "pending";
      readonly reason: "origin-busy" | "origin-unresolved" | "store-unavailable" |
        "authority-unavailable" | "transport-unavailable";
      readonly sqlOutcomeRef?: never;
      readonly effectQuiescenceRef?: never;
      readonly revokeEffect?: never;
    }
  | {
      readonly state: "origin-commit-known";
      readonly sqlOutcomeRef: DriverGuardedRecordRef;
      readonly effectQuiescenceRef: DriverGuardedRecordRef;
      /** Only an original Root-owned scalar receipt, never an inferred count. */
      readonly revokeEffect?: { readonly deletedBatchCount: number };
    }
  | {
      readonly state: "origin-no-effects-closed";
      readonly sqlOutcomeRef: DriverGuardedRecordRef;
      readonly effectQuiescenceRef: DriverGuardedRecordRef;
      readonly revokeEffect?: never;
    }
);

/**
 * Future implementation is supplied by protected Root delivery, not an app SQL
 * pool or a callback wrapping work(). Repeats/ambiguity probe the SAME origin;
 * neither method can authorize a replacement UUID, cutoff or destructive retry.
 * Runtime exact-key validation and signature/replay checks remain mandatory.
 */
export interface DriverGuardedExecutionPort {
  execute(request: DriverGuardedExecutionRequest): Promise<DriverGuardedExecutionResult>;
  // May durably seal this exact origin via resolve_or_seal. Not a read-only GET.
  probe(operation: DriverGuardedOperationRef): Promise<DriverGuardedExecutionResult>;
}
