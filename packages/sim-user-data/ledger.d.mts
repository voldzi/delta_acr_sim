export class UserLedger {
 constructor(pool:any,expected:any,schema?:string,authority?:any);
 pool:any;expected:any;schema:string;
 tx<T>(work:(client:any,config:any)=>Promise<T>):Promise<T>;
 withOwner<T>(owner:string,work:(client:any,account:any)=>Promise<T>,options?:{create?:boolean}):Promise<T>;
 request(owner:string,operation:string,at:string,oidcIat:number):Promise<any>;
 receipt(account:any,job:any):any;
 status(owner:string,operation:string):Promise<any>;
 runOne(clean:(client:any,account:any,job:any)=>Promise<any>,options?:{includeCompleted?:boolean}):Promise<any>;
}
