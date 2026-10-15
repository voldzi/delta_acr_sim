import {Pool} from "pg";
import {DatabaseErasureGuard} from "../../../deploy/account-safety/database-erasure-guard.mjs";
export async function loadDatabaseRouterGuard(targetPool:Pool):Promise<{safety:DatabaseErasureGuard;close():Promise<void>}> {
 if(!/^postgres(?:ql)?:\/\//.test(process.env.SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL??""))throw new Error("SIM_DATABASE_SAFETY_CONFIGURATION_REQUIRED");
 const guardPool=new Pool({connectionString:process.env.SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL,max:2,connectionTimeoutMillis:2000,statement_timeout:5000});
 guardPool.on("error",()=>{});
 try {const safety=new DatabaseErasureGuard({guardPool,targetPool,owner:"ai_router",guardStoreId:process.env.SIM_ACCOUNT_ERASURE_GUARD_STORE_ID??"",configurationFingerprint:process.env.SIM_ACCOUNT_ERASURE_CONFIGURATION_FINGERPRINT??""});await safety.init();return {safety,close:()=>guardPool.end()};}
 catch{await guardPool.end();throw new Error("SIM_DATABASE_SAFETY_UNAVAILABLE");}
}
