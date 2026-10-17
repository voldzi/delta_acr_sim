export function runtimeIdentityFingerprint(component:string,identity:any):string;
export function loadSimUserAuthority(options:{Pool:any;targetPool:any;targetDatabaseUrl:string;component:string;settings:any;identity:any;env?:NodeJS.ProcessEnv}):Promise<{authority:any;close():Promise<void>}|undefined>;
