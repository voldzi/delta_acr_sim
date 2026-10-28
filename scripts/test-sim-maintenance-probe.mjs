/** Offline transport-builder and hard-deadline tests; no network or credentials. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const source=await readFile(new URL('./sim-maintenance-lineage-probe.mjs',import.meta.url),'utf8');
const validator=new URL('../deploy/account-safety/database-erasure-guard.mjs',import.meta.url).href;
const builder=source.slice(source.indexOf('export function maintenanceClientOptions('),source.indexOf('const PROBE_DEADLINE_MS='));
const {maintenanceClientOptions}=await import('data:text/javascript;base64,'+Buffer.from('import {verifyProductionDatabaseTransport} from '+JSON.stringify(validator)+';const need=x=>{if(!x)throw Error("REJECTED")};\n'+builder).toString('base64'));
const uri='postgresql://synthetic:synthetic@haproxy.home.cz:5000/sim_user_data?sslmode=verify-full&sslrootcert=%2Fetc%2Fcsm-sim%2Fpostgresql-ca.pem';
const ca='-----BEGIN CERTIFICATE-----\nsynthetic-builder-only-not-wire-test\n-----END CERTIFICATE-----';
let checks=0;const check=f=>{f();checks++};
check(()=>assert.deepEqual(maintenanceClientOptions(uri,'sim_user_data',ca),{host:'haproxy.home.cz',port:5000,database:'sim_user_data',user:'synthetic',password:'synthetic',ssl:{rejectUnauthorized:true,ca,servername:'haproxy.home.cz'},connectionTimeoutMillis:3000,statement_timeout:5000}));
for(const invalid of [uri.replace('haproxy.home.cz','localhost'),uri.replace(':5000',':5432'),uri.replace('verify-full','require'),uri+'&sslmode=verify-full',uri+'&sslrootcert=other',uri+'&ssl=false',uri.replace('/sim_user_data?','/other?')])check(()=>assert.throws(()=>maintenanceClientOptions(invalid,'sim_user_data',ca)));
check(()=>assert.throws(()=>maintenanceClientOptions(uri,'sim_user_data','not a certificate')));
const previous=process.env.NODE_TLS_REJECT_UNAUTHORIZED;
try{process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';check(()=>assert.throws(()=>maintenanceClientOptions(uri,'sim_user_data',ca)))}finally{if(previous===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=previous}
// Evaluate the actual source try/finally/watchdog. Only fixed imports, CA and
// transport creation are mocked in this generated child; production has no seam.
const base=source.replace("import {verifyProductionDatabaseTransport} from '/app/deploy/account-safety/database-erasure-guard.mjs';",'const verifyProductionDatabaseTransport=()=>{};')
 .replace("const {Client}=createRequire('/app/apps/simulator-api/package.json')('pg');",'class Client{on(){} async connect(){CONNECT} async end(){END}}')
 .replace("const ca=readFileSync('/etc/csm-sim/postgresql-ca.pem','utf8');",'const ca='+JSON.stringify(ca)+';');
for(const stage of ['connect','end']){
 // One production-duration watchdog test; end path uses same code at 120ms to
 // avoid another 12s wait. Neither may emit any preliminary success record.
 const code=base.replace('CONNECT',stage==='connect'?'await new Promise(()=>{});':'throw Error("synthetic connect rejection");').replace('END',stage==='end'?'await new Promise(()=>{});':'')
  .replace('const PROBE_DEADLINE_MS=12000;',stage==='connect'?'const PROBE_DEADLINE_MS=12000;':'const PROBE_DEADLINE_MS=120;');
 const started=Date.now();let failed;
 try{await exec(process.execPath,['--input-type=module','-e',code],{timeout:15000,env:{...process.env,SIM_USER_DATA_DATABASE_URL:uri,SIM_USER_DATA_GUARD_DATABASE_URL:uri,SIM_USER_DATA_CONTINUITY_BINDING:'{}'}})}catch(e){failed=e}
 assert(failed);assert.equal(failed.code,2);assert.deepEqual(JSON.parse(failed.stdout),{verified:false,code:'PROBE_DEADLINE'});assert(Date.now()-started<14500);checks++;
}
console.log(JSON.stringify({offlineProbeChecks:checks,productionTlsWireTest:false,productionWatchdogMs:12000}));
