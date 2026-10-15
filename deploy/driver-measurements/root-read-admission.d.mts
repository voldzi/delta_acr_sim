/** Private native-broker interface. Neither identity nor permit is an HTTP field. */
type DriverReadBase = {
  readonly owner: 'sim_driver_measurements';
  readonly scope: 'online_driver_scope';
};
export type DriverReadRequest = DriverReadBase & (
  | { readonly purpose: 'capability' | 'intake' }
  | { readonly purpose: 'preflight' | 'status' | 'receipt'; readonly operationHash: string; readonly actorHash: string }
);
export interface KernelDriverPeer {
  readonly device: string;
  readonly inode: string;
  readonly uid: number;
  readonly gid: number;
}
export type DriverReadAdmission = DriverReadRequest & {
  readonly contractVersion: 'sim-driver-guarded-read-admission-v1';
  readonly checkpointHash: string;
  readonly reportProtection: 'no_report' | 'enforced_single_writer' | 'shared_generation_fence';
  readonly reference: { readonly recordId: string; readonly digest: string };
};
export function inspectRootDriver(readPermitId: string, request: DriverReadRequest, peer: KernelDriverPeer): Promise<{
  readonly admission: DriverReadAdmission;
  /** Canonical, inline Ed25519 Root record, including its trailing newline. */
  readonly record: string;
}>;
