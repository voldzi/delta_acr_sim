import type {Express} from 'express';
export interface CleanLifecycleOptions {
 enabled:boolean; serviceToken:string; actorSecret:string; ownerSecret:string; issuer:string;tokensNotBefore:number;workerReady?:()=>boolean;
 expected:{mode:'isolated-clean-lifecycle-v1';lane:'ai'|'driver';environmentId:string;resetEpoch:string};
 hashResource:(resourceId:string)=>string;
 service:{reserve:(ownerKey:string,hashes:string[])=>Promise<unknown>;request:(ownerKey:string,operationId:string,requestedAt:string)=>Promise<{state:string}>;status:(ownerKey:string,operationId:string)=>Promise<{state:string}|null>;runOne:()=>Promise<unknown>;purgeExpiredTotals:()=>Promise<unknown>;capability:()=>Promise<boolean>};
}
export function registerCleanLifecycle(app:Express,options:CleanLifecycleOptions):{tick:()=>Promise<void>};
