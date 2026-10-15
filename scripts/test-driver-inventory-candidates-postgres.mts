/** SOURCE ONLY: actual SQL006 in a NEW owned PostgreSQL 18.3 Unix-only cluster.
 * Main alone runs this after full source review. No production DB/credential,
 * TCP listener, provider, Root authority, owner enrollment or account deletion.
 * Frozen earlier SQL harness/receipt are pinned, never rerun or overwritten. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {existsSync,realpathSync,statSync} from 'node:fs';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

assert.deepEqual(process.argv.slice(2),['--run']);
assert.equal(typeof process.getuid,'function');assert.notEqual(process.getuid!(),0,'initdb must run as the unprivileged test owner.');
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),selfPath=fileURLToPath(import.meta.url);
const hash=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
const selfPin=hash(await readFile(selfPath));
const receiptPath=join(repo,'docs/archive/2026-10-15_DRIVER_INVENTORY_CANDIDATES_SQL.json');
assert.ok(!existsSync(receiptPath),'Existing evidence must not be overwritten.');
const pins:Record<string,string>={
  'deploy/driver-measurements/schema.sql':'6dd60a3acf28d63575198c8526c368df19bbd543f4063d4985fb55f308da02d0',
  'deploy/driver-measurements/002_account_erasure.sql':'f13db2106a1fe1a02d0d1a26afa8ad7d7c045172ba4419749719ed0f166e16ad',
  'deploy/driver-measurements/003_guarded_operations.sql':'e3513a983a3b6d1bd52d46851c734dd1c3b208e2e2f6430a6f9eddd38b10d3b5',
  'deploy/driver-measurements/004_read_admission_facts.sql':'791545b9df91e65bb555c68a44dadd73a847ca64fde0c31a9036f9f555ba1d2d',
  'deploy/driver-measurements/006_inventory_candidates.sql':'bd69ca4e58746c852b49bf0ad1f59465a64fc781a59c4c9fe88073199080efe0'
};
const frozenPins:Record<string,string>={
  'scripts/test-driver-read-admission-postgres.mts':'a84618b475c1f3707941e2290982a6069a4888461eea3f0a10fc5e6305e98e5f',
  'docs/archive/2026-10-15_DRIVER_READ_ADMISSION_SQL.json':'656e141ca0469693917e7268000a390952326647ffc6f475666d26b5a7f9b755'
};
const source:Record<string,string>={};
for(const [path,pin] of Object.entries({...pins,...frozenPins})){
  const bytes=await readFile(join(repo,path));assert.equal(hash(bytes),pin,'Reviewed/frozen input changed: '+path);source[path]=bytes.toString('utf8');
}
const execute=promisify(execFile),pgBin='/opt/homebrew/opt/postgresql@18/bin';
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR'].includes(key)));
for(const key of Object.keys(process.env))if(/^PG|DATABASE_URL$|OPENAI|API_KEY|SECRET|TOKEN/u.test(key))delete process.env[key];
assert.match((await execute(join(pgBin,'postgres'),['--version'],{env})).stdout,/^postgres \(PostgreSQL\) 18\.3(?:\s|$)/u);
const {Pool}=createRequire(join(repo,'apps/situation-data-api/package.json'))('pg');
const tmp=realpathSync('/private/tmp');assert.equal(tmp,'/private/tmp');
const oldUmask=process.umask(0o077),root=await mkdtemp(join(tmp,'sim-driver-inventory-pg-'));
await chmod(root,0o700);await mkdir(join(root,'socket'),{mode:0o700});
const owned=()=>{
  assert.equal(dirname(realpathSync(root)),tmp);assert.ok(realpathSync(root).startsWith(join(tmp,'sim-driver-inventory-pg-')));
  for(const path of [root,join(root,'socket')]){assert.equal(statSync(path).uid,process.getuid!());assert.equal(statSync(path).mode&0o777,0o700);}
};
owned();
const pools:any[]=[],clients=new Set<any>();
const pool=(user:string,database='sim_driver_measurements')=>{
  const result=new Pool({host:join(root,'socket'),port:5432,database,user,password:'',ssl:false,options:'',max:3,
    connectionTimeoutMillis:2000,statement_timeout:5000,application_name:'sim-driver-inventory-source-test'});
  result.on('error',()=>{});pools.push(result);return result;
};
const acquire=async(p:any)=>{const c=await p.connect();clients.add(c);return c;};
const release=async(c:any)=>{await c.query('ROLLBACK').catch(()=>undefined);c.release();clients.delete(c);};
const value=async(p:any,sql:string,args:unknown[]=[])=> (await p.query(sql,args)).rows[0].value;
const denied=async(work:()=>Promise<unknown>,code:string)=>{
  try{await work();assert.fail('Expected fixed SQL rejection.');}catch(error:any){if(error.code==='ERR_ASSERTION')throw error;assert.equal(error.code,code);}
};
let admin:any,control:any,runtime:any,executor:any,started=false,success=false,cleanupComplete=true,providerCalls=0;
let originalSchema:any,preInstallEffects:any,beforeFingerprint:string,afterFingerprint:string;
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{providerCalls++;throw new Error('Provider/network access is forbidden.');};
const store='00000000-0000-4000-8000-000000000061';
const H=Object.freeze(Object.fromEntries(['zero','expired','etaParent','etaOnly','temporary','temporaryExpired','permanent','overlap','otherStored','absent','ledgerOnly','actor','request'].map(name=>[name,hash('synthetic inventory '+name)]))) as Record<string,string>;
const privateCanary='synthetic-private-receipt-not-an-inventory-output';
const events:Array<{case:string;passed:boolean}>=[],startedAt=new Date().toISOString();
const readOn=(c:any,body:unknown)=>value(c,'SELECT sim_driver_guard_source.read_inventory_candidates($1::jsonb) AS value',[JSON.stringify(body)]);
const read=async(body:unknown,p:any=control)=>{const c=await acquire(p);try{await c.query('BEGIN READ ONLY');return await readOn(c,body);}finally{await release(c);}};
const facts=async()=>{const c=await acquire(control);try{await c.query('BEGIN READ ONLY');return await value(c,'SELECT sim_driver_guard_source.read_admission_facts($1::jsonb) AS value',
  [JSON.stringify({owner:'sim_driver_measurements',scope:'online_driver_scope',purpose:'capability'})]);}finally{await release(c);}};
const assertResult=(result:any,candidates:string[],matched:string[])=>{
  assert.deepEqual(Object.keys(result).sort(),['contractVersion','observedAtUTC','storeIncarnation','candidateCount','matchedHashes'].sort());
  assert.equal(result.contractVersion,'sim-driver-inventory-candidates-v1');assert.equal(result.storeIncarnation,store);
  assert.equal(result.candidateCount,candidates.length);assert.deepEqual(result.matchedHashes,[...matched].sort());
  assert.equal(new Date(result.observedAtUTC).toISOString(),result.observedAtUTC);assert.match(result.observedAtUTC,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.equal(new Set(result.matchedHashes).size,result.matchedHashes.length);
  for(const matchedHash of result.matchedHashes)assert.ok(candidates.includes(matchedHash));
  assert.equal(JSON.stringify(result).includes(privateCanary),false);
};
const schema=()=>value(admin,`SELECT jsonb_build_object(
  'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
    'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull) ORDER BY a.attnum)
      FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)) ORDER BY c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'driver_%' AND c.relkind='r'),
  'guard',pg_get_functiondef('public.driver_account_erasure_receipt_guard()'::regprocedure),
  'trigger',(SELECT pg_get_triggerdef(oid)||':'||tgenabled::text FROM pg_trigger WHERE tgname='driver_account_erasure_receipt_guard' AND NOT tgisinternal),
  'constraints',(SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY conrelid::regclass::text,conname) FROM pg_constraint WHERE connamespace='public'::regnamespace)) AS value`);
const effects=()=>value(admin,`SELECT jsonb_build_object(
 'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,batch_id),'[]') FROM driver_measurement_receipts t),
 'intervals',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,measurement_key),'[]') FROM driver_measurement_intervals t),
 'eta',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,batch_id),'[]') FROM driver_measurement_eta t),
 'temporary',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,contributor_hash),'[]') FROM driver_measurement_revocations t),
 'state',(SELECT to_jsonb(t) FROM driver_account_erasure_state t WHERE singleton),
 'ledger',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY operation_hash),'[]') FROM driver_account_erasure_operations t),
 'permanent',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,contributor_hash),'[]') FROM driver_account_erasure_revocations t),
 'origins',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY operation_id),'[]') FROM sim_driver_guard_source.origins t),
 'store',(SELECT to_jsonb(t) FROM sim_driver_guard_source.store_binding t WHERE singleton)) AS value`);
const seed=async()=>{
  await admin.query('TRUNCATE driver_measurement_receipts,driver_measurement_intervals,driver_measurement_eta,driver_measurement_revocations,driver_account_erasure_operations,driver_account_erasure_revocations');
  for(const [index,name] of ['zero','expired','etaParent','overlap','otherStored'].entries())await admin.query(`INSERT INTO driver_measurement_receipts
    (owner,batch_id,contributor_hash,request_hash,received_at,expires_at,receipt) VALUES('cop',$1,$2,$3,now()-interval '2 days',
      CASE WHEN $4 THEN now()-interval '1 day' ELSE now()+interval '1 day' END,$5::jsonb)`,
    [`30000000-0000-4000-8000-00000000006${index}`,H[name],H.request,name==='expired',JSON.stringify({acceptedIntervalCount:name==='expired'?1:0,privateCanary})]);
  await admin.query(`INSERT INTO driver_measurement_intervals(owner,batch_id,measurement_key,dataset,edge_id,window_start,speed_kph,distance_m,elapsed_seconds)
    VALUES('cop','30000000-0000-4000-8000-000000000061',$1,'synthetic-graph','8',now(),36,50,5)`,[hash('synthetic interval key')]);
  await admin.query(`INSERT INTO driver_measurement_eta(owner,batch_id,observation_id,contributor_hash,dataset,window_start,predicted_seconds,actual_seconds)
    VALUES('cop','30000000-0000-4000-8000-000000000062','40000000-0000-4000-8000-000000000061',$1,'synthetic-graph',now(),100,120)`,[H.etaOnly]);
  for(const name of ['temporary','temporaryExpired','overlap'])await admin.query(`INSERT INTO driver_measurement_revocations VALUES('cop',$1,
    CASE WHEN $2 THEN now()-interval '1 day' ELSE now()+interval '1 day' END)`,[H[name],name==='temporaryExpired']);
  for(const name of ['permanent','overlap'])await admin.query("INSERT INTO driver_account_erasure_revocations(owner,contributor_hash) VALUES('cop',$1)",[H[name]]);
  await admin.query('INSERT INTO driver_account_erasure_operations(operation_hash,actor_hash,request_hash,contributor_count) VALUES($1,$2,$3,9)',[H.ledgerOnly,H.actor,H.request]);
};
const check=async(name:string,work:()=>Promise<void>)=>{
  await seed();try{await work();events.push({case:name,passed:true});console.log('PASS '+name);}catch(error){events.push({case:name,passed:false});throw error;}
  finally{for(const c of [...clients])await release(c);}assert.deepEqual(await schema(),originalSchema);
};
try{
  await execute(join(pgBin,'initdb'),['-D',join(root,'data'),'--username=synthetic_admin','--auth-local=trust','--auth-host=reject','--encoding=UTF8','--locale=C'],{env,timeout:30000});
  await execute(join(pgBin,'pg_ctl'),['-D',join(root,'data'),'-l',join(root,'server.log'),'-o',
    `-k ${join(root,'socket')} -c listen_addresses='' -c unix_socket_permissions=0700 -c timezone=UTC -c log_statement=none -c log_min_error_statement=panic -c max_prepared_transactions=0`,'-w','start'],{env,timeout:15000});started=true;
  const bootstrap=pool('synthetic_admin','postgres');
  const identity=(await bootstrap.query("SELECT current_setting('data_directory') AS directory,current_setting('listen_addresses') AS listen")).rows[0];
  assert.equal(identity.directory,join(root,'data'));assert.equal(identity.listen,'');
  await bootstrap.query(`CREATE ROLE driver_measurements_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE driver_measurements_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_guard_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_guard_control LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_guard_exec LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await bootstrap.query('CREATE DATABASE sim_driver_measurements OWNER driver_measurements_migrator');
  admin=pool('synthetic_admin');control=pool('sim_driver_guard_control');runtime=pool('driver_measurements_runtime');executor=pool('sim_driver_guard_exec');
  await admin.query('SET ROLE driver_measurements_migrator');
  for(const name of ['schema.sql','002_account_erasure.sql'])await admin.query(source['deploy/driver-measurements/'+name]);
  await admin.query('RESET ROLE');originalSchema=await schema();
  await admin.query('CREATE SCHEMA sim_driver_guard_source AUTHORIZATION sim_driver_guard_owner;GRANT sim_driver_guard_exec TO sim_driver_guard_owner');
  for(const name of ['003_guarded_operations.sql','004_read_admission_facts.sql'])await admin.query(source['deploy/driver-measurements/'+name]);
  await admin.query('INSERT INTO sim_driver_guard_source.store_binding VALUES(true,$1)',[store]);
  preInstallEffects=await effects();beforeFingerprint=(await facts()).privileges.fingerprint;
  const rolesBefore=(await admin.query('SELECT count(*)::int AS value FROM pg_roles')).rows[0].value;
  await admin.query(source['deploy/driver-measurements/006_inventory_candidates.sql']);
  assert.equal((await admin.query('SELECT count(*)::int AS value FROM pg_roles')).rows[0].value,rolesBefore);
  assert.deepEqual(await effects(),preInstallEffects);assert.deepEqual(await schema(),originalSchema);
  afterFingerprint=(await facts()).privileges.fingerprint;
  assert.notEqual(afterFingerprint,beforeFingerprint);assert.equal((await facts()).privileges.runtimeProfileMatches,true);
  for(const p of [admin,control,runtime,executor]){const r=(await p.query('SELECT current_database() AS db,inet_server_addr() AS tcp')).rows[0];assert.equal(r.db,'sim_driver_measurements');assert.equal(r.tcp,null);}

  await check('new STABLE control-only function, narrow ETA grant and independent privilege-pin change',async()=>{
    const p=(await admin.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,p.prosrc,pg_get_userbyid(p.proowner) AS owner,
      NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS no_public
      FROM pg_proc p WHERE p.oid='sim_driver_guard_source.read_inventory_candidates(jsonb)'::regprocedure`)).rows[0];
    assert.equal(p.owner,'sim_driver_guard_owner');assert.equal(p.prosecdef,true);assert.equal(p.provolatile,'s');assert.equal(p.no_public,true);
    for(const setting of ['search_path=pg_catalog','timezone=utc','row_security=off'])assert.ok(p.proconfig.map((x:string)=>x.toLowerCase()).includes(setting));
    const code=p.prosrc.replace(/--[^\n]*/gu,'').replace(/'(?:''|[^'])*'/gu,"''");
    assert.doesNotMatch(code,/\b(?:insert|update|delete|truncate|alter|create|drop|call|execute|pg_advisory_[a-z_]+|resolve_or_seal)\b/iu);
    assert.doesNotMatch(code,/\b(?:driver_account_erasure_operations|driver_measurement_intervals|contributor_day|received_at|expires_at|window_start)\b/iu);
    assert.doesNotMatch(code,/contributor_hash\s*::\s*text/iu);assert.match(code,/::char\(64\)/u);
    const columns=(await admin.query(`SELECT a.attname,has_column_privilege('sim_driver_guard_owner',a.attrelid,a.attnum,'SELECT') AS allowed
      FROM pg_attribute a WHERE a.attrelid='driver_measurement_eta'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows;
    assert.deepEqual(columns.filter((x:any)=>x.allowed).map((x:any)=>x.attname).sort(),['contributor_hash','owner']);
    assert.equal(await value(admin,"SELECT has_table_privilege('sim_driver_guard_owner','driver_measurement_eta','SELECT') AS value"),false);
    assert.notEqual(beforeFingerprint,afterFingerprint);
  });
  await check('zero-accepted receipts and expired-but-still-stored receipts are inventory members',async()=>{
    const candidates=[H.expired,H.zero];assertResult(await read(candidates),candidates,candidates);
    assert.equal(await value(admin,"SELECT count(*)::int AS value FROM driver_measurement_intervals WHERE batch_id='30000000-0000-4000-8000-000000000060'"),0);
  });
  await check('ETA-only contributor is included and intervals remain covered by the unchanged receipt FK',async()=>{
    assertResult(await read([H.etaOnly]),[H.etaOnly],[H.etaOnly]);assert.notEqual(H.etaOnly,H.etaParent);
    await denied(()=>admin.query(`INSERT INTO driver_measurement_intervals(owner,batch_id,measurement_key,dataset,edge_id,window_start,speed_kph,distance_m,elapsed_seconds)
      VALUES('cop','ffffffff-ffff-4fff-8fff-ffffffffffff',$1,'synthetic-graph','8',now(),36,50,5)`,[hash('orphan interval')]),'23503');
  });
  await check('current/expired temporary fences and permanent-only fences are included without expiry guessing',async()=>{
    const candidates=[H.permanent,H.temporaryExpired,H.temporary];assertResult(await read(candidates),candidates,candidates);
  });
  await check('only the caller candidate subset is returned; unrelated/ledger/unknown hashes do not leak',async()=>{
    const candidates=[H.absent,H.zero,H.ledgerOnly,H.actor];assertResult(await read(candidates),candidates,[H.zero]);
    assert.ok(!JSON.stringify(await read(candidates)).includes(H.otherStored));
    await denied(()=>admin.query(`INSERT INTO driver_measurement_revocations VALUES('foreign',$1,now())`,[H.absent]),'23514');
  });
  await check('matched hashes are distinct/sorted across source overlap and the 4096-candidate bound is usable',async()=>{
    const candidates=[H.overlap,H.zero,H.permanent];assertResult(await read(candidates),candidates,candidates);
    const maximum=Array.from({length:4096},(_,i)=>i.toString(16).padStart(64,'0'));maximum[4095]=H.zero;
    assert.equal(await value(admin,"SELECT octet_length($1::jsonb::text) AS value",[JSON.stringify(maximum)]),278528);
    assertResult(await read(maximum),maximum,[H.zero]);
  });
  await check('null/duplicate/invalid/oversized candidates reject with 22023, never normalization or truncation',async()=>{
    for(const body of [null,{},'text',[],[null],[4],[{}],[H.zero,H.zero],['A'.repeat(64)],['a'.repeat(63)],['a'.repeat(65)],['z'.repeat(64)],
      Array.from({length:4097},()=>''),['x'.repeat(300000)]])await denied(()=>read(body),'22023');
    const c=await acquire(control);try{await c.query('BEGIN READ ONLY');await denied(()=>c.query('SELECT sim_driver_guard_source.read_inventory_candidates(NULL::jsonb)'),'22023');}finally{await release(c);}
  });
  await check('runtime/executor/PUBLIC access and non-read-only control calls fail closed',async()=>{
    for(const p of [runtime,executor]){await denied(()=>read([H.zero],p),'42501');await denied(()=>p.query('SET ROLE sim_driver_guard_control'),'42501');}
    await denied(()=>readOn(control,[H.zero]),'P0001');
    await denied(()=>control.query('SELECT owner,contributor_hash FROM driver_measurement_eta'),'42501');
    assert.equal(await value(admin,"SELECT has_function_privilege('sim_driver_guard_control','sim_driver_guard_source.read_inventory_candidates(jsonb)','EXECUTE') AS value"),true);
    assert.equal(await value(admin,"SELECT has_function_privilege('driver_measurements_runtime','sim_driver_guard_source.read_inventory_candidates(jsonb)','EXECUTE') AS value"),false);
  });
  await check('actual store binding is returned; missing binding is unavailable and is never adopted',async()=>{
    assert.equal((await read([H.zero])).storeIncarnation,store);
    await admin.query('DELETE FROM sim_driver_guard_source.store_binding');
    try{await denied(()=>read([H.zero]),'P0001');assert.equal(await value(admin,'SELECT count(*)::int AS value FROM sim_driver_guard_source.store_binding'),0);}
    finally{await admin.query('INSERT INTO sim_driver_guard_source.store_binding VALUES(true,$1)',[store]);}
  });
  await check('read-only function leaves every row unchanged and takes no write/advisory/tuple locks or XID',async()=>{
    const before=await effects(),locker=await acquire(admin),reader=await acquire(control);
    try{
      await locker.query('BEGIN');await locker.query("SELECT pg_advisory_xact_lock(hashtextextended('cop:'||$1,0))",[H.zero]);
      await locker.query('SELECT 1 FROM driver_measurement_receipts WHERE contributor_hash=$1 FOR UPDATE',[H.zero]);
      await reader.query('BEGIN READ ONLY');await reader.query("SET LOCAL statement_timeout='1000ms'");assertResult(await readOn(reader,[H.zero,H.etaOnly]),[H.zero,H.etaOnly],[H.zero,H.etaOnly]);
      assert.equal(await value(reader,'SELECT pg_current_xact_id_if_assigned()::text AS value'),null);
      const pid=await value(reader,'SELECT pg_backend_pid() AS value');
      assert.equal(await value(admin,"SELECT count(*)::int AS value FROM pg_locks WHERE pid=$1 AND (locktype IN ('advisory','tuple') OR (locktype='relation' AND mode<>'AccessShareLock'))",[pid]),0);
    }finally{await release(reader);await release(locker);}
    assert.deepEqual(await effects(),before);
  });
  await check('RLS drift is unavailable rather than a false empty inventory',async()=>{
    await admin.query('ALTER TABLE driver_measurement_eta ENABLE ROW LEVEL SECURITY');
    try{await denied(()=>read([H.etaOnly]),'42501');}finally{await admin.query('ALTER TABLE driver_measurement_eta DISABLE ROW LEVEL SECURITY');}
  });
  await check('actual owner/hash index prefixes remain usable with input char64 casts and no new day column',async()=>{
    const c=await acquire(admin);try{await c.query('BEGIN');await c.query('SET LOCAL enable_seqscan=off');
      for(const table of ['driver_measurement_receipts','driver_measurement_eta','driver_measurement_revocations','driver_account_erasure_revocations']){
        const plan=(await c.query(`EXPLAIN (FORMAT JSON) SELECT 1 FROM public.${table} WHERE owner='cop' AND contributor_hash=$1::char(64)`,[H.zero])).rows[0]['QUERY PLAN'];
        const text=JSON.stringify(plan);assert.match(text,/Index(?: Only)? Scan|Bitmap Index Scan/u);assert.match(text,/contributor_hash/u);assert.doesNotMatch(text,/contributor_hash\)::text/u);
      }
    }finally{await release(c);}
    assert.equal(await value(admin,"SELECT count(*)::int AS value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'driver_%' AND a.attname='contributor_day' AND a.attnum>0 AND NOT a.attisdropped"),0);
  });
  assert.equal(events.length,12);assert.equal(providerCalls,0);
  for(const [path,pin] of Object.entries({...pins,...frozenPins}))assert.equal(hash(await readFile(join(repo,path))),pin,'Input changed during run.');
  assert.equal(hash(await readFile(selfPath)),selfPin);success=true;
}finally{
  globalThis.fetch=originalFetch;
  try{
    for(const c of [...clients])await release(c).catch(()=>{cleanupComplete=false;});
    for(const p of pools)await p.end().catch(()=>{cleanupComplete=false;});
    if(started){owned();await execute(join(pgBin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,timeout:15000}).catch(()=>{cleanupComplete=false;});}
  }finally{process.umask(oldUmask);}
  if(success&&cleanupComplete){owned();await rm(root,{recursive:true});}else console.error('Private synthetic inventory fixture retained: '+root);
}
assert.ok(success&&cleanupComplete,'Owned cluster cleanup must succeed before publishing evidence.');
await writeFile(receiptPath,JSON.stringify({status:'SOURCE_DRIVER_INVENTORY_CANDIDATES_SQL_ONLY',startedAt,completedAt:new Date().toISOString(),
  passed:events.length,cases:events,postgres:'18.3',transport:'new_owned_unix_socket_only_no_tcp',sourcePins:pins,frozenPins,
  executingRunnerSha256:selfPin,inputsUnchangedBeforeAndAfter:true,previousEvidenceUnchanged:true,
  privilegeChange:{beforeFingerprint,afterFingerprint,requiresIndependentRootPolicyReview:true,
    grants:['SELECT(owner,contributor_hash) ON driver_measurement_eta TO sim_driver_guard_owner','EXECUTE read_inventory_candidates(jsonb) TO sim_driver_guard_control']},
  actual:{productionChanged:false,rootAuthorityVerified:false,accountCandidateDerivationVerified:false,completeDailyInventoryVerified:false,
    rootEnrollment:false,restoreAccepted:false,deploymentAccepted:false,realAccountDeleted:false,providerCalls},
  cleanup:{ownedClusterStopped:true,ownedDirectoryRemoved:true,globalPrune:false},
  interpretation:'Twelve new actual SQL006 groups. Candidate membership does not determine contributor days, account ownership, complete key history, Root authority or erasure completion.'},null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({receiptPath,passed:events.length,productionChanged:false}));
