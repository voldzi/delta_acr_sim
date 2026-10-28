/** Fixed read-only probe, run only inside the existing SIM API container.
 * No factory init/replay, enrollment, migrations, administrative SQL or retries.
 * Output only digests/booleans. Configured binding must match BOTH databases.
 */
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {verifyProductionDatabaseTransport} from '/app/deploy/account-safety/database-erasure-guard.mjs';
const {Client}=createRequire('/app/apps/simulator-api/package.json')('pg');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const need=x=>{if(!x)throw Error('LINEAGE_REJECTED')};
const fields=['guard_store_id','target_store_id','incarnation_id','environment_id','reset_epoch','checkpoint_id','restore_generation','source_sha256','identity_sha256'];
const stable=x=>fields.map(k=>String(x[k]));
export function maintenanceClientOptions(connectionString,database,ca){
 // Reuse the actual PURE bootstrap validator, never factory init/replay.
 verifyProductionDatabaseTransport(connectionString,database,{...process.env,NODE_ENV:'production'});
 need(typeof ca==='string'&&ca.includes('-----BEGIN CERTIFICATE-----')&&ca.includes('-----END CERTIFICATE-----'));
 const u=new URL(connectionString);
 // Do not pass connectionString alongside ssl: pg's URI parser could overwrite
 // explicit TLS options. Keep exact reviewed URI identity and mounted CA bytes.
 return {host:u.hostname,port:Number(u.port),database:u.pathname.slice(1),
  user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),
  ssl:{rejectUnauthorized:true,ca,servername:'haproxy.home.cz'},
  connectionTimeoutMillis:3000,statement_timeout:5000};
}
const PROBE_DEADLINE_MS=12000;
const watchdog=setTimeout(()=>{console.log(JSON.stringify({verified:false,code:'PROBE_DEADLINE'}));process.exit(2)},PROBE_DEADLINE_MS);
let target,guard,result;
try{
 const ca=readFileSync('/etc/csm-sim/postgresql-ca.pem','utf8');
 target=new Client(maintenanceClientOptions(process.env.SIM_USER_DATA_DATABASE_URL,'sim_user_data',ca));
 guard=new Client(maintenanceClientOptions(process.env.SIM_USER_DATA_GUARD_DATABASE_URL,'cop_account_safety_guard',ca));
 for(const c of [target,guard])c.on('error',()=>{});
 const expected=JSON.parse(process.env.SIM_USER_DATA_CONTINUITY_BINDING);
 await target.connect();await guard.connect();
 for(const c of [target,guard])await c.query('BEGIN READ ONLY');
 const snapshot=async()=>{
  for(const [c,name] of [[target,'sim_user_data_runtime'],[guard,'sim_user_data_guard_runtime']]){
   const r=(await c.query('SELECT current_user name,rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls elevated FROM pg_roles WHERE rolname=current_user')).rows;
   need(r.length===1&&r[0].name===name&&r[0].elevated===false);
  }
  const t=(await target.query('SELECT current_database() db,* FROM sim_user_data.continuity WHERE singleton')).rows;
  const g=(await guard.query("SELECT current_database() db,* FROM sim_erasure_guard_v2.user_data_checkpoint WHERE component='sim_user_data'")).rows;
  const c=(await target.query('SELECT * FROM sim_user_data.config WHERE singleton')).rows;
  need(t.length===1&&g.length===1&&c.length===1&&t[0].db==='sim_user_data'&&g[0].db==='cop_account_safety_guard');
  need(t[0].contract==='sim-user-continuity-v1'&&g[0].contract==='sim-user-continuity-v1'&&g[0].state==='ready');
  need(hash(stable(t[0]))===hash(stable(expected))&&hash(stable(g[0]))===hash(stable(expected)));
  need(c[0].contract==='cop-sim-user-data-v1'&&c[0].mode==='production-sim-user-data-v1'&&c[0].environment_id===expected.environment_id&&c[0].reset_epoch===expected.reset_epoch&&String(c[0].tokens_not_before)===process.env.SIM_USER_DATA_TOKENS_NOT_BEFORE);
  const tombstones=(await guard.query("SELECT * FROM sim_erasure_guard_v2.user_data_tombstone WHERE component='sim_user_data' ORDER BY operation_id LIMIT 10001")).rows;
  need(tombstones.length<=10000);
  for(const r of tombstones){
   const a=(await target.query('SELECT a.state,a.reset_epoch,j.operation_id,j.requested_at,j.oidc_iat FROM sim_user_data.account a JOIN sim_user_data.job j USING(owner_key) WHERE owner_key=$1',[r.owner_key])).rows;
   need(a.length===1&&['deleted','deletion_pending'].includes(a[0].state)&&a[0].reset_epoch===r.reset_epoch&&r.reset_epoch===expected.reset_epoch&&a[0].operation_id===r.operation_id&&a[0].requested_at.toISOString()===r.requested_at.toISOString()&&String(a[0].oidc_iat)===String(r.oidc_iat));
  }
  return {binding:hash(stable(expected)),config:hash(c),journal:hash(tombstones)};
 };
 const before=await snapshot(),after=await snapshot();need(hash(before)===hash(after));
 for(const c of [target,guard])await c.query('COMMIT');
 result={contract:'sim-maintenance-readonly-lineage-v1',verified:true,...after};
}catch{result={verified:false,code:'READONLY_LINEAGE_FAILED'};process.exitCode=2}
finally{
 try{await Promise.all([target,guard].filter(Boolean).map(c=>c.end()))}
 catch{result={verified:false,code:'READONLY_LINEAGE_CLOSE_FAILED'};process.exitCode=2}
 clearTimeout(watchdog);
}
// No partial success before close. The hard watchdog also bounds stalled end().
console.log(JSON.stringify(result));
