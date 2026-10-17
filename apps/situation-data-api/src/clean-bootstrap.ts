import {Pool} from 'pg';
import {createHmac} from 'node:crypto';
import {loadCleanRuntime} from '../../../packages/clean-lifecycle/runtime.mjs';
import type {CleanLifecycle} from '../../../packages/clean-lifecycle/store.mjs';
import {PostgresDriverMeasurementStore} from './driver-measurement-store.js';
import {driverSettings} from './driver-measurements.js';

export async function loadCleanDriverComposition(settings=driverSettings(),env:NodeJS.ProcessEnv=process.env){
 if(env.SIM_CLEAN_LIFECYCLE_ENABLED===undefined||env.SIM_CLEAN_LIFECYCLE_ENABLED==='false')return undefined;
 if(settings.driverAccountErasureEnabled)throw new Error('CLEAN_LEGACY_COMPOSITION_CONFLICT');
 if(!settings.databaseUrl||!settings.hashSecret)throw new Error('INVALID_CLEAN_DRIVER_CONFIGURATION');
 const pool=new Pool({connectionString:settings.databaseUrl,max:4,connectionTimeoutMillis:1500});
 pool.on('error',()=>{});
 let store:PostgresDriverMeasurementStore|undefined;
 try{
  const runtime=await loadCleanRuntime({pool,lane:'driver',serviceToken:settings.token,actorSecret:settings.driverAccountErasureActorSecret,
   ownerSecret:settings.driverAccountErasureActorSecret,issuer:settings.driverAccountErasureIssuer,
   hashResource:id=>createHmac('sha256',settings.hashSecret!).update(`cop:${id}`).digest('hex'),env});
  if(!runtime)throw new Error('INVALID_CLEAN_DRIVER_CONFIGURATION');
  store=new PostgresDriverMeasurementStore(settings.databaseUrl,settings.hashSecret,{cleanLifecycle:{mode:'isolated-clean-lifecycle-v1',service:runtime.options.service as CleanLifecycle}});
  await store.init();await store.startRetention();
  return {...runtime,driverMeasurements:{store},async close(){try{await runtime.close();}finally{try{await store!.close();}finally{await pool.end();}}}};
 }catch(error){await store?.close().catch(()=>{});await pool.end();throw error;}
}
