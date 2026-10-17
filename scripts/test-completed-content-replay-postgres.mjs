/** OWN temporary PG only. Actual pg_dump/restore, no disabled triggers or fake receipts. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {statSync,realpathSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CleanLifecycle} from '../packages/clean-lifecycle/store.mjs';
import {completedReplayEnabled,COMPLETED_REPLAY_MODE} from '../packages/clean-lifecycle/completed-replay.mjs';
import {BudgetStore} from '../apps/ai-router-api/dist/budget.js';
import {loadSimHistory} from '../apps/ai-router-api/dist/sim-user-history.js';
import {simOwnerAlias,signSimOwner} from '../packages/sim-user-data/claims.mjs';
import {createServer} from 'node:http';
assert.deepEqual(process.argv.slice(2),['--run']);
const source=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {Pool}=createRequire(join(source,'apps/ai-router-api/package.json'))('pg');
const exec=promisify(execFile),bin='/opt/homebrew/opt/postgresql@18/bin';
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR'].includes(k)));
process.umask(0o077);
const root=await mkdtemp('/private/tmp/sim-completed-replay-pg-');
const pools=[],histories=[],stores=[],servers=[];let started=false,passed=false,checks=0;const evidence=[];
const originalHistoryReplay=process.env.SIM_USER_HISTORY_COMPLETED_REPLAY_MODE;
const check=(v,m)=>{assert.ok(v,m);checks++};
const h=x=>createHash('sha256').update(x).digest('hex');
const pool=(database,user='fixture_owner')=>{const p=new Pool({host:join(root,'s'),port:5432,user,database,max:2,connectionTimeoutMillis:2000,statement_timeout:7000});p.on('error',()=>{});pools.push(p);return p};
const pg=async(command,args)=>exec(join(bin,command),args,{env,maxBuffer:4*1024*1024});
const sql=async(c,path)=>c.query(await readFile(join(source,path),'utf8'));
async function historyFor(database,settings){
 const params=new URLSearchParams({host:join(root,'s'),port:'5432',user:'ai_router_runtime'});
 const url='postgresql:///'+database+'?'+params;
 const limits={dailyMicrousd:1000000,monthlyMicrousd:10000000,perUserDailyRequests:100};
 const store=new BudgetStore(url,'synthetic-history-hash-secret'.repeat(3),limits);stores.push(store);
 process.env.SIM_USER_HISTORY_COMPLETED_REPLAY_MODE=COMPLETED_REPLAY_MODE;
 const history=await loadSimHistory({databaseUrl:url,userHashSecret:'synthetic-history-hash-secret'.repeat(3),accountErasureIssuer:'https://identity.invalid/cop',simToken:'synthetic-sim-service-token'.repeat(3)},store,settings);histories.push(history);
 return {history,store};
}
try{
 assert.equal(dirname(realpathSync(root)),'/private/tmp');assert.equal(statSync(root).uid,process.getuid());assert.equal(statSync(root).mode&0o777,0o700);
 await mkdir(join(root,'s'),{mode:0o700});
 await pg('initdb',['-D',join(root,'db'),'-U','fixture_owner','--auth-local=trust','--auth-host=reject','--no-locale']);
 await pg('pg_ctl',['-D',join(root,'db'),'-l',join(root,'pg.log'),'-o',`-k ${join(root,'s')} -c listen_addresses='' -c cluster_name=sim_completed_replay_fixture_v1`,'-w','start']);started=true;
 const admin=pool('postgres');
 const identity=(await admin.query("SELECT current_setting('cluster_name') n,current_setting('data_directory') d,current_setting('listen_addresses') l")).rows[0];
 assert.deepEqual(identity,{n:'sim_completed_replay_fixture_v1',d:join(root,'db'),l:''});
 check(completedReplayEnabled(undefined)===false,'replay disabled by default');
 check(completedReplayEnabled(COMPLETED_REPLAY_MODE)===true,'exact opt-in');
 assert.throws(()=>completedReplayEnabled('true'),/INVALID_COMPLETED_REPLAY_MODE/);checks++;
 await admin.query('CREATE ROLE ai_router_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;CREATE ROLE driver_measurements_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
 for(const lane of ['ai','driver']){
  const database=lane==='ai'?'sim_ai_router':'sim_driver_measurements',restored=database+'_restored',role=lane==='ai'?'ai_router_runtime':'driver_measurements_runtime';
  await admin.query(`CREATE DATABASE ${database}`);const owner=pool(database);
  for(const path of lane==='ai'?['deploy/ai-router/001_schema.sql','deploy/ai-router/002_separate_billing.sql']:['deploy/driver-measurements/schema.sql'])await sql(owner,path);
  await sql(owner,'deploy/clean-lifecycle/001_clean_lifecycle.sql');
  const expected={lane,mode:'isolated-clean-lifecycle-v1',environmentId:randomUUID(),resetEpoch:randomUUID(),tokensNotBefore:0};
  await owner.query("INSERT INTO sim_clean.config VALUES(true,'cop-sim-user-lifecycle-v1','isolated-clean-lifecycle-v1',$1,$2,$3,0)",[expected.environmentId,expected.resetEpoch,lane]);
  await sql(owner,lane==='ai'?'deploy/clean-lifecycle/005_ai_writer_fences.sql':'deploy/clean-lifecycle/006_driver_writer_fences.sql');
  if(lane==='ai')await sql(owner,'deploy/clean-lifecycle/002_ai_budget_views.sql');
  await sql(owner,lane==='ai'?'deploy/clean-lifecycle/003_ai_runtime_grants.sql':'deploy/clean-lifecycle/004_driver_runtime_grants.sql');
  await owner.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  if(lane==='ai'){
   // Actual finite RLS setup on a fresh fixture, no historical guard removal.
   for(const table of ['ai_router_request','ai_router_billing_request','ai_router_user_key_audit']){
    await owner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;CREATE POLICY fixture_read ON ${table} FOR SELECT TO ai_router_runtime USING(true);CREATE POLICY fixture_insert ON ${table} FOR INSERT TO ai_router_runtime WITH CHECK(true);CREATE POLICY fixture_update ON ${table} FOR UPDATE TO ai_router_runtime USING(true) WITH CHECK(true)`);
    const column=table==='ai_router_billing_request'?'actor_hash':'user_hash';
    await owner.query(`CREATE POLICY fixture_pending_delete ON ${table} FOR DELETE TO ai_router_runtime USING(EXISTS(SELECT 1 FROM sim_clean.resource r JOIN sim_clean.account a USING(owner_key) WHERE r.resource_hash=${column} AND a.state='deletion_pending'))`);
   }
   await sql(owner,'deploy/clean-lifecycle/009_completed_content_replay.sql');
  }
  const runtime=pool(database,role),service=new CleanLifecycle(runtime,expected),a=h('ownerA'),b=h('ownerB'),ha=h('resourceA'),hb=h('resourceB');
  await service.reserve(a,[ha]);await service.reserve(b,[hb]);
  for(const hash of [ha,hb])if(lane==='ai'){
   await runtime.query("INSERT INTO ai_router_request(id,client_id,user_hash,task_type,model,routing_reason,difficulty,status,reserved_microusd,charged_microusd,input_tokens,output_tokens) VALUES($1,'cop',$2,'cop_chat','fixture','fixture','simple','success',10,7,2,3)",[randomUUID(),hash]);
   await runtime.query("INSERT INTO ai_router_billing_request(id,billing_source,payer_hash,actor_hash,credential_fingerprint,task_type,model,status,reserved_microusd,estimated_microusd) VALUES($1,'user_openai_key',$2,$2,'synthetic','cop_chat','fixture','success',5,3)",[randomUUID(),hash]);
   await runtime.query("INSERT INTO ai_router_user_key(user_hash,ciphertext,nonce,auth_tag,fingerprint) VALUES($1,'\\x01','\\x02','\\x03','synthetic')",[hash]);
   await runtime.query("INSERT INTO ai_router_user_key_audit(user_hash,action,fingerprint) VALUES($1,'created','synthetic')",[hash]);
  }else{
   const batch=randomUUID();
   await runtime.query("INSERT INTO driver_measurement_receipts VALUES('cop',$1,$2,$3,now(),now()+interval '7 days','{}')",[batch,hash,h('batch')]);
   await runtime.query("INSERT INTO driver_measurement_intervals VALUES('cop',$1,$2,'fixture-graph','1',now(),30,50,6)",[batch,h(hash)]);
   await runtime.query("INSERT INTO driver_measurement_eta VALUES('cop',$1,$2,$3,'fixture-graph',now(),60,70)",[batch,randomUUID(),hash]);
  }
  let actualHistory,historySettings,historyOp,historyAt,simHashA,simHashB;
  if(lane==='ai'){
   await sql(owner,'deploy/sim-user-data/002_ai_history.sql');
   await sql(owner,'deploy/sim-user-data/006_completed_content_replay.sql');
   historySettings={mode:'isolated-sim-user-data-v1',environmentId:expected.environmentId,resetEpoch:expected.resetEpoch,tokensNotBefore:Math.floor(Date.now()/1000)-120,secret:'synthetic-history-actor-secret'.repeat(3)};
   await owner.query("INSERT INTO sim_user_history.config VALUES(true,'cop-sim-user-data-v1',$1,$2,$3,$4)",[historySettings.mode,expected.environmentId,expected.resetEpoch,historySettings.tokensNotBefore]);
   actualHistory=await historyFor(database,historySettings);
   for(const canonical of [a,b]){
    const sim=actualHistory.store.hashUser('sim',simOwnerAlias(canonical)),izs=actualHistory.store.hashUser('izs',simOwnerAlias(canonical));
    await actualHistory.history.ledger.withOwner(canonical,async c=>{
     await c.query("INSERT INTO sim_user_history.resource VALUES($1,$2,'sim'),($3,$2,'izs')",[sim,canonical,izs]);
     await c.query("INSERT INTO ai_router_request(id,client_id,user_hash,task_type,model,routing_reason,difficulty,status,reserved_microusd,charged_microusd,input_tokens,output_tokens) VALUES($1,'sim',$2,'sim_scenario','fixture','fixture','simple','success',5,3,2,1)",[randomUUID(),sim]);
     await c.query("INSERT INTO ai_router_billing_request(id,billing_source,payer_hash,actor_hash,credential_fingerprint,task_type,model,status,reserved_microusd,estimated_microusd) VALUES($1,'sim_project','sim_izs_project',$2,'synthetic','sim_izs_summary','fixture','success',5,2)",[randomUUID(),izs]);
    });
    if(canonical===a)simHashA=sim;else simHashB=sim;
   }
  }
  const dump=join(root,lane+'.dump');await pg('pg_dump',['-h',join(root,'s'),'-p','5432','-U','fixture_owner','-Fc','-f',dump,database]);
  const op=randomUUID(),at=new Date().toISOString();
  await service.request(a,op,at);check((await service.runOne()).state==='deleted','actual first cleanup');
  if(actualHistory){
   historyOp=randomUUID();historyAt=new Date().toISOString();
   await actualHistory.history.ledger.request(a,historyOp,historyAt,Math.floor(Date.now()/1000));
   await actualHistory.history.tick();
   check((await actualHistory.history.ledger.status(a,historyOp)).state==='deleted','actual first history cleanup');
   await actualHistory.history.close();
  }
  const control={};
  for(const t of ['config','production_enrollment','account','resource','job','cost_daily'])control['sim_clean.'+t]=(await owner.query(`SELECT to_jsonb(x) row FROM sim_clean.${t} x ORDER BY to_jsonb(x)::text`)).rows.map(x=>x.row);
  if(actualHistory)for(const t of ['config','account','resource','job','cost_daily'])control['sim_user_history.'+t]=(await owner.query(`SELECT to_jsonb(x) row FROM sim_user_history.${t} x ORDER BY to_jsonb(x)::text`)).rows.map(x=>x.row);
  const originalJob=JSON.stringify(control['sim_clean.job']),totals=JSON.stringify(control['sim_clean.cost_daily']);
  await admin.query(`CREATE DATABASE ${restored}`);
  const args=['-h',join(root,'s'),'-p','5432','-U','fixture_owner','-d',restored];
  await pg('pg_restore',[...args,'--exit-on-error','--section=pre-data',dump]);
  const toc=(await pg('pg_restore',['-l',dump])).stdout;
  const dataList=toc.split('\n').filter(line=>!line.includes(' TABLE DATA sim_clean ')&&!line.includes(' TABLE DATA sim_user_history ')).join('\n');
  const list=join(root,lane+'-data.list');await writeFile(list,dataList,{mode:0o600});
  await pg('pg_restore',[...args,'--exit-on-error','--section=data','-L',list,dump]);
  const restoredOwner=pool(restored);
  // A standard restore orders data before post-data triggers. Restore the REAL
  // current target journal here; never disable any installed fence or trigger.
  for(const [table,rows] of Object.entries(control))for(const row of rows)await restoredOwner.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},$1::jsonb)`,[JSON.stringify(row)]);
  await pg('pg_restore',[...args,'--exit-on-error','--section=post-data',dump]);
  const rr=pool(restored,role),replay=new CleanLifecycle(rr,expected);
  const countSql=lane==='ai'?"SELECT count(*) n FROM ai_router_request WHERE client_id='cop' AND user_hash=$1":"SELECT count(*) n FROM driver_measurement_receipts WHERE contributor_hash=$1";
  const restoredRows=Number((await rr.query(countSql,[ha])).rows[0].n);check(restoredRows>0,'actual nonzero restored content');
  const bSql=lane==='ai'?"SELECT jsonb_agg(to_jsonb(x) ORDER BY id) data FROM ai_router_request x WHERE user_hash=$1":"SELECT jsonb_agg(to_jsonb(x) ORDER BY batch_id) data FROM driver_measurement_receipts x WHERE contributor_hash=$1";
  const bBefore=JSON.stringify((await rr.query(bSql,[hb])).rows);
  await assert.rejects(replay.status(a,op),/CLEAN_READBACK_FAILED/);checks++;
  await assert.rejects(replay.request(a,op,at),/CLEAN_READBACK_FAILED/);checks++;
  check((await replay.runOne()).state==='idle','default worker does not silently opt in');
  check((await replay.runOne({includeCompleted:true})).completedContentReplay===true,'actual terminal cleanup replay');
  check(Number((await rr.query(countSql,[ha])).rows[0].n)===0,'actual restored A removed');
  check(JSON.stringify((await rr.query(bSql,[hb])).rows)===bBefore,'B row bytes preserved');
  check((await replay.status(a,op)).state==='deleted','fresh zero readback');
  check(JSON.stringify((await restoredOwner.query('SELECT to_jsonb(x) row FROM sim_clean.job x ORDER BY to_jsonb(x)::text')).rows.map(x=>x.row))===originalJob,'immutable original operation retained');
  check(JSON.stringify((await restoredOwner.query('SELECT to_jsonb(x) row FROM sim_clean.cost_daily x ORDER BY to_jsonb(x)::text')).rows.map(x=>x.row))===totals,'finance not counted twice');
  await replay.runOne({includeCompleted:true});
  check(JSON.stringify((await restoredOwner.query('SELECT to_jsonb(x) row FROM sim_clean.cost_daily x ORDER BY to_jsonb(x)::text')).rows.map(x=>x.row))===totals,'second replay idempotent');
  await assert.rejects(replay.reserve(a,[ha]),/CLEAN_ACCOUNT_FENCED/);checks++;
  await assert.rejects(new CleanLifecycle(rr,{...expected,resetEpoch:randomUUID()}).runOne({includeCompleted:true}),/CLEAN_CONFIG_MISMATCH/);checks++;
  await assert.rejects(rr.query("UPDATE sim_clean.account SET state='active' WHERE owner_key=$1",[a]),/IMMUTABLE_LIFECYCLE/);checks++;
  await assert.rejects(rr.query('CREATE TABLE public.forbidden(id int)'));checks++;
  if(actualHistory){
   const h=await historyFor(restored,historySettings);
   const historyRows=Number((await rr.query("SELECT count(*) n FROM ai_router_request WHERE client_id='sim' AND user_hash=$1",[simHashA])).rows[0].n);check(historyRows>0,'actual nonzero history restored rows');
   const historyB=JSON.stringify((await rr.query("SELECT to_jsonb(x) row FROM ai_router_request x WHERE user_hash=$1",[simHashB])).rows);
   const historyJob=JSON.stringify(control['sim_user_history.job']),historyTotals=JSON.stringify(control['sim_user_history.cost_daily']);
   const express=createRequire(join(source,'apps/ai-router-api/package.json'))('express'),app=express();app.use(express.json());h.history.register(app);
   const server=createServer(app);servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));
   const headers={authorization:'Bearer '+'synthetic-sim-service-token'.repeat(3),...signSimOwner(historySettings.secret,{ownerKey:a,resetEpoch:expected.resetEpoch,oidcIat:Math.floor(Date.now()/1000),operationId:historyOp,requestedAt:historyAt})};
   const status=async()=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/v1/ai-router/internal/sim-user-history/v1/deletions/'+historyOp,{headers,signal:AbortSignal.timeout(3000)});return {status:r.status,body:await r.json()}};
   check((await status()).status===503,'actual history HTTP refuses old completion with restored rows');
   await h.history.tick();
   const fresh=await status();check(fresh.status===200&&fresh.body.state==='deleted'&&fresh.body.remainingRecords===0,'actual compiled history cleanup and fresh zero HTTP receipt');
   check(JSON.stringify((await rr.query("SELECT to_jsonb(x) row FROM ai_router_request x WHERE user_hash=$1",[simHashB])).rows)===historyB,'history B bytes preserved');
   check(JSON.stringify((await restoredOwner.query('SELECT to_jsonb(x) row FROM sim_user_history.job x ORDER BY to_jsonb(x)::text')).rows.map(x=>x.row))===historyJob,'history original job unchanged');
   check(JSON.stringify((await restoredOwner.query('SELECT to_jsonb(x) row FROM sim_user_history.cost_daily x ORDER BY to_jsonb(x)::text')).rows.map(x=>x.row))===historyTotals,'history finance not counted twice');
   await h.history.tick();
   check(JSON.stringify((await restoredOwner.query('SELECT to_jsonb(x) row FROM sim_user_history.cost_daily x ORDER BY to_jsonb(x)::text')).rows.map(x=>x.row))===historyTotals,'history second replay idempotent');
   evidence.push({lane:'sim_history',restoredRows:historyRows,actualPgDumpRestore:true,actualCompiledCleanup:true,freshHttpZero:true,bPreserved:true,financialTotalsUnchanged:true});
  }
  evidence.push({lane,restoredRows,actualPgDumpRestore:true,actualRepeatedCleanup:true,bPreserved:true,originalJobPreserved:true,financialTotalsUnchanged:true});
 }
 passed=true;console.log(JSON.stringify({contractVersion:COMPLETED_REPLAY_MODE,checks,evidence,actualIndependentGuardRestore:false,actualWhole12Acceptance:false,productionWrites:0,providerCalls:0}));
}finally{
 for(const s of servers)await new Promise(r=>s.close(r));
 for(const h of histories)await h.close().catch(()=>{});
 for(const s of stores)await s.close().catch(()=>{});
 for(const p of pools)if(!p.ended&&!p.ending)await p.end().catch(()=>{});
 if(started)await pg('pg_ctl',['-D',join(root,'db'),'-m','fast','-w','stop']);
 if(passed)await rm(root,{recursive:true});
 if(originalHistoryReplay===undefined)delete process.env.SIM_USER_HISTORY_COMPLETED_REPLAY_MODE;else process.env.SIM_USER_HISTORY_COMPLETED_REPLAY_MODE=originalHistoryReplay;
}
