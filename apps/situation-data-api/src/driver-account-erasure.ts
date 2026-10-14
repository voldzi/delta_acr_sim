import { createHmac, timingSafeEqual } from "node:crypto";

export const DRIVER_ACCOUNT_ERASURE_CONTRACT = "sim-account-erasure-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class DriverAccountErasureError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export interface DriverErasureRequest {
  contractVersion: typeof DRIVER_ACCOUNT_ERASURE_CONTRACT; operationId: string;
  contributors: { contributorDay: string; contributorIdDay: string }[];
  attestation: "cop-account-erasure-contributors-reviewed-v1";
}
/** Ephemeral only: never persist the manifest or an account-to-day join. */
export interface DriverErasureInput {
  operationId: string; actorHash: string; requestHash: string;
  contributors: { contributorDay: string; contributorHash: string }[];
}
export type DriverErasureReportProtection = "unverified" | "no_report" | "enforced_single_writer" | "shared_generation_fence";
export type DriverErasurePendingReason = "replay_review_required" | "publisher_review_required" | "retention_review_required" | "derived_report_pending" | "stored_rows_remaining";
export interface DriverErasureReceipt {
  contractVersion: typeof DRIVER_ACCOUNT_ERASURE_CONTRACT; operationId: string; status: "pending" | "completed";
  scope: "online_driver_scope"; wholeAccountComplete: false; backupReplayRequired: true;
  acceptedAt: string; updatedAt: string; contributorCount: number; deletedBatchCount: number; remainingBatchCount: number;
  databaseZeroVerified: boolean; derivedReportAcknowledged: boolean; reportProtection: DriverErasureReportProtection;
  publicationFenceVerified: boolean; replayReady: boolean; retentionReviewed: boolean; pendingReason: DriverErasurePendingReason | null;
}
export interface DriverErasureServiceChecks {schemaReady:boolean;permissionsReady:boolean;identityReviewed:boolean;restoreCheckpointCurrent:boolean;retentionReviewed:boolean;publicationFenceVerified:boolean}
export type DriverErasureBlocker="erasure_disabled"|"schema_not_ready"|"permissions_not_ready"|"identity_review_required"|"restore_checkpoint_not_current"|"retention_review_required"|"publication_proof_required"|"identity_binding_review_required";
export interface DriverErasureCapability {
  contractVersion: typeof DRIVER_ACCOUNT_ERASURE_CONTRACT; owner: "sim_measurements"; scope:"online_driver_scope";enabled: boolean;ready: boolean;
  checkedAt:string;blockers:DriverErasureBlocker[];mutates:false;providerCalls:false;wholeAccountComplete:false;
  checks:DriverErasureServiceChecks;reportProtection: DriverErasureReportProtection;
}
export interface DriverErasurePreflight extends Omit<DriverErasureCapability,"checks"> {
  checks:DriverErasureServiceChecks&{identityBindingReviewed:boolean;manifestShapeAndCoverageValid:boolean};
  operationId: string; manifestValid: true; identityBinding:"cop_attested_daily_manifest";coverageAnchor:{kind:"checked_at"|"first_accepted_at";at:string};contributorCount:number;
}
export interface DriverErasureMethods {
  accountErasure(input: DriverErasureInput): Promise<DriverErasureReceipt>;
  accountErasureStatus(id: string, actorHash: string): Promise<DriverErasureReceipt | undefined>;
  acknowledgeAccountErasure(input: DriverErasureInput): Promise<DriverErasureReceipt>;
  accountErasureCapability(): Promise<DriverErasureCapability>;
  accountErasurePreflight(input: DriverErasureInput): Promise<DriverErasurePreflight>;
}
export interface DriverErasureActor { iss: string; sub: string; aud: "sim-account-erasure"; iat: number; exp: number; operationId: string; routerUserId: string }
const invalid = (): never => { throw new DriverAccountErasureError(400, "DRIVER_ACCOUNT_ERASURE_INVALID"); };
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
export function driverErasureOperationId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) return invalid();
  return value.toLowerCase();
}
export function parseDriverErasureRequest(value: unknown): DriverErasureRequest {
  const raw=exact(value,["contractVersion","operationId","contributors","attestation"]);
  if (raw.contractVersion!==DRIVER_ACCOUNT_ERASURE_CONTRACT || raw.attestation!=="cop-account-erasure-contributors-reviewed-v1" || !Array.isArray(raw.contributors) || raw.contributors.length<9 || raw.contributors.length>40) return invalid();
  const contributors=raw.contributors.map(value=>{
    const row=exact(value,["contributorDay","contributorIdDay"]);
    if (typeof row.contributorDay!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.contributorDay) || !Number.isFinite(Date.parse(`${row.contributorDay}T00:00:00Z`)) ||
        new Date(`${row.contributorDay}T00:00:00Z`).toISOString().slice(0,10)!==row.contributorDay || typeof row.contributorIdDay!=="string" || !/^[A-Za-z0-9_-]{32,128}$/.test(row.contributorIdDay)) return invalid();
    return {contributorDay:row.contributorDay,contributorIdDay:row.contributorIdDay};
  }).sort((a,b)=>a.contributorDay.localeCompare(b.contributorDay)||a.contributorIdDay.localeCompare(b.contributorIdDay));
  if (new Set(contributors.map(row=>`${row.contributorDay}:${row.contributorIdDay}`)).size!==contributors.length) return invalid();
  return {contractVersion:DRIVER_ACCOUNT_ERASURE_CONTRACT,operationId:driverErasureOperationId(raw.operationId),contributors,attestation:"cop-account-erasure-contributors-reviewed-v1"};
}
export function driverErasureRequiredDays(now:number):string[] {
  const midnight=Date.parse(`${new Date(now).toISOString().slice(0,10)}T00:00:00Z`);
  const days=Array.from({length:9},(_,i)=>new Date(midnight-(8-i)*86400000).toISOString().slice(0,10));
  const toleranceDay=new Date(now+30000).toISOString().slice(0,10);
  if (toleranceDay!==days[8]) days.push(toleranceDay);
  return days;
}
export function validateDriverErasureCoverage(input:DriverErasureInput,acceptedAt:number):void {
  const required=driverErasureRequiredDays(acceptedAt),actual=new Set(input.contributors.map(row=>row.contributorDay));
  // The recent range is a minimum, not an allowlist: COP must include older
  // retained/outbox identities and historical key versions without truncation.
  // Past inventory is bounded by the existing 40-pair contract; future extras
  // beyond this operation's original acceptance/tolerance day remain forbidden.
  const latest=required[required.length-1]!;
  if (input.contributors.length<9 || input.contributors.length>40 || required.some(day=>!actual.has(day)) || [...actual].some(day=>
      !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)!==day || day>latest)) {
    throw new DriverAccountErasureError(400,"DRIVER_ACCOUNT_ERASURE_INCOMPLETE_MANIFEST");
  }
}
export function driverErasureHash(secret:string,purpose:string,value:string):string {
  return createHmac("sha256",secret).update(`${purpose}:${value}`).digest("hex");
}
export function prepareDriverErasureInput(request:DriverErasureRequest,actor:DriverErasureActor,secret:string):DriverErasureInput {
  return {operationId:request.operationId,actorHash:driverErasureHash(secret,"cop:account-erasure-actor",JSON.stringify([actor.iss,actor.sub])),
    requestHash:driverErasureHash(secret,"cop:account-erasure-request",JSON.stringify(request)),
    contributors:request.contributors.map(row=>({contributorDay:row.contributorDay,contributorHash:driverErasureHash(secret,"cop",row.contributorIdDay)}))};
}
/** Exact compact JSON/order round-trip also rejects duplicate keys and escaped variants. */
export function verifyDriverErasureActor(header:unknown,signature:unknown,secret:string|undefined,issuer:string|undefined,operationId:string,now:number):DriverErasureActor {
  const denied=():never=>{throw new DriverAccountErasureError(401,"DRIVER_ACCOUNT_ERASURE_ACTOR_INVALID");};
  if (!secret || secret.length<32 || !issuer || typeof header!=="string" || !/^[A-Za-z0-9_-]{20,2048}$/.test(header) || typeof signature!=="string" || !/^[a-f0-9]{64}$/.test(signature)) return denied();
  if (!timingSafeEqual(createHmac("sha256",secret).update(header).digest(),Buffer.from(signature,"hex"))) return denied();
  let raw:Record<string,unknown>;
  try {
    const bytes=Buffer.from(header,"base64url"),text=bytes.toString("utf8");
    if (bytes.toString("base64url")!==header || !bytes.equals(Buffer.from(text,"utf8"))) return denied();
    raw=exact(JSON.parse(text),["iss","sub","aud","iat","exp","operationId","routerUserId"]);
    if (Object.keys(raw).join(",")!=="iss,sub,aud,iat,exp,operationId,routerUserId" || JSON.stringify(raw)!==text) return denied();
  } catch {return denied();}
  const current=Math.floor(now/1000);
  if (raw.iss!==issuer || raw.aud!=="sim-account-erasure" || typeof raw.sub!=="string" || raw.sub.length<1 || raw.sub.length>512 || /[\u0000-\u001f\u007f-\u009f]/.test(raw.sub) ||
      typeof raw.iat!=="number" || typeof raw.exp!=="number" || !Number.isSafeInteger(raw.iat) || !Number.isSafeInteger(raw.exp) || raw.iat<0 || raw.iat>current || raw.exp<=current || raw.exp<=raw.iat || raw.exp-raw.iat>60 ||
      raw.operationId!==operationId || typeof raw.routerUserId!=="string" || !/^cop_[A-Za-z0-9_-]{43}$/.test(raw.routerUserId)) return denied();
  return raw as unknown as DriverErasureActor;
}
