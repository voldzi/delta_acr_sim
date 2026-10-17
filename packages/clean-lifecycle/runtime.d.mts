import type {CleanLifecycleOptions} from './http.mjs';
export function loadCleanRuntime(input:{pool:unknown;lane:'ai'|'driver';serviceToken?:string;actorSecret?:string;ownerSecret?:string;issuer?:string;hashResource:(s:string)=>string;env?:NodeJS.ProcessEnv}):Promise<{options:CleanLifecycleOptions;start:()=>void;close:()=>Promise<void>}|undefined>;
