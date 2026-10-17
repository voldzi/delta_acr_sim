export const SIM_USER_DATA_CONTRACT:string;
export const SIM_USER_SCOPE:string;
export function canonicalOwnerKey(secret:string,identity:{issuer:string;subject:string}):string;
export function simOwnerAlias(owner:string):string;
export function signSimOwner(secret:string,value:{ownerKey:string;resetEpoch:string;oidcIat:number;operationId?:string;requestedAt?:string}):Record<string,string>;
export function verifySimOwner(req:any,options:any,now?:number):any;
