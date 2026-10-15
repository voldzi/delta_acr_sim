import {Pool} from "pg";
import {DatabaseErasureGuard,verifyRuntimeIdentity,verifyProductionDatabaseTransport} from "../../../deploy/account-safety/database-erasure-guard.mjs";
import type {DriverMeasurementDependencies} from "./driver-measurements.js";
import type {DriverRetentionConsumer} from "./driver-retention-lifecycle.js";

/** Explicit alternative from ADR0040, never fallback after a Root error. */
export async function loadDatabaseDriverOwnerComposition():Promise<{driverMeasurements:DriverMeasurementDependencies;close():Promise<void>}> {
 const guardPool=new Pool({connectionString:process.env.SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL,max:2,connectionTimeoutMillis:2000,statement_timeout:5000});
 const targetPool=new Pool({connectionString:process.env.DRIVER_MEASUREMENTS_DATABASE_URL,max:2,connectionTimeoutMillis:2000,statement_timeout:5000});
 for(const pool of [guardPool,targetPool])pool.on("error",()=>{});
 try {
  if(!/^postgres(?:ql)?:\/\//.test(process.env.SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL??"")||!/^postgres(?:ql)?:\/\//.test(process.env.DRIVER_MEASUREMENTS_DATABASE_URL??"")||!process.env.DRIVER_MEASUREMENTS_HASH_SECRET||process.env.DRIVER_MEASUREMENTS_HASH_SECRET.length<32)throw new Error("SIM_DATABASE_SAFETY_CONFIGURATION_REQUIRED");
  verifyRuntimeIdentity("sim_measurements",process.env.DRIVER_MEASUREMENTS_HASH_SECRET,process.env.DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET,process.env.DRIVER_ACCOUNT_ERASURE_ISSUER);
  verifyProductionDatabaseTransport(process.env.SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL,"cop_account_safety_guard");
  verifyProductionDatabaseTransport(process.env.DRIVER_MEASUREMENTS_DATABASE_URL,"sim_driver_measurements");
  const safety=new DatabaseErasureGuard({guardPool,targetPool,owner:"sim_measurements",guardStoreId:process.env.SIM_ACCOUNT_ERASURE_GUARD_STORE_ID??"",configurationFingerprint:process.env.SIM_ACCOUNT_ERASURE_CONFIGURATION_FINGERPRINT??"",driverHashSecret:process.env.DRIVER_MEASUREMENTS_HASH_SECRET});
  await safety.init();
  return {driverMeasurements:{databaseSafety:safety,accountErasureProtectedProof:()=>safety.driverProof(),accountErasureDerivedBarrier:()=>safety.publicationBarrier(),publication:safety,
   retentionConsumer:Object.freeze({owner:"sim_driver_measurements" as const,execute:async(work:Parameters<DriverRetentionConsumer["execute"]>[0])=>{await safety.assertCurrent();await work(Object.freeze({owner:"sim_driver_measurements",cutoff:new Date().toISOString()}));await safety.assertCurrent();}})},
   close:async()=>{await guardPool.end();await targetPool.end();}};
 }catch{await guardPool.end();await targetPool.end();throw new Error("SIM_DATABASE_SAFETY_UNAVAILABLE");}
}
