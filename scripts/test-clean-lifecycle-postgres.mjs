// Actual owned PostgreSQL fixture; no external URL or provider accepted.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, rm, chmod} from 'node:fs/promises';
import {statSync, realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CleanLifecycle,installFence} from '../packages/clean-lifecycle/store.mjs';
import {exerciseHttp} from './test-clean-lifecycle-http.mjs';
import {loadCleanRuntime} from '../packages/clean-lifecycle/runtime.mjs';
if(process.argv.length!==3 || process.argv[2]!=='--run') throw new Error('Only --run; no remote targets');
const source=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {Pool}=createRequire(join(source,'apps/ai-router-api/package.json'))('pg');
const exec=promisify(execFile), bin='/opt/homebrew/opt/postgresql@18/bin';
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR'].includes(k)));
assert.match((await exec(join(bin,'postgres'),['--version'],{env})).stdout,/PostgreSQL\) 18\.3/);
const previous=process.umask(0o077), root=await mkdtemp('/private/tmp/sim-clean-owned-pg-');
await chmod(root,0o700);await mkdir(join(root,'s'),{mode:0o700});
const local=dirname(fileURLToPath(import.meta.url));
function owned(){assert.equal(dirname(realpathSync(root)),'/private/tmp');assert.equal(statSync(root).uid,process.getuid());assert.equal(statSync(root).mode&0o777,0o700)}
const pools=[];let started=false,passed=false;
const pool=(database,user='fixture_owner')=>{const p=new Pool({host:join(root,'s'),database,user,port:5432,connectionTimeoutMillis:2000,statement_timeout:5000});pools.push(p);return p};
async function start(){owned();await exec(join(bin,'pg_ctl'),['-D',join(root,'db'),'-l',join(root,'pg.log'),'-o',`-k ${join(root,'s')} -c listen_addresses=''`,'-w','start'],{env});started=true}
async function stop(){owned();await exec(join(bin,'pg_ctl'),['-D',join(root,'db'),'-m','fast','-w','stop'],{env});started=false}
let checks=0;const check=(v,msg)=>{assert.ok(v,msg);checks++};
const hash=n=>n.toString(16).padStart(64,'0');
try{
 owned();await exec(join(bin,'initdb'),['-D',join(root,'db'),'-U','fixture_owner','--auth-local=trust','--auth-host=reject','--no-locale'],{env});await start();
 const admin=pool('postgres');
 const who=(await admin.query("SELECT current_setting('data_directory') AS d,current_setting('listen_addresses') AS l,inet_server_addr() AS a")).rows[0];
 assert.equal(who.d,join(root,'db'));assert.equal(who.l,'');assert.equal(who.a,null);
 await admin.query('CREATE ROLE ai_router_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION');
 for(const lane of ['ai','driver']){
   const database=`fixture_${lane}`;await pool('postgres').query(`CREATE DATABASE ${database}`);
   const owner=pool(database);
   for(const path of lane==='ai'?['deploy/ai-router/001_schema.sql','deploy/ai-router/002_separate_billing.sql']:['deploy/driver-measurements/schema.sql']) await owner.query(await readFile(join(source,path),'utf8'));
   await owner.query(await readFile(join(source,'deploy/clean-lifecycle/001_clean_lifecycle.sql'),'utf8'));
   const expected={lane,environmentId:randomUUID(),resetEpoch:randomUUID()};
   await owner.query("INSERT INTO sim_clean.config VALUES(true,'cop-sim-user-lifecycle-v1','isolated-clean-lifecycle-v1',$1,$2,$3)",[expected.environmentId,expected.resetEpoch,lane]);
   await installFence(owner,lane);
   if(lane==='ai')await owner.query(await readFile(join(source,'deploy/clean-lifecycle/002_ai_budget_views.sql'),'utf8'));
   await owner.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
   await owner.query('GRANT USAGE ON SCHEMA sim_clean TO ai_router_runtime');
   await owner.query('GRANT SELECT ON sim_clean.config TO ai_router_runtime');
   await owner.query('GRANT SELECT,INSERT,UPDATE ON sim_clean.account,sim_clean.resource,sim_clean.job,sim_clean.cost_daily TO ai_router_runtime');
   await owner.query('GRANT DELETE ON sim_clean.cost_daily TO ai_router_runtime');
   await owner.query('GRANT EXECUTE ON FUNCTION sim_clean.fence() TO ai_router_runtime');
   if(lane==='ai')await owner.query('GRANT SELECT ON sim_clean.router_usage,sim_clean.billing_usage TO ai_router_runtime');
   const tables=lane==='ai'?['ai_router_request','ai_router_user_key','ai_router_user_key_audit','ai_router_billing_request']:['driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta','driver_measurement_revocations'];
   for(const table of tables) await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.${table} TO ai_router_runtime`);
   if(lane==='ai')await owner.query('GRANT USAGE ON SEQUENCE ai_router_user_key_audit_id_seq TO ai_router_runtime');
   let runtime=pool(database,'ai_router_runtime'), service=new CleanLifecycle(runtime,expected);
   await assert.rejects(runtime.query('CREATE TABLE public.forbidden(i int)'));checks++;
   await assert.rejects(runtime.query('UPDATE sim_clean.config SET reset_epoch=$1',[randomUUID()]));checks++;
   const a=hash(1),b=hash(2),ha=hash(11),hb=hash(12);
   await service.reserve(a,[ha]);await service.reserve(b,[hb]);
   await assert.rejects(service.reserve(b,[ha]),/OWNER_BINDING_CONFLICT/);checks++;
   const insert=async(c,h)=>{
     if(lane==='ai')await c.query("INSERT INTO ai_router_request(id,client_id,user_hash,task_type,model,routing_reason,difficulty,status,reserved_microusd,charged_microusd,input_tokens,output_tokens) VALUES($1,'cop',$2,'cop_chat','fixture','fixture','simple','success',10,7,2,3)",[randomUUID(),h]);
     else await c.query("INSERT INTO driver_measurement_receipts VALUES('cop',$1,$2,$3,now(),now()+interval '7 days','{}')",[randomUUID(),h,hash(100)]);
   };
   await insert(runtime,ha);await insert(runtime,hb);
   await assert.rejects(insert(runtime,hash(99)));checks++;
   if(lane==='ai') {
     for(const h of [ha,hb]){
       await runtime.query("INSERT INTO ai_router_user_key(user_hash,ciphertext,nonce,auth_tag,fingerprint) VALUES($1,'\\x01','\\x02','\\x03','synthetic')",[h]);
       await runtime.query("INSERT INTO ai_router_user_key_audit(user_hash,action,fingerprint) VALUES($1,'created','synthetic')",[h]);
       await runtime.query("INSERT INTO ai_router_billing_request(id,billing_source,payer_hash,actor_hash,credential_fingerprint,task_type,model,status,reserved_microusd,estimated_microusd) VALUES($1,'user_openai_key',$2,$2,'synthetic','cop_chat','fixture','success',5,3)",[randomUUID(),h]);
     }
     await owner.query('INSERT INTO ai_router_policy VALUES(1,false,false,100,1000,10,now())');
   }else{
     for(const h of [ha,hb]){
       const batch=(await runtime.query('SELECT batch_id FROM driver_measurement_receipts WHERE contributor_hash=$1',[h])).rows[0].batch_id;
       await runtime.query("INSERT INTO driver_measurement_intervals VALUES('cop',$1,$2,'fixture-graph','1',now(),30,50,6)",[batch,hash(h===ha?30:31)]);
       await runtime.query("INSERT INTO driver_measurement_eta VALUES('cop',$1,$2,$3,'fixture-graph',now(),60,70)",[batch,randomUUID(),h]);
       await runtime.query("INSERT INTO driver_measurement_revocations VALUES('cop',$1,now()+interval '7 days')",[h]);
     }
   }
   // A real writer holds the account SHARE lock via the trigger until commit.
   const writer=await runtime.connect();await writer.query('BEGIN');await insert(writer,ha);
   const op=randomUUID(),at=new Date().toISOString();let accepted=false;
   const request=service.request(a,op,at).then(x=>{accepted=true;return x});
   await new Promise(r=>setTimeout(r,80));check(!accepted,'fence must wait for in-flight writer');
   await writer.query('COMMIT');writer.release();
   check((await request).state==='deletion_pending','durable pending');
   await assert.rejects(insert(runtime,ha));checks++;
   check((await service.request(a,op,at)).state==='deletion_pending','idempotent');
   await assert.rejects(service.request(a,randomUUID(),at),/IMMUTABLE_OPERATION_CONFLICT/);checks++;
   let reservation;
   if(lane==='ai'){
     // Simulate an already accepted reservation, as an owner-only test setup.
     reservation=randomUUID();await owner.query('ALTER TABLE ai_router_request DISABLE TRIGGER clean_user_fence');
     try{await owner.query("INSERT INTO ai_router_request(id,client_id,user_hash,task_type,model,routing_reason,difficulty,status,reserved_microusd) VALUES($1,'cop',$2,'cop_chat','fixture','fixture','simple','reserved',10)",[reservation,ha]);}
     finally{await owner.query('ALTER TABLE ai_router_request ENABLE TRIGGER clean_user_fence')}
     check((await service.runOne()).state==='deletion_pending','unsettled reservation pending');
     check(Number((await owner.query('SELECT count(*) AS n FROM ai_router_user_key WHERE user_hash=$1',[ha])).rows[0].n)===0,'key removed while pending');
     await runtime.query("UPDATE ai_router_request SET status='success',charged_microusd=4 WHERE id=$1",[reservation]);
   }
   // Close all clients and restart the ACTUAL owned PostgreSQL server.
   for(const p of pools)if(!p.ended&&!p.ending)await p.end();
   await stop();
   await assert.rejects(new CleanLifecycle(pool(database,'ai_router_runtime'),expected).runOne());checks++;
   await start();runtime=pool(database,'ai_router_runtime');service=new CleanLifecycle(runtime,expected);
   if(lane==='ai')await new Promise(r=>setTimeout(r,1100));
   const faultOwner=pool(database);
   await faultOwner.query("CREATE FUNCTION sim_clean.fixture_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.completed_at IS NOT NULL THEN RAISE EXCEPTION 'SYNTHETIC_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_fault BEFORE UPDATE ON sim_clean.job FOR EACH ROW EXECUTE FUNCTION sim_clean.fixture_fault()");
   await assert.rejects(service.runOne(),/SYNTHETIC_FAILURE/);checks++;
   check((await faultOwner.query('SELECT state FROM sim_clean.account WHERE owner_key=$1',[a])).rows[0].state==='deletion_pending','failed cleanup stays pending');
   check(Number((await faultOwner.query(`SELECT count(*) AS n FROM ${lane==='ai'?'ai_router_request WHERE user_hash':'driver_measurement_receipts WHERE contributor_hash'}=$1`,[ha])).rows[0].n)>0,'failed cleanup rolled back data removal');
   await faultOwner.query('DROP TRIGGER fixture_fault ON sim_clean.job; DROP FUNCTION sim_clean.fixture_fault()');
   check((await service.runOne()).state==='deleted','restart resumes committed pending job');
   check((await service.runOne()).state==='idle','no double cleanup or rollup');
   await assert.rejects(insert(runtime,ha));checks++;
   await assert.rejects(service.reserve(a,[ha]),/CLEAN_ACCOUNT_FENCED/);checks++;
   await insert(runtime,hb);check(true,'other user still writes');
   const own=pool(database);
   await assert.rejects(runtime.query("UPDATE sim_clean.account SET state='active' WHERE owner_key=$1",[a]),/IMMUTABLE_LIFECYCLE/);checks++;
   await assert.rejects(runtime.query('UPDATE sim_clean.resource SET owner_key=$1 WHERE resource_hash=$2',[b,ha]),/IMMUTABLE_OWNER_BINDING/);checks++;
   await assert.rejects(runtime.query('UPDATE sim_clean.job SET operation_id=$1 WHERE owner_key=$2',[randomUUID(),a]),/IMMUTABLE_OPERATION/);checks++;
   const count=(await own.query(`SELECT count(*) AS n FROM ${lane==='ai'?'ai_router_request WHERE user_hash':'driver_measurement_receipts WHERE contributor_hash'}=$1`,[ha])).rows[0].n;
   check(Number(count)===0,'actual userdata absent');
   if(lane==='ai'){
     check(Number((await own.query('SELECT sum(microusd) AS n FROM sim_clean.cost_daily')).rows[0].n)===21,'cost totals preserved exactly once');
     check(Number((await own.query('SELECT count(*) AS n FROM ai_router_policy')).rows[0].n)===1,'policy preserved');
     check((await own.query("SELECT bool_and(expires_at=(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC') AS ok FROM sim_clean.cost_daily")).rows[0].ok,'retention ends at next UTC month boundary');
     await own.query("INSERT INTO sim_clean.cost_daily VALUES('expired',current_date-40,5,1,0,0,now()-interval '1 second')");
     check(await service.purgeExpiredTotals()===1,'expired anonymous totals purged');
     check(await service.purgeExpiredTotals()===0,'purge idempotent');
     for(const table of ['ai_router_user_key','ai_router_user_key_audit','ai_router_billing_request']) {
       const column=table==='ai_router_billing_request'?'actor_hash':'user_hash';
       check(Number((await own.query(`SELECT count(*) AS n FROM ${table} WHERE ${column}=$1`,[ha])).rows[0].n)===0,'all A linked material absent');
       check(Number((await own.query(`SELECT count(*) AS n FROM ${table} WHERE ${column}=$1`,[hb])).rows[0].n)===1,'all B linked material preserved');
     }
   }else check(Number((await own.query('SELECT count(*) AS n FROM driver_measurement_eta WHERE contributor_hash=$1',[ha])).rows[0].n)===0,'ETA cascade erased');
   await assert.rejects(new CleanLifecycle(runtime,{...expected,resetEpoch:randomUUID()}).runOne(),/CLEAN_CONFIG_MISMATCH/);checks++;
   checks+=await exerciseHttp(service,runtime,lane,expected);
   const unused=hash(777),unusedOperation=randomUUID();
   check((await service.request(unused,unusedOperation,new Date().toISOString())).state==='deletion_pending','never-used owner is atomically fenced');
   check((await service.runOne()).state==='deleted','never-used owner cleanup completes');
   const racing=hash(778),racingOp=randomUUID();
   const race=await Promise.allSettled([service.reserve(racing,[hash(779)]),service.request(racing,racingOp,new Date().toISOString())]);
   check(race[1].status==='fulfilled','deletion commits across concurrent first reserve');
   check((await service.runOne()).state==='deleted','concurrent first-use owner erased');
   await assert.rejects(service.reserve(racing,[hash(779)]));checks++;
   const loaderInput={pool:runtime,lane,serviceToken:'synthetic-service-'.repeat(4),actorSecret:'synthetic-signing-'.repeat(4),ownerSecret:'synthetic-owner-'.repeat(4),issuer:'https://identity.invalid/isolated',hashResource:x=>x};
   check(await loadCleanRuntime({...loaderInput,env:{}})===undefined,'runtime is disabled by default');
   const loaded=await loadCleanRuntime({...loaderInput,env:{SIM_CLEAN_LIFECYCLE_ENABLED:'true',SIM_CLEAN_LIFECYCLE_MODE:'isolated-clean-lifecycle-v1',SIM_CLEAN_LIFECYCLE_ENVIRONMENT_ID:expected.environmentId,SIM_CLEAN_LIFECYCLE_RESET_EPOCH:expected.resetEpoch,SIM_CLEAN_LIFECYCLE_TOKENS_NOT_BEFORE:'0'}});
   check(loaded.options.workerReady()===false,'unscheduled worker not ready');loaded.start();
   check(loaded.options.workerReady()===true,'worker scheduled with actual DB verified');await loaded.close();
   check(loaded.options.workerReady()===false,'worker closed without leaked timer');
   await own.query('DELETE FROM sim_clean.config');
   await assert.rejects(service.reserve(hash(90),[hash(91)]),/CLEAN_CONFIG_MISMATCH/);checks++;
   // Fresh admin connection after the per-lane restart.
   if(lane==='ai'){await own.end();}
 }
 passed=true;console.log(JSON.stringify({contract:'cop-sim-user-lifecycle-v1',mode:'isolated-clean-lifecycle-v1',postgres:'18.3',transport:'unix-only',checks,actualDatabaseRestarts:2,providerCalls:0,productionWrites:0}));
}finally{
 for(const p of pools)if(!p.ended&&!p.ending)await p.end().catch(()=>{});
 if(started)await stop();if(passed){owned();await rm(root,{recursive:true});}
 process.umask(previous);
}
