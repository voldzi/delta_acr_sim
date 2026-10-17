/** Pre-freeze preparation only. Returned privateConfig contains secrets.
 * Parent Root pipe only: never terminal/log/argv/env/disk. No apply capability. */
import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {hostname} from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {prepareSimRootPrivatePart,mergeSimRootPrivatePart} from './prepare-sim-root-private.mjs';
import * as ops from './clean-reset-ops.mjs';
import {inspectResetFiles} from './clean-reset-files.mjs';
import {inspectSimAppReset} from './sim-user-data-reset-files.mjs';
export const COMMON_COP_SOURCE='/srv/x5-production/staging/cop/clean-operator-shared-v3/app';
const need=x=>{if(!x)throw Error('COMMON_ROOT_PREPARATION_REJECTED')};
const names=['cop','ai','driver','files','sim_app_files','keycloak','sim_user_install'];
/** Testable orchestration; adapters are inspectors, never runtime admissions. */
export async function assembleInspectedCommonConfig(rootConfig,part,inspectors){
 need(rootConfig?.contractVersion==='cop-sim-clean-reset-worker-v1'&&rootConfig.phase==='inspect');
 need(rootConfig.reviewedPlans===undefined&&rootConfig.reviewedPlanDigests===undefined);
 const config=mergeSimRootPrivatePart(rootConfig,part),plans={...config.reviewedPlans};
 for(const name of names.filter(n=>n!=='sim_user_install'))plans[name]=await inspectors[name]();
 const digests={};for(const name of names){const d=plans[name]?.[name==='keycloak'?'inventoryDigest':'planDigest'];need(typeof d==='string'&&/^[a-f0-9]{64}$/.test(d));digests[name]=d;}
 return {privateConfig:{...config,reviewedPlans:plans,reviewedPlanDigests:digests},publicSummary:{contractVersion:'cop-sim-pre-freeze-seven-plans-v1',reviewedPlanDigests:digests,missingPlans:['cop_safety_install','messaging','media','edge'],completeForFreeze:false,mutationPerformed:false}};
}
async function selectedCopEnvironment(){
 const f=await open('/srv/cop/.env',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=await f.stat();need(s.isFile()&&s.nlink===1&&(s.mode&0o777)===0o600&&[0,1000].includes(s.uid)&&s.size<=1048576);const raw=await f.readFile('utf8'),after=await f.stat();need(Buffer.byteLength(raw)===s.size&&s.ino===after.ino&&s.mtimeMs===after.mtimeMs&&s.ctimeMs===after.ctimeMs);const e={};for(const line of raw.split(/\r?\n/)){const i=line.indexOf('='),k=line.slice(0,i);if(!['COP_OIDC_ISSUER','COP_KEYCLOAK_ERASURE_CLIENT_ID','COP_KEYCLOAK_ERASURE_CLIENT_SECRET'].includes(k))continue;need(!Object.hasOwn(e,k));let v=line.slice(i+1).trim();if(v.length>1&&v[0]===v.at(-1)&&['"',"'"].includes(v[0]))v=v.slice(1,-1);need(!/[\0\r\n'$]/.test(v));e[k]=v;}return e;}finally{await f.close()}
}
async function reviewedImport(relative){
 need(await realpath(COMMON_COP_SOURCE)===COMMON_COP_SOURCE);const root=await lstat(COMMON_COP_SOURCE);need(root.isDirectory()&&root.uid===0&&!(root.mode&0o222));
 const p=COMMON_COP_SOURCE+'/'+relative;need(await realpath(p)===p);const s=await lstat(p);need(s.isFile()&&s.uid===0&&!(s.mode&0o222));return import(pathToFileURL(p));
}
/** Called inside sealed Node24 Root process, with administrator password in RAM.
 * Root caller verifies enrolled source hashes before importing this module.
 * No standalone CLI, listener or production invocation is installed here. */
export async function prepareCommonRootPrivateConfig(options){
 need(process.getuid()===0&&hostname().split('.')[0]==='docker'&&process.versions.node.split('.')[0]==='24'&&!process.env.NODE_OPTIONS&&!process.env.NODE_PATH);
 const cop=await selectedCopEnvironment();need(cop.COP_OIDC_ISSUER==='https://login.zeleznalady.cz/realms/cop'&&cop.COP_KEYCLOAK_ERASURE_CLIENT_ID==='cop-account-erasure-worker'&&cop.COP_KEYCLOAK_ERASURE_CLIENT_SECRET?.length>=32);
 const {Pool}=createRequire(COMMON_COP_SOURCE+'/apps/cop-api/package.json')('pg');
 const {inspectCopUserReset}=await reviewedImport('scripts/account-safety/clean-user-reset.mjs');
 const {createCleanKeycloakReset}=await reviewedImport('scripts/account-safety/clean-keycloak-reset.mjs');
 const part=await prepareSimRootPrivatePart(options,{Pool});
 const keycloak={issuer:cop.COP_OIDC_ISSUER,clientId:cop.COP_KEYCLOAK_ERASURE_CLIENT_ID,clientSecret:cop.COP_KEYCLOAK_ERASURE_CLIENT_SECRET};
 const rootConfig={contractVersion:'cop-sim-clean-reset-worker-v1',phase:'inspect',resetEpoch:part.resetEpoch,tokensNotBefore:part.tokensNotBefore,simSource:new URL('../../',import.meta.url).pathname.replace(/\/$/,''),connections:{cop:{...part.connections.ai,database:'cop'}},keycloak};
 const pools=[];const pool=connection=>{const p=new Pool({...connection,max:1,connectionTimeoutMillis:5000,statement_timeout:20000,options:'-c default_transaction_read_only=on'});p.on('error',()=>{});pools.push(p);return p;};
 const lane=async name=>{const c=await pool(part.connections[name]).connect();try{await c.query('SET ROLE '+ops.SCOPES[name].owner);return await ops.inspectPlan(c,name);}finally{c.release()}};
 try{return await assembleInspectedCommonConfig(rootConfig,part,{cop:()=>inspectCopUserReset(pool(rootConfig.connections.cop)),ai:()=>lane('ai'),driver:()=>lane('driver'),files:()=>inspectResetFiles(),sim_app_files:()=>inspectSimAppReset(),keycloak:()=>createCleanKeycloakReset(keycloak).inspect()});}finally{await Promise.all(pools.map(p=>p.end()));}
}
