export interface CleanExpected {lane:'ai'|'driver';mode?:'isolated-clean-lifecycle-v1'|'production-clean-lifecycle-v1';environmentId:string;resetEpoch:string;tokensNotBefore?:number;userDatasetId?:string;enrollmentId?:string}
export class CleanLifecycle {
 constructor(pool:unknown,expected:CleanExpected);
 tx<T>(action:(client:{query:(sql:string,args?:unknown[])=>Promise<any>},config:any)=>Promise<T>):Promise<T>;
 assertIntake(client:{query:(sql:string,args?:any[])=>Promise<any>},resourceHash?:string):Promise<void>;
 reserve(owner:string,resources:string[]):Promise<void>;
 request(owner:string,operation:string,at:string):Promise<{state:string}>;
 status(owner:string,operation:string):Promise<{state:string}|null>;
 runOne():Promise<{state:string}>;
 purgeExpiredTotals():Promise<number>;
 capability():Promise<boolean>;
}
