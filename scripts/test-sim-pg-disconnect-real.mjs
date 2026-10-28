/** Disposable LOCAL PostgreSQL only. No production env/roles/credentials.
 * --run creates an owned Unix-socket-only PG18 cluster and removes it afterwards.
 * A private Unix protocol proxy deliberately drops COMMIT acknowledgement only.
 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {mkdtemp,chmod,mkdir,rm,realpath,stat} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {createServer,createConnection} from 'node:net';
import {join,dirname} from 'node:path';
import {attachSimPgErrorObservers} from '../packages/sim-user-data/pg-errors.mjs';
import {UserLedger} from '../packages/sim-user-data/ledger.mjs';
import {createSimUserDataAuthority} from '../packages/sim-user-data/authority.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
assert.deepEqual(process.argv.slice(2),['--run']);
const {Client,Pool}=createRequire(new URL('../apps/simulator-api/package.json',import.meta.url))('pg');
const exec=promisify(execFile),bin='/opt/homebrew/opt/postgresql@18/bin';
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['HOME','PATH','USER','LOGNAME','LANG','TMPDIR'].includes(k)));
assert.match((await exec(join(bin,'postgres'),['--version'],{env})).stdout,/PostgreSQL\) 18\./);
const root=await mkdtemp('/private/tmp/sim-pgdisc-');await chmod(root,0o700);
const data=join(root,'data'),socket=join(root,'s');await mkdir(socket,{mode:0o700});
const config={host:socket,port:5432,database:'postgres',user:userInfo().username,ssl:false,connectionTimeoutMillis:2000,statement_timeout:25000};
const records=[],checks=[],pools=[],proxies=[];
let started=false,admin,result;
const check=(name,value)=>{assert(value,name);checks.push(name)};
const until=async(predicate)=>{const end=Date.now()+5000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,15))}throw Error('FIXTURE_TIMEOUT')};
const owned=async()=>{assert.equal(dirname(await realpath(root)),'/private/tmp');const s=await stat(root);assert.equal(s.uid,process.getuid());assert.equal(s.mode&0o777,0o700)};
function pool(lane,extra={}){const p=new Pool({...config,max:2,...extra});attachSimPgErrorObservers(p,lane,r=>records.push(r));pools.push(p);return p}
async function commitLossProxy(){
 const sockets=new Set();let armed=false,dropped=false;
 const host=join(root,'p'+proxies.length);await mkdir(host,{mode:0o700});
 const server=createServer(front=>{
  const back=createConnection({path:join(socket,'.s.PGSQL.5432')});sockets.add(front);sockets.add(back);
  front.on('error',()=>{});back.on('error',()=>{});
  front.on('close',()=>{sockets.delete(front);back.destroy()});back.on('close',()=>{sockets.delete(back);front.destroy()});
  front.pipe(back);
  let pending=Buffer.alloc(0);
  back.on('data',chunk=>{
   pending=Buffer.concat([pending,chunk]);
   while(pending.length>=5){
    const size=pending.readInt32BE(1)+1;assert(size>=5&&size<1024*1024);
    if(pending.length<size)return;
    const frame=pending.subarray(0,size);pending=pending.subarray(size);
    if(armed&&frame[0]===67&&frame.subarray(5).toString()==='COMMIT\0'){
     dropped=true;front.destroy();back.destroy();return;
    }
    front.write(frame);
   }
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(join(host,'.s.PGSQL.5432'),resolve)});
 const proxy={host,arm(){armed=true},dropped:()=>dropped,
  async close(){for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve))}};
 proxies.push(proxy);return proxy;
}
try{
 await owned();await exec(join(bin,'initdb'),['-D',data,'-A','trust','--no-locale'],{env,maxBuffer:1024*1024});
 await exec(join(bin,'pg_ctl'),['-D',data,'-l',join(root,'postgres.log'),'-o',`-k ${socket} -c listen_addresses='' -c cluster_name=sim_pg_disconnect_fixture_v1 -c max_connections=20`,'-w','start'],{env});started=true;
 admin=new Client(config);await admin.connect();
 const identity=(await admin.query("SELECT current_setting('cluster_name') marker,current_setting('listen_addresses') listen")).rows[0];
 check('owned fixture identity and no PostgreSQL TCP listener',identity.marker==='sim_pg_disconnect_fixture_v1'&&identity.listen==='');
 await admin.query(`CREATE SCHEMA sim_user_data;
  CREATE TABLE sim_user_data.config(singleton boolean,contract text,mode text,environment_id text,reset_epoch text,tokens_not_before integer);
  INSERT INTO sim_user_data.config VALUES(true,'cop-sim-user-data-v1','isolated-sim-user-data-v1','fixture-environment','fixture-epoch',1);
  CREATE TABLE fixture_business(id integer PRIMARY KEY)`);
 for(const lane of ['target','guard']){
  const p=pool(lane);
  let c=await p.connect(),pid=c.processID;c.release();
  await admin.query('SELECT pg_terminate_backend($1)',[pid]);await until(()=>p.totalCount===0);
  check(lane+' idle socket evicted; fixed idle event',records.some(r=>r.pool===lane&&r.kind==='idle_client'&&r.sqlstate==='57P01'));
  c=await p.connect();check(lane+' replacement backend after idle loss',c.processID!==pid);
  pid=c.processID;const lost=new Promise(resolve=>c.once('error',resolve));
  await admin.query('SELECT pg_terminate_backend($1)',[pid]);await lost;
  await assert.rejects(()=>c.query('SELECT 1'));c.release();await until(()=>p.totalCount===0);
  check(lane+' borrowed socket rejects and evicts',true);
  c=await p.connect();pid=c.processID;
  const busy=c.query('SELECT pg_sleep(20)').then(()=>({ok:true}),()=>({ok:false}));
  await until(async()=>((await admin.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event)==='PgSleep');
  await admin.query('SELECT pg_terminate_backend($1)',[pid]);assert.equal((await busy).ok,false);c.release();
  await until(()=>p.totalCount===0);check(lane+' busy socket loss rejects without process exit',true);
  check(lane+' fresh read recovers on new backend',(await p.query('SELECT 1 n')).rows[0].n===1);
 }
 const settings={mode:'isolated-sim-user-data-v1',environmentId:'fixture-environment',resetEpoch:'fixture-epoch',tokensNotBefore:1};
 const targetProxy=await commitLossProxy(),proxiedTarget=pool('target',{host:targetProxy.host});
 const ledger=new UserLedger(proxiedTarget,settings);let work=0;
 targetProxy.arm();await assert.rejects(()=>ledger.tx(async c=>{work++;await c.query('INSERT INTO fixture_business VALUES(1)')}));
 check('target COMMIT reply lost, operation not retried',targetProxy.dropped()&&work===1);
 check('target commit REALLY visible despite client rejection',(await admin.query('SELECT count(*)::int n FROM fixture_business WHERE id=1')).rows[0].n===1);
 await until(()=>proxiedTarget.totalCount===0);check('ambiguous target client evicted',true);
 const direct=pool('target'),recoveredLedger=new UserLedger(direct,settings);
 await recoveredLedger.tx(async()=>{});check('actual ledger read/config revalidated after recovery',true);
 await admin.query("UPDATE sim_user_data.config SET reset_epoch='changed'");
 await assert.rejects(()=>recoveredLedger.tx(async()=>{throw Error('MUST_NOT_REACH_WORK')}),/SIM_USER_CONFIG_MISMATCH/);
 await admin.query("UPDATE sim_user_data.config SET reset_epoch='fixture-epoch'");check('actual ledger rejects changed epoch',true);
 const guardProxy=await commitLossProxy(),proxiedGuard=pool('guard',{host:guardProxy.host}),g=await proxiedGuard.connect();
 let targetWork=0;await g.query('BEGIN');guardProxy.arm();
 await assert.rejects(async()=>{
  try{await recoveredLedger.tx(async c=>{targetWork++;await c.query('INSERT INTO fixture_business VALUES(2)')});await g.query('COMMIT')}
  catch(e){await g.query('ROLLBACK').catch(()=>{});throw e}finally{g.release()}
 });
 check('guard COMMIT reply lost after target commit; no replay',guardProxy.dropped()&&targetWork===1);
 check('target row remains after outer guard failure',(await admin.query('SELECT count(*)::int n FROM fixture_business WHERE id=2')).rows[0].n===1);

 // Exact synthetic runtime role names exist ONLY in this disposable cluster.
 // No restored roles/data, production passwords, grants or shared profiles.
 await admin.query('CREATE ROLE sim_user_data_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
 await admin.query('CREATE ROLE sim_user_data_guard_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
 await admin.query('CREATE DATABASE sim_user_data');await admin.query('CREATE DATABASE cop_account_safety_guard');
 const ta=new Client({...config,database:'sim_user_data'}),ga=new Client({...config,database:'cop_account_safety_guard'});
 await ta.connect();await ga.connect();
 try {
  for(const [c,file] of [[ta,'001_app_schema.sql'],[ga,'003_independent_checkpoint.sql'],[ta,'004_app_continuity.sql']]){
   await c.query(await readFile(new URL('../deploy/sim-user-data/'+file,import.meta.url),'utf8'));
  }
  const b=Object.fromEntries(['guard_store_id','target_store_id','incarnation_id','environment_id','reset_epoch','checkpoint_id'].map(k=>[k,randomUUID()]));
  Object.assign(b,{restore_generation:'1',source_sha256:createHash('sha256').update(await readFile(new URL('../packages/sim-user-data/authority.mjs',import.meta.url))).digest('hex'),identity_sha256:'b'.repeat(64)});
  const keys=Object.keys(b),values=Object.values(b),placeholders=values.map((_,i)=>'$'+(i+1)).join(',');
  await ga.query(`INSERT INTO sim_erasure_guard_v2.user_data_checkpoint(component,contract,${keys.join(',')},state) VALUES('sim_user_data','sim-user-continuity-v1',${placeholders},'ready')`,values);
  await ta.query(`INSERT INTO sim_user_data.continuity(singleton,contract,${keys.join(',')}) VALUES(true,'sim-user-continuity-v1',${placeholders})`,values);
  await ta.query("INSERT INTO sim_user_data.config VALUES(true,'cop-sim-user-data-v1','production-sim-user-data-v1',$1,$2,1)",[b.environment_id,b.reset_epoch]);
  await ta.query('CREATE TABLE fixture_business(id integer PRIMARY KEY); GRANT INSERT ON fixture_business TO sim_user_data_runtime');
  const tr=pool('target',{database:'sim_user_data',user:'sim_user_data_runtime'}),gr=pool('guard',{database:'cop_account_safety_guard',user:'sim_user_data_guard_runtime'});
  const make=async(t=tr,g=gr)=>{const a=await createSimUserDataAuthority({guardPool:g,targetPool:t,component:'sim_user_data',binding:b});return new UserLedger(t,{mode:'production-sim-user-data-v1',environmentId:b.environment_id,resetEpoch:b.reset_epoch,tokensNotBefore:1},'sim_user_data',a)};
  const live=await make();await live.tx(async()=>{});check('actual production-mode factory/ledger with exact roles and two DBs',true);
  await ga.query("UPDATE sim_erasure_guard_v2.user_data_checkpoint SET state='quarantined'");
  let admitted=0;await assert.rejects(()=>live.tx(async()=>{admitted++}));assert.equal(admitted,0);
  await assert.rejects(()=>make());check('actual quarantine blocks existing and new authority',true);
  await ga.query("UPDATE sim_erasure_guard_v2.user_data_checkpoint SET state='ready',restore_generation=2");
  await assert.rejects(()=>live.tx(async()=>{admitted++}));assert.equal(admitted,0);check('actual changed restore generation blocks admission',true);
  await ga.query('UPDATE sim_erasure_guard_v2.user_data_checkpoint SET restore_generation=1');await live.tx(async()=>{});
  check('exact original continuity resumes only after fresh checks',true);
  assert.equal((await gr.query("UPDATE sim_erasure_guard_v2.user_data_checkpoint SET state='quarantined' RETURNING component")).rowCount,0);
  check('runtime guard cannot change checkpoint through RLS',true);
  const owner='a'.repeat(64),op=randomUUID(),at=new Date().toISOString();
  await ga.query("INSERT INTO sim_erasure_guard_v2.user_data_tombstone VALUES('sim_user_data',$1,$2,$3,2,$4)",[owner,op,at,b.reset_epoch]);
  await assert.rejects(()=>live.tx(async()=>{admitted++}));assert.equal(admitted,0);
  const replayed=await make();await assert.rejects(()=>replayed.withOwner(owner,async()=>{admitted++}));assert.equal(admitted,0);
  check('missing tombstone projection blocks; real restart replay fences owner',true);
  // New authority instances revalidate exact original witnesses before use.
  for(const lane of ['target','guard']){
   const proxy=await commitLossProxy();
   const p=pool(lane,{host:proxy.host,database:lane==='target'?'sim_user_data':'cop_account_safety_guard',user:lane==='target'?'sim_user_data_runtime':'sim_user_data_guard_runtime'});
   const actual=await make(lane==='target'?p:tr,lane==='guard'?p:gr);
   proxy.arm();let calls=0;const id=lane==='target'?10:11;
   await assert.rejects(()=>actual.tx(async c=>{calls++;await c.query('INSERT INTO fixture_business VALUES($1)',[id])}));
   assert.equal(calls,1);assert(proxy.dropped());
   check('production authority '+lane+' COMMIT reply loss never replays work',(await ta.query('SELECT count(*)::int n FROM fixture_business WHERE id=$1',[id])).rows[0].n===1);
  }
 }finally{await ta.end();await ga.end()}
 check('logs contain fixed fields only',records.every(r=>Object.keys(r).sort().join(',')==='event,kind,pool,sqlstate'&&['57P01','OTHER'].includes(r.sqlstate)));
 result={contract:'sim-pg-disconnect-real-fixture-v1',checks:checks.length,passed:true,
  evidence:checks,scope:'real PG18 Unix sockets only, actual pg.Pool and production-mode authority/ledger with exact synthetic roles, two disposable DBs, versioned migrations; NOT production bootstrap TLS or deployed acceptance',
  productionAccess:false,existingRolesChanged:false,syntheticRolesCreated:2,credentialsCreated:false,automaticRetry:false};
}finally{
 for(const p of pools)await p.end().catch(()=>{});
 for(const p of proxies)await p.close().catch(()=>{});
 await admin?.end().catch(()=>{});
 if(started)await exec(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{env});
 await owned();await rm(root,{recursive:true,force:false});
 await assert.rejects(()=>stat(root),{code:'ENOENT'});
}
console.log(JSON.stringify({...result,fixtureRemoved:true},null,2));
