interface PoolLike {query(text:string,values?:any[]):Promise<any>;connect():Promise<any>}
interface DriverInput {operationId:string;actorHash:string;requestHash:string;contributors:readonly {contributorHash:string}[]}
export function runtimeIdentityFingerprint(owner:"sim_measurements"|"ai_router",hashSecret:string,actorSecret:string,issuer:string):string;
export function configurationFingerprint(driver:string,router:string):string;
export function verifyProductionDatabaseTransport(connectionString:string|undefined,database:string,env?:NodeJS.ProcessEnv):void;
export function verifyRuntimeIdentity(owner:"sim_measurements"|"ai_router",hashSecret:string|undefined,actorSecret:string|undefined,issuer:string|undefined,env?:NodeJS.ProcessEnv):void;
export class DatabaseErasureGuard {
 constructor(options:{guardPool:PoolLike;targetPool:PoolLike;owner:"sim_measurements"|"ai_router";guardStoreId:string;configurationFingerprint:string;driverHashSecret?:string;reportDirectory?:string});
 init():Promise<void>;
 assertCurrent():Promise<void>;
 replay():Promise<void>;
 recordDriver(input:DriverInput,enabled:boolean):Promise<void>;
 recordRouter(identity:{ownerHash:string;targetHash:string},operationId:string):Promise<void>;
 driverProof():Promise<{checkpoint:string;restoreCheckpointCurrent:boolean;identityReviewed:boolean;retentionReviewed:boolean;publicationFenceVerified:boolean;reportProtection:"unverified"|"no_report"|"enforced_single_writer"|"shared_generation_fence"}>;
 verifyRouterCheckpoint(checkpoint:unknown):Promise<boolean>;
 publicationBarrier(input:DriverInput):Promise<void>;
 writeFileReport(kind:"aggregates"|"quality",work:(lease:{assertCurrent():Promise<void>})=>Promise<unknown>):Promise<void>;
 withReportMaintenance<T>(work:()=>Promise<T>):Promise<T>;
 withLease<T>(request:{readonly kind:"aggregates"|"quality"},work:(lease:{assertCurrent():Promise<void>})=>Promise<T>):Promise<T>;
}
