/** Exact synthetic accepted-A restore only. No network/admin endpoint or prod target. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import{createRequire}from'node:module';
import{createInterface}from'node:readline';
import{canonicalOwnerKey}from'/app/packages/sim-user-data/claims.mjs';
import{catalog}from'/fixture-clean/scripts/lib/clean-reset-ops.mjs';
import{userDataCatalog}from'/fixture-clean/scripts/lib/sim-user-data-profile.mjs';
const ROOT='/private/tmp/sim-user-install-pg-9aff26e65b74',DIR='/dev/shm/cop-clean-whole',OP='b6fe7a68-d7a2-49e0-a9da-6dd7bcb01a4e',EPOCH='7f970a87-f36b-4e7f-8226-8c9107c8d3e4';
const need=v=>assert.ok(v,'OWNED_ACCEPTED_RESTORE_REFUSED');
const hash=b=>createHash('sha256').update(b).digest('hex');
const cfg=JSON.parse(await fs.readFile(DIR+'/sim-private.json','utf8'));
const bytes=await fs.readFile(DIR+'/sim-content-snapshot.json');need(hash(bytes)==='7655aa9d17385db7bab15236e281dc463d54bbca636c2a441eff3993f0c5f087');
const snap=JSON.parse(bytes);need(cfg.input.base.resetEpoch===EPOCH&&snap.resetEpoch===EPOCH&&process.getuid()===1000);
const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
need(hash(JSON.stringify(stable(cfg)))===snap.privateBindingDigest);
const{Pool}=createRequire('/runtime/router/apps/ai-router-api/package.json')('pg');
const ps=[];const pool=db=>{const p=new Pool({host:ROOT+'/s',port:5000,user:'fixture_admin',database:db,max:1,idleTimeoutMillis:0,connectionTimeoutMillis:2000,statement_timeout:10000});p.on('error',()=>{});ps.push(p);return p};
const dbs=['sim_ai_router','sim_driver_measurements','sim_user_data'];
const content={sim_ai_router:{},sim_driver_measurements:snap.scopes.sim_measurements.a.tables,sim_user_data:{}};
for(const group of ['ai_router','sim_user_data'])for(const[t,rows]of Object.entries(snap.scopes[group].a.tables))content.sim_ai_router[t]=[...(content.sim_ai_router[t]??[]),...rows];
const owner=n=>canonicalOwnerKey(cfg.input.userDataEnvironment.ownerSecret,{issuer:cfg.input.base.issuer,subject:cfg.input.base.actors[n].subjectId});
async function facts(excludeA=false){const out={};for(const db of dbs){const p=pool(db);const id=(await p.query("SELECT current_user u,current_setting('cluster_name') n,current_setting('data_directory') d")).rows[0];need(id.u==='fixture_admin'&&id.n==='sim_whole12_tls_fixture_v1'&&id.d===ROOT+'/db');const rows={};const tables=(await p.query("SELECT n.nspname schema,c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','sim_clean','sim_user_data','sim_user_history') AND c.relkind='r' ORDER BY 1,2")).rows;for(const t of tables){need(/^[a-z0-9_]+$/.test(t.schema)&&/^[a-z0-9_]+$/.test(t.name));const name=t.schema+'.'+t.name;const excluded=excludeA&&t.schema==='public'?(content[db][t.name]??[]):[];rows[name]=(await p.query(`SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text,'null'),'UTF8')),'hex') h FROM ${name} r WHERE NOT(to_jsonb(r)=ANY($1::jsonb[]))`,[excluded.map(x=>JSON.stringify(x))])).rows[0].h;}const cats=db==='sim_ai_router'?await userDataCatalog(p,'sim_user_history'):db==='sim_user_data'?await userDataCatalog(p,'sim_user_data'):await catalog(p,'driver');out[db]={rows,catalog:cats.digest};await p.end();}return out;}
async function bFiles(){const dir=ROOT+'/data/main/sim-user-data-v1/'+EPOCH+'/'+owner('b');const out={};for(const n of (await fs.readdir(dir)).sort()){const s=await fs.lstat(dir+'/'+n);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1);out[n]=hash(await fs.readFile(dir+'/'+n));}return out;}
async function guardHash(p){return (await p.query("SELECT encode(sha256(convert_to(jsonb_build_object('checkpoint',(SELECT jsonb_agg(to_jsonb(r) ORDER BY component) FROM sim_erasure_guard_v2.user_data_checkpoint r),'tombstones',(SELECT jsonb_agg(to_jsonb(r) ORDER BY component,owner_key) FROM sim_erasure_guard_v2.user_data_tombstone r))::text,'UTF8')),'hex') h")).rows[0].h;}
let guard,held=[];
try{
const mode=process.argv[2];need(process.argv.length===3&&['--hold-and-verify','--resume-held-restore','--inject-ai','--inject-driver','--verify-final'].includes(mode));
if(mode.startsWith('--inject-')){const db=mode==='--inject-ai'?'sim_ai_router':'sim_driver_measurements',p=pool(db);for(const[t,rows]of Object.entries(content[db])){need(/^[a-z_]+$/.test(t));need(Number((await p.query("SELECT count(*) n FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal",['public.'+t])).rows[0].n)===0);for(const row of rows)await p.query(`INSERT INTO public.${t}${t==='ai_router_user_key_audit'?' OVERRIDING SYSTEM VALUE':''} SELECT * FROM jsonb_populate_record(NULL::public.${t},$1::jsonb)`,[JSON.stringify(row)]);}console.log(JSON.stringify({injectedDatabase:db,rows:Object.values(content[db]).reduce((n,x)=>n+x.length,0)}));}
else if(mode==='--hold-and-verify'||mode==='--resume-held-restore'){
guard=pool('cop_account_safety_guard');
for(const component of ['sim_user_data','sim_user_history']){const lock=createHash('sha256').update('sim-user-continuity-v1\0'+component).digest().readInt32BE(0);await guard.query('SELECT pg_advisory_lock(781425,$1)',[lock]);held.push(lock);const r=(await guard.query('SELECT * FROM sim_erasure_guard_v2.user_data_checkpoint WHERE component=$1',[component])).rows[0];need(r?.state===(mode==='--resume-held-restore'?'quarantined':'ready'));for(const[k,v]of Object.entries(cfg.bindings[component]))need(String(r[k])===String(v));}
let originalGuard,before,filesB;
if(mode==='--resume-held-restore')({originalGuard,before,filesB}=JSON.parse(await fs.readFile(DIR+'/accepted-restore-before-private.json')));
else{
originalGuard=await guardHash(guard);before=await facts();filesB=await bFiles();
for(const [db,schema]of[['sim_ai_router','sim_clean'],['sim_driver_measurements','sim_clean'],['sim_user_data','sim_user_data'],['sim_ai_router','sim_user_history']]){const p=pool(db);const j=(await p.query(`SELECT j.operation_id,a.state,a.reset_epoch FROM ${schema}.job j JOIN ${schema}.account a USING(owner_key)`)).rows;need(j.length===1&&j[0].operation_id===OP&&j[0].state==='deleted'&&j[0].reset_epoch===EPOCH);await p.end();}
await fs.writeFile(DIR+'/accepted-restore-before-private.json',JSON.stringify({before,filesB,originalGuard}),{mode:0o600,flag:'wx'});
await guard.query("UPDATE sim_erasure_guard_v2.user_data_checkpoint SET state='quarantined' WHERE component IN('sim_user_data','sim_user_history')");
}
console.log(JSON.stringify({held:true,quarantined:true,guardBeforeSha256:originalGuard}));
const lines=createInterface({input:process.stdin});const next=await lines[Symbol.asyncIterator]().next();need(!next.done&&JSON.parse(next.value).targetsRestored===true);lines.close();
assert.deepEqual(await facts(true),before);assert.deepEqual(await bFiles(),filesB);
let restoredRows=0;for(const db of dbs){const p=pool(db);for(const[t,rows]of Object.entries(content[db])){const n=Number((await p.query(`SELECT count(*) n FROM public.${t} r WHERE to_jsonb(r)=ANY($1::jsonb[])`,[rows.map(x=>JSON.stringify(x))])).rows[0].n);need(n===rows.length);restoredRows+=n;}await p.end();}need(restoredRows===9);
const dir=ROOT+'/data/main/sim-user-data-v1/'+EPOCH+'/'+owner('a');await fs.mkdir(dir,{mode:0o700});
for(const[n,f]of Object.entries(snap.scopes.sim_user_data.a.files)){need(['.owner-scope.json','sim-store.json','publisher-queue.json','sim-audit.jsonl'].includes(n));const b=Buffer.from(f.bytes,'base64');need(hash(b)===f.sha256);await fs.writeFile(dir+'/'+n,b,{mode:f.mode,flag:'wx'});}
need((await fs.readdir(dir)).length===4);
await guard.query('BEGIN');try{await guard.query("UPDATE sim_erasure_guard_v2.user_data_checkpoint SET state='ready' WHERE component IN('sim_user_data','sim_user_history')");need(await guardHash(guard)===originalGuard);await guard.query('COMMIT');}catch(e){await guard.query('ROLLBACK');throw e;}
console.log(JSON.stringify({actualRestoredRows:restoredRows,actualRestoredMainFiles:4,nonAControlAndFinancePreserved:true,bFilesPreserved:true,guardAfterSha256:originalGuard,temporaryQuarantineReleased:true,productionTouched:false,wholeAccountComplete:false}));
}else{const b=JSON.parse(await fs.readFile(DIR+'/accepted-restore-before-private.json'));assert.deepEqual(await facts(),b.before);assert.deepEqual(await bFiles(),b.filesB);guard=pool('cop_account_safety_guard');need(await guardHash(guard)===b.originalGuard);console.log(JSON.stringify({actualAllADataAgainAbsent:true,allOtherRowsControlFinanceAndBPreserved:true,independentGuardPreserved:true,wholeAccountComplete:false}));}
}catch(e){console.error(JSON.stringify({error:'OWNED_ACCEPTED_RESTORE_FAILED',code:/^[A-Z0-9_]{1,64}$/.test(e.code??'')?e.code:undefined,locations:[...String(e.stack).matchAll(/(owned-accepted-sim-restore.mjs:\d+:\d+)/g)].map(x=>x[1]),quarantineMustRemainUntilVerified:true,wholeAccountComplete:false}));process.exitCode=1;}
finally{if(guard&&!guard.ended){for(const lock of held)await guard.query('SELECT pg_advisory_unlock(781425,$1)',[lock]).catch(()=>{});}for(const p of ps)if(!p.ended&&!p.ending)await p.end().catch(()=>{});}
