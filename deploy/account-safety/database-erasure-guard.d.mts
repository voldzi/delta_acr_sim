interface PoolLike {query(text:string,values?:any[]):Promise<any>;connect():Promise<any>}
interface DriverInput {operationId:string;actorHash:string;requestHash:string;contributors:readonly {contributorHash:string}[]}
export class DatabaseErasureGuard {
 constructor(options:{guardPool:PoolLike;targetPool:PoolLike;owner:"sim_measurements"|"ai_router";guardStoreId:string;configurationFingerprint:string;driverHashSecret?:string});
 init():Promise<void>;
 assertCurrent():Promise<void>;
 replay():Promise<void>;
 recordDriver(input:DriverInput,enabled:boolean):Promise<void>;
 recordRouter(identity:{ownerHash:string;targetHash:string},operationId:string):Promise<void>;
 driverProof():Promise<{checkpoint:string;restoreCheckpointCurrent:boolean;identityReviewed:boolean;retentionReviewed:boolean;publicationFenceVerified:boolean;reportProtection:"unverified"|"no_report"|"enforced_single_writer"|"shared_generation_fence"}>;
 verifyRouterCheckpoint(checkpoint:unknown):Promise<boolean>;
 publicationBarrier():Promise<void>;
 withLease<T>(request:{readonly kind:"aggregates"|"quality"},work:(lease:{assertCurrent():Promise<void>})=>Promise<T>):Promise<T>;
}
