#!/usr/bin/env python3
"""Finite OWNED TEST ONLY cutover. Prepared, not auto-run by any installer.
Root must first agree on the stopped-writer window for the accepted A operation.
No production target, credential rotation, reenrollment, restore or whole GO.
"""
import hashlib,json,os,pathlib,re,socket,stat,subprocess,sys,time
OWNER='cop-clean-whole12-9aff26e65b74'
OLD=OWNER+'-sim-tls-v3'
OLD_ID='6251368d5d6052bf2beacaf002136061211133439692dd170535003408e2ef31'
OLD_IMAGE='sha256:08570327596756178436c34865a16aafb5f2ce561a05d292891441e15d015015'
NEW=OWNER+'-sim-replay-v1'
IMAGE='sha256:923194d92acd6dd176c80bc8a151eb953883f80d3555b87bb45aba9da64833fa'
HOLDER='10aa1a37797474fa8cdf16ee7581cfa1b7e3fcfef4abc2f99352bc7de414a44a'
EPOCH='7f970a87-f36b-4e7f-8226-8c9107c8d3e4'
OPERATION='b6fe7a68-d7a2-49e0-a9da-6dd7bcb01a4e'
MODE='same-epoch-completed-content-replay-v1'
SOURCE_REV='175c731a3fbe78ce23e7303ff5df13eceaaf7f45'
BASE=pathlib.Path('/srv/x5-production/staging/cop')/OWNER
SOURCE=BASE/'sim-replay-cutover-source-175c731'
PINS={'scripts/fixtures/whole12-tls-production-sim.mjs':'89fdbaaa15bc2ab456c4b593e64527eb1177bc19567c2e77bea56caaa258e63c',
      'scripts/resume-whole12-tls-production-sim.mjs':'bf6c14549d27982d88f0a3dd89a7d61ebbb583a95af32471d261c47a4e641f6d'}
def need(v,code):
    if not v:raise RuntimeError(code)
def run(args,body=None,timeout=30):
    r=subprocess.run(args,input=body,capture_output=True,timeout=timeout)
    need(r.returncode==0,'OWNED_CUTOVER_COMMAND_FAILED')
    return r.stdout
def docker(*args,body=None,timeout=30):return run(['/usr/bin/docker',*args],body,timeout)
def inspect(name):return json.loads(docker('inspect',name))[0]
def valid_old(c):
    need(c['Id']==OLD_ID and c['Image']==OLD_IMAGE and c['State']['Running'] is True,'OWNED_CUTOVER_OLD_IDENTITY')
    need(c['HostConfig']['NetworkMode']=='container:'+HOLDER and not c['HostConfig']['PortBindings'],'OWNED_CUTOVER_NETWORK')
    need(c['Config']['Labels'].get('cop.test.owner')==OWNER and c['Config']['User']=='1000:1000','OWNED_CUTOVER_OWNER')
def source_check():
    need(SOURCE.is_dir() and not SOURCE.is_symlink() and SOURCE.resolve()==SOURCE,'OWNED_CUTOVER_SOURCE_PATH')
    args=['/usr/bin/git','-c','safe.directory='+str(SOURCE),'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',str(SOURCE)]
    need(run(args+['rev-parse','HEAD']).decode().strip()==SOURCE_REV,'OWNED_CUTOVER_SOURCE_REVISION')
    need(not run(args+['status','--porcelain=v1','--untracked-files=all','--ignored=matching']),'OWNED_CUTOVER_SOURCE_DIRTY')
    for row in run(args+['ls-tree','-rz','HEAD']).split(b'\0'):
        if not row:continue
        meta,name=row.split(b'\t',1);mode,kind,blob=meta.split()
        need(kind==b'blob' and mode in {b'100644',b'100755'},'OWNED_CUTOVER_SOURCE_KIND')
        p=SOURCE/os.fsdecode(name);s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1,'OWNED_CUTOVER_SOURCE_FILE')
        raw=p.read_bytes();need(hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest().encode()==blob,'OWNED_CUTOVER_SOURCE_BYTES')
    for name,digest in PINS.items():need(hashlib.sha256((SOURCE/name).read_bytes()).hexdigest()==digest,'OWNED_CUTOVER_CRITICAL_SOURCE')
def private_bytes(container,name):
    need(name in {'sim-private.json','sim-resume-private.json','sim-content-snapshot.json'},'OWNED_CUTOVER_PRIVATE_PATH')
    js="const f=require('node:fs'),p='/dev/shm/cop-clean-whole/"+name+"';const s=f.lstatSync(p);if(!s.isFile()||s.nlink!==1||s.uid!==1000||(s.mode&511)!==384||s.size>32768000)process.exit(2);process.stdout.write(f.readFileSync(p))"
    return docker('exec',container,'node','-e',js)
READBACK=r"""import fs from 'node:fs';const x=JSON.parse(fs.readFileSync('/dev/shm/cop-clean-whole/sim-private.json'));const r=await fetch('http://127.0.0.1:4324/readback',{headers:{authorization:'Bearer '+x.input.base.environment.copServiceToken},signal:AbortSignal.timeout(7000)});if(r.status!==200)process.exit(2);process.stdout.write(await r.text());"""
STOP=r"""import fs from 'node:fs';const a=[];for(const n of fs.readdirSync('/proc'))if(/^\d+$/.test(n)){try{const c=fs.readFileSync('/proc/'+n+'/cmdline','utf8').split('\0');if(c[0]==='node'&&c[1]==='/fixture-clean/scripts/resume-whole12-tls-production-sim.mjs'&&c[2]==='--resume-owned-fixture')a.push(Number(n))}catch{}}if(a.length!==1)throw Error('OLD_RUNNER_IDENTITY');process.kill(a[0],'SIGTERM');console.log('EXACT_RUNNER_STOP_SENT')"""
SQL=r"""
import fs from 'node:fs';import crypto from 'node:crypto';import{createRequire}from'node:module';
import{userDataCatalog}from'/fixture-clean/scripts/lib/sim-user-data-profile.mjs';
import{verifiedCompletedReplayProfile,verifyCompletedReplayCatalog}from'/fixture-clean/scripts/lib/completed-replay-install.mjs';
const need=v=>{if(!v)throw Error('OWNED_CUTOVER_SQL_REFUSED')};
const cfg=JSON.parse(fs.readFileSync('/dev/shm/cop-clean-whole/sim-private.json'));
const operation='b6fe7a68-d7a2-49e0-a9da-6dd7bcb01a4e',epoch='7f970a87-f36b-4e7f-8226-8c9107c8d3e4';
need(cfg.input.base.resetEpoch===epoch);
const{Pool}=createRequire('/runtime/router/apps/ai-router-api/package.json')('pg');
const pools=[];const pool=database=>{const p=new Pool({host:'/private/tmp/sim-user-install-pg-9aff26e65b74/s',port:5000,user:'fixture_admin',database,max:1,connectionTimeoutMillis:2000,statement_timeout:10000});pools.push(p);return p};
try{
const ai=pool('sim_ai_router'),driver=pool('sim_driver_measurements'),main=pool('sim_user_data'),guard=pool('cop_account_safety_guard');
const id=(await ai.query("SELECT current_user u,current_setting('cluster_name') n,current_setting('data_directory') d")).rows[0];
need(id.u==='fixture_admin'&&id.n==='sim_whole12_tls_fixture_v1'&&id.d==='/private/tmp/sim-user-install-pg-9aff26e65b74/db');
need(Number((await ai.query("SELECT count(*) n FROM pg_stat_activity WHERE usename=ANY($1::text[])",[['ai_router_runtime','driver_measurements_runtime','sim_user_data_runtime','sim_user_data_guard_runtime','sim_user_history_guard_runtime']])).rows[0].n)===0);
for(const[p,s]of[[ai,'sim_clean'],[driver,'sim_clean'],[main,'sim_user_data'],[ai,'sim_user_history']]){
 const j=(await p.query(`SELECT j.operation_id,a.state,a.reset_epoch FROM ${s}.job j JOIN ${s}.account a USING(owner_key)`)).rows;
 need(j.length===1&&j[0].operation_id===operation&&j[0].state==='deleted'&&j[0].reset_epoch===epoch);
}
for(const component of ['sim_user_data','sim_user_history']){
 const b=cfg.bindings[component],row=(await guard.query('SELECT * FROM sim_erasure_guard_v2.user_data_checkpoint WHERE component=$1',[component])).rows[0];
 need(row?.state==='ready');for(const[k,v]of Object.entries(b))need(String(row[k])===String(v));
}
const texts=await verifiedCompletedReplayProfile('same-epoch-completed-content-replay-v1');
const baseRaw=fs.readFileSync('/fixture-clean/deploy/sim-user-data/reset-manifest-v2.json');
need(crypto.createHash('sha256').update(baseRaw).digest('hex')==='9f71d113ba47a7880fca6a7df76f7fefbca401c1791acb57f86969c1fdaed76e');
const base=JSON.parse(baseRaw),c=await ai.connect();
try{
 await c.query('SET ROLE ai_router_migrator;BEGIN');
 await c.query("SET LOCAL lock_timeout='1500ms';SET LOCAL statement_timeout='10000ms';LOCK TABLE public.ai_router_request,public.ai_router_billing_request,public.ai_router_user_key,public.ai_router_user_key_audit,sim_clean.config,sim_clean.account,sim_clean.job,sim_clean.resource,sim_clean.cost_daily,sim_user_history.config,sim_user_history.account,sim_user_history.job,sim_user_history.resource,sim_user_history.cost_daily IN ACCESS EXCLUSIVE MODE");
 const before=await userDataCatalog(c,'sim_user_history');need(before.digest===base.aiUserDataCatalogDigest&&before.baseCatalogDigest===base.aiPostCatalogDigest);
 const tables=['public.ai_router_request','public.ai_router_billing_request','public.ai_router_user_key','public.ai_router_user_key_audit','sim_clean.config','sim_clean.account','sim_clean.job','sim_clean.resource','sim_clean.cost_daily','sim_user_history.config','sim_user_history.account','sim_user_history.job','sim_user_history.resource','sim_user_history.cost_daily'];
 async function hashes(){const x={};for(const t of tables)x[t]=(await c.query(`SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text,'null'),'UTF8')),'hex') h FROM ${t} r`)).rows[0].h;return JSON.stringify(x)}
 const data=await hashes();for(const text of texts.texts)await c.query(text);
 const after=await verifyCompletedReplayCatalog(c,texts);need(await hashes()===data);
 await c.query('COMMIT');console.log(JSON.stringify({additivePoliciesInstalled:5,originalOperationPreserved:true,allAiTargetDataHashesPreserved:true,newAiCatalog:after.baseCatalogDigest,newHistoryCatalog:after.digest,productionTouched:false,wholeAccountComplete:false}));
}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
}finally{for(const p of pools)await p.end()}
"""
def main(mode):
    need(mode in {'--inspect','--apply-agreed-owned-cutover'},'OWNED_CUTOVER_MODE')
    need(os.getuid()==1000 and socket.gethostname().split('.')[0]=='docker','OWNED_CUTOVER_HOST')
    need(run(['/usr/bin/findmnt','-n','-o','UUID','--mountpoint','/srv/x5-production']).strip()==b'2f93f595-b61b-4eea-9054-7afa9b275b5b','OWNED_CUTOVER_X5')
    x5=pathlib.Path('/srv/x5-production');need(x5.stat().st_dev!=pathlib.Path('/').stat().st_dev,'OWNED_CUTOVER_DEVICE')
    need(os.statvfs(x5).f_bavail*os.statvfs(x5).f_frsize>=1024**3,'OWNED_CUTOVER_SPACE')
    source_check();old=inspect(OLD);valid_old(old)
    candidate=inspect(IMAGE);need(candidate['Id']==IMAGE and candidate['Config']['Labels']['org.opencontainers.image.revision']=='be34050f78843f3bdb8228f710d83558a75d474f','OWNED_CUTOVER_IMAGE')
    before=json.loads(docker('exec',OLD,'node','--input-type=module','-e',READBACK))
    need(before['appOwners']['a']['state']=='deleted' and before['appOwners']['a']['fileCount']==0 and before['simHistory']['a']['state']=='deleted' and before['simHistory']['a']['requests']==before['simHistory']['a']['billing']==0,'OWNED_CUTOVER_A_NOT_CLEAN')
    need(all(before[lane]['owners'][owner]['stateA']=='deleted' and before[lane]['owners'][owner]['removableA']==0 for lane,owner in [('ai','ai_router'),('driver','sim_measurements')]),'OWNED_CUTOVER_BASE_A_NOT_CLEAN')
    private=private_bytes(OLD,'sim-private.json');resume=json.loads(private_bytes(OLD,'sim-resume-private.json'));snapshot=private_bytes(OLD,'sim-content-snapshot.json')
    original=resume['expectedReadback']
    for group in ['appOwners','simHistory']:need(before[group]['b']==original[group]['b'],'OWNED_CUTOVER_B_CHANGED')
    for lane,owner in [('ai','ai_router'),('driver','sim_measurements')]:
        for key in ['stateB','removableB','countsB','preservedBFingerprint']:need(before[lane]['owners'][owner][key]==original[lane]['owners'][owner][key],'OWNED_CUTOVER_B_CHANGED')
    cfg=json.loads(private);need(cfg['input']['base']['resetEpoch']==EPOCH,'OWNED_CUTOVER_EPOCH')
    need(hashlib.sha256(snapshot).hexdigest()=='7655aa9d17385db7bab15236e281dc463d54bbca636c2a441eff3993f0c5f087','OWNED_CUTOVER_SNAPSHOT')
    need(set(resume['credentials'])=={'ai_router_runtime','driver_measurements_runtime','sim_user_data_runtime','sim_user_data_guard_runtime','sim_user_history_guard_runtime'},'OWNED_CUTOVER_RUNTIME_ROLES')
    need(all(re.fullmatch(r'[A-Za-z0-9_-]{43}',v) for v in resume['credentials'].values()),'OWNED_CUTOVER_CREDENTIAL_FORMAT')
    if mode=='--inspect':
        print(json.dumps({'scope':'exact owned fixture only','oldContainer':OLD_ID,'candidateImage':IMAGE,'sourceRevision':SOURCE_REV,'actualAZero':True,'operationSqlNotYetChecked':True,'changesPerformed':0,'wholeAccountComplete':False}));return
    args=['run','-d','--name',NEW,'--pull','never','--label','cop.test.owner='+OWNER,'--label','cop.test.component=sim-replay-v1','--log-driver','none','--network','container:'+HOLDER,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000','--memory','1200m','--cpus','2','--pids-limit','200','--tmpfs','/dev/shm:rw,size=64m,uid=1000,gid=1000,mode=0700','--tmpfs','/tmp:rw,size=64m,uid=1000,gid=1000,mode=0700']
    for m in old['Mounts']:
        src=str(SOURCE) if m['Destination']=='/fixture-clean' else m['Source']
        args+=['--mount','type=bind,source='+src+',target='+m['Destination']+('' if m['RW'] else ',readonly')]
    args+=['--entrypoint','node',IMAGE,'-e','setInterval(()=>{},60000)'];cid=docker(*args).decode().strip()
    resume.update(contractVersion='sim-whole12-owned-accepted-replay-resume-v1',replay={'mode':MODE,'acceptedOperationId':OPERATION},expectedReadback=before)
    payload=json.dumps({'private':private.decode(),'resume':resume,'snapshot':snapshot.decode()}).encode()
    stage="import fs from 'node:fs';let b='';for await(const x of process.stdin)b+=x;const p=JSON.parse(b);fs.mkdirSync('/dev/shm/cop-clean-whole',{mode:0o700});for(const[n,v]of [['sim-private.json',p.private],['sim-resume-private.json',JSON.stringify(p.resume)],['sim-content-snapshot.json',p.snapshot]])fs.writeFileSync('/dev/shm/cop-clean-whole/'+n,v,{mode:0o600,flag:'wx'});console.log('PRIVATE_RAM_PRESERVED')"
    need(docker('exec','-i',cid,'node','--input-type=module','-e',stage,body=payload).strip()==b'PRIVATE_RAM_PRESERVED','OWNED_CUTOVER_RAM')
    # Last source/CID check before stopping only the one exact synthetic runner.
    source_check();valid_old(inspect(OLD));
    need(docker('exec',OLD,'node','--input-type=module','-e',STOP).strip()==b'EXACT_RUNNER_STOP_SENT','OWNED_CUTOVER_STOP')
    closed="let open=0;for(const p of [4311,4312,4314,4321,4322,4324])try{await fetch('http://127.0.0.1:'+p+'/readback',{signal:AbortSignal.timeout(300)});open++}catch{}console.log(open)"
    for _ in range(30):
        if docker('exec',cid,'node','--input-type=module','-e',closed).strip()==b'0':break
        time.sleep(.3)
    else:raise RuntimeError('OWNED_CUTOVER_WRITERS_NOT_STOPPED')
    # Existing credentials are reused, not rotated. SQL also checks no old-role
    # sessions remain, exact accepted jobs and independent bindings unchanged.
    policy=docker('exec',cid,'node','--input-type=module','-e',SQL,timeout=45)
    result=json.loads(policy);need(result['additivePoliciesInstalled']==5 and result['allAiTargetDataHashesPreserved'] is True,'OWNED_CUTOVER_POLICY_READBACK')
    docker('exec','-d',cid,'/bin/sh','-c','node /fixture-clean/scripts/resume-whole12-tls-production-sim.mjs --resume-owned-fixture > /dev/shm/cop-clean-whole/accepted-replay-status.jsonl 2>&1')
    for _ in range(40):
        raw=docker('exec',cid,'node','-e',"process.stdout.write(require('node:fs').readFileSync('/dev/shm/cop-clean-whole/accepted-replay-status.jsonl'))").decode().strip()
        if raw:break
        time.sleep(.5)
    receipt=json.loads(raw)
    need(receipt.get('actualCapabilities')=={'main':200,'ai':200,'driver':200} and receipt.get('completedReplayMode')==MODE and receipt.get('contentStateAndFingerprintsPreserved') is True,'OWNED_CUTOVER_NEW_RUNTIME_NOT_READY')
    print(json.dumps({'scope':'exact owned fixture only','newContainerId':cid,'image':IMAGE,'acceptedOperationId':OPERATION,'policyReadback':result,'runtimeReadback':receipt,'credentialsRotated':False,'restorePerformed':False,'productionTouched':False,'wholeAccountComplete':False}))
if __name__=='__main__':
    try:
        need(len(sys.argv)==2,'OWNED_CUTOVER_ARGS');main(sys.argv[1])
    except Exception as e:
        print(json.dumps({'error':str(e) if re.fullmatch(r'[A-Z0-9_]{1,100}',str(e)) else 'OWNED_CUTOVER_FAILED','privateDiagnosticsPrinted':False,'wholeAccountComplete':False}));sys.exit(1)
