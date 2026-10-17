/** Returns SECRETS in Root RAM. Never log/stringify to a user, argv, Git or disk.
 * Preparation + optional actual read-only inspect only; no reset/admission/DDL. */
import{readFile,open}from'node:fs/promises';
import{constants}from'node:fs';
import{randomBytes,randomUUID,createHash}from'node:crypto';
import{fileURLToPath}from'node:url';
import{join}from'node:path';
import{hostname}from'node:os';
import{runtimeIdentityFingerprint}from'../../packages/sim-user-data/bootstrap.mjs';
import{verifiedUserMigrations,USER_DATA_MANIFEST_SHA}from'./sim-user-data-enroll.mjs';
import{verifiedCompletedReplayProfile}from'./completed-replay-install.mjs';
import{runSimUserInstall}from'./sim-user-data-private-install.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url)),MODE='same-epoch-completed-content-replay-v1';
const need=v=>{if(!v)throw Error('SIM_ROOT_PRIVATE_PREPARATION_REJECTED')};
const uuid=x=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x??'');
const secret=()=>randomBytes(32).toString('base64url');
const KEYS=['AI_ROUTER_COP_TOKEN','AI_ROUTER_COP_ACTOR_SECRET','AI_ROUTER_USER_HASH_SECRET','AI_ROUTER_SIM_TOKEN','AI_ROUTER_ACCOUNT_ERASURE_ISSUER','DRIVER_MEASUREMENTS_COP_TOKEN','DRIVER_MEASUREMENTS_HASH_SECRET','DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET','DRIVER_ACCOUNT_ERASURE_ISSUER','SIM_OIDC_ISSUER','SIM_API_AUTH_MODE','SIM_PUBLISHER_MODE','SIM_USER_DATA_OWNER_SECRET','SIM_USER_DATA_COP_TOKEN','SIM_USER_DATA_COP_ACTOR_SECRET','SIM_USER_DATA_ROUTER_ACTOR_SECRET','SIM_USER_DATA_ENABLED','SIM_USER_HISTORY_ENABLED'];
export function selectedSimIdentityEnvironment(raw){
 need(Buffer.isBuffer(raw)||typeof raw==='string');const result={};
 for(const line of raw.toString().split(/\r?\n/)){const i=line.indexOf('=');if(i<0)continue;const key=line.slice(0,i);if(!KEYS.includes(key))continue;need(!Object.hasOwn(result,key));let value=line.slice(i+1).trim();if(value.length>1&&value[0]===value.at(-1)&&['"',"'"].includes(value[0]))value=value.slice(1,-1);need(!/[\r\n\0'$]/.test(value));result[key]=value;}
 return result;
}
/** Pure apart from reading and pinning public repository manifests. */
export async function buildSimRootPrivatePart({environmentBytes,caPem,postgresPassword,resetEpoch=randomUUID(),tokensNotBefore=Math.floor(Date.now()/1000),environmentId=randomUUID(),guardStoreId=randomUUID(),now=Math.floor(Date.now()/1000)}){
 const e=selectedSimIdentityEnvironment(environmentBytes);
 need(uuid(resetEpoch)&&uuid(environmentId)&&uuid(guardStoreId)&&Number.isSafeInteger(tokensNotBefore)&&tokensNotBefore>0&&tokensNotBefore<=now);
 need(typeof postgresPassword==='string'&&postgresPassword.length>0&&!postgresPassword.includes('\0'));
 need(typeof caPem==='string'&&caPem.includes('-----BEGIN CERTIFICATE-----')&&!caPem.includes('PRIVATE KEY'));
 need(e.SIM_OIDC_ISSUER==='https://login.zeleznalady.cz/realms/cop'&&e.AI_ROUTER_ACCOUNT_ERASURE_ISSUER===e.SIM_OIDC_ISSUER&&e.DRIVER_ACCOUNT_ERASURE_ISSUER===e.SIM_OIDC_ISSUER);
 need(['hybrid','oidc'].includes(e.SIM_API_AUTH_MODE)&&e.SIM_PUBLISHER_MODE==='DRY_RUN');
 for(const key of KEYS.slice(0,9).filter(k=>!k.endsWith('_ISSUER')))need(typeof e[key]==='string'&&e[key].length>=32);
 const newKeys=['SIM_USER_DATA_OWNER_SECRET','SIM_USER_DATA_COP_TOKEN','SIM_USER_DATA_COP_ACTOR_SECRET','SIM_USER_DATA_ROUTER_ACTOR_SECRET'];
 const generated=[];const canonical={};for(const key of newKeys){if(e[key]!==undefined){need(e[key].length>=32);canonical[key]=e[key]}else{need(e.SIM_USER_DATA_ENABLED!=='true'&&e.SIM_USER_HISTORY_ENABLED!=='true');canonical[key]=secret();generated.push(key)}}
 need(/^[A-Za-z0-9_-]{32,128}$/.test(canonical.SIM_USER_DATA_COP_TOKEN));
 const manifest=JSON.parse(await readFile(join(ROOT,'deploy/sim-user-data/reset-manifest-v2.json')));await verifiedUserMigrations(manifest);await verifiedCompletedReplayProfile(MODE);
 const identities={sim_user_data:{ownerSecret:canonical.SIM_USER_DATA_OWNER_SECRET,actorSecret:canonical.SIM_USER_DATA_COP_ACTOR_SECRET,routerActorSecret:canonical.SIM_USER_DATA_ROUTER_ACTOR_SECRET,issuer:e.SIM_OIDC_ISSUER},sim_user_history:{hashSecret:e.AI_ROUTER_USER_HASH_SECRET,actorSecret:canonical.SIM_USER_DATA_ROUTER_ACTOR_SECRET,issuer:e.SIM_OIDC_ISSUER}};
 const bindings=Object.fromEntries(Object.keys(identities).map(component=>[component,{guard_store_id:guardStoreId,target_store_id:randomUUID(),incarnation_id:randomUUID(),environment_id:environmentId,reset_epoch:resetEpoch,checkpoint_id:randomUUID(),restore_generation:'1',source_sha256:manifest.authoritySourceSha256,identity_sha256:runtimeIdentityFingerprint(component,identities[component])}]));
 const credentials=Object.fromEntries(['sim_user_data_migrator','sim_user_data_runtime','sim_user_data_guard_runtime','sim_user_history_guard_runtime'].map(k=>[k,secret()]));
 const connection=database=>({host:'haproxy.home.cz',port:5000,database,user:'postgres',password:postgresPassword,ssl:{ca:caPem,rejectUnauthorized:true}});
 const enrollments=Object.fromEntries(['ai','driver'].map(lane=>[lane,{environmentId,resetEpoch,tokensNotBefore,userDatasetId:randomUUID(),enrollmentId:randomUUID()}]));
 const simUserInstall={contractVersion:'sim-user-private-install-v1',profile:'production',phase:'inspect',manifest,completedReplayMode:MODE,resetEpoch,tokensNotBefore,connections:{admin:connection('postgres'),ai:connection('sim_ai_router'),guard:connection('cop_account_safety_guard')},credentials,serviceToken:canonical.SIM_USER_DATA_COP_TOKEN,identities,bindings};
 return{contractVersion:'sim-root-private-part-v1',resetEpoch,tokensNotBefore,enrollments,connections:{ai:connection('sim_ai_router'),driver:connection('sim_driver_measurements')},simUserInstall,generatedCanonicalIdentityFields:generated,preservedBindingDigests:Object.fromEntries(KEYS.slice(0,9).filter(k=>!k.endsWith('_ISSUER')).map(k=>[k,createHash('sha256').update(e[k]).digest('hex')])),manifestSha256:USER_DATA_MANIFEST_SHA,mutationPerformed:false};
}
/** Real fixed production path reader. Caller is the sealed Root CLI on docker.
 * Root supplies its PostgreSQL password in-process; no environment/argv secret. */
export async function prepareSimRootPrivatePart(options,{Pool}){
 need(process.getuid()===0&&process.versions.node.split('.')[0]==='24'&&hostname().split('.')[0]==='docker');
 const f=await open('/srv/sim/.env',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let raw;
 try{const s=await f.stat();need(s.isFile()&&s.nlink===1&&(s.mode&0o777)===0o600&&[0,1000].includes(s.uid)&&s.size<=1048576);raw=await f.readFile();const after=await f.stat();need(raw.length===s.size&&s.ino===after.ino&&s.mtimeMs===after.mtimeMs&&s.ctimeMs===after.ctimeMs)}finally{await f.close()}
 const caPem=await readFile('/etc/vcode-cop-pgbouncer/postgres-ca.crt','utf8');
 const part=await buildSimRootPrivatePart({...options,environmentBytes:raw,caPem,now:Math.floor(Date.now()/1000)});
 const plan=await runSimUserInstall(part.simUserInstall,{Pool});
 // Never invent a post-reset "absent" inventory. Existing objects need an
 // explicit separate reviewed transition; this fresh installer cannot adopt.
 need(plan.facts.roles.length===0&&plan.facts.databases.length===0&&!Object.values(plan.facts.guardTables).some(Boolean));
 part.simUserInstall.reviewedPlan=plan;part.reviewedPlans={sim_user_install:plan};part.reviewedPlanDigests={sim_user_install:plan.planDigest};
 return part;
}
export function mergeSimRootPrivatePart(rootConfig,part){
 need(part.contractVersion==='sim-root-private-part-v1'&&rootConfig.resetEpoch===part.resetEpoch&&rootConfig.tokensNotBefore===part.tokensNotBefore&&rootConfig.connections?.cop&&typeof part.simUserInstall.reviewedPlan?.planDigest==='string'&&part.simUserInstall.reviewedPlan.planDigest===part.reviewedPlanDigests?.sim_user_install);
 return{...rootConfig,connections:{...rootConfig.connections,...part.connections},enrollments:{...rootConfig.enrollments,...part.enrollments},simUserInstall:part.simUserInstall,reviewedPlans:{...rootConfig.reviewedPlans,...part.reviewedPlans},reviewedPlanDigests:{...rootConfig.reviewedPlanDigests,...part.reviewedPlanDigests}};
}
