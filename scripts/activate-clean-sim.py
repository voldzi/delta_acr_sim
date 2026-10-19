"""Root-only SIM composition activation. No CLI, global flag switch or canary GO.
Requires a completed real reset receipt; never reuses stopped ResetAdmission
after starting services. Root caller owns the subsequent shared COP canary.
"""
from contextlib import contextmanager
import fcntl,hashlib,importlib.util,json,os,select,socket,stat,subprocess,time
from pathlib import Path
_spec=importlib.util.spec_from_file_location('sim_common_activation',Path(__file__).with_name('coordinate-clean-release.py'))
common=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(common)
ROOT=Path('/srv/sim');LOCK=Path('/srv/cop/.storage.lock');COP_ENV=Path('/srv/cop/.env')
LEGACY_COMPOSE=Path('/home/voldzi/sim-erasure-apply-ca1fd6b-v2/deploy/account-safety/database-v2.prepare.compose.yml')
SERVICES={'sim-api':('csm-sim-api','sim_api'),'ai-router-api':('csm-sim-ai-router-api','ai_router'),'situation-data-api':('csm-sim-situation-data-api','situation_data'),'sim-web':('csm-sim-web','sim_web')}
FLAGS={'SIM_CLEAN_AI_ENABLED','SIM_CLEAN_DRIVER_ENABLED','SIM_USER_DATA_ENABLED','SIM_USER_HISTORY_ENABLED','SIM_USER_DATA_RELAY_ENABLED'}
FEATURES={'DRIVER_MEASUREMENTS_ENABLED','DRIVER_MEASUREMENTS_REVOCATION_ENABLED','AI_ROUTER_EXTERNAL_ENABLED','AI_ROUTER_COP_BYOK_ENABLED','AI_ROUTER_SIM_IZS_ENABLED','AI_ROUTER_SIM_IZS_BUDGET_APPROVED','AI_ROUTER_ADVANCED_ENABLED','SIM_PUBLISHER_MODE','SIM_API_AUTH_REQUIRED','SIM_API_AUTH_MODE','EXTERNAL_AI_ALLOWED'}
need=common.need
def sha(raw):return hashlib.sha256(raw).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def compose_environment(images):
    need(set(images)=={'SIM_ERASURE_ROUTER_IMAGE','SIM_ERASURE_DRIVER_IMAGE','DRIVER_MEASUREMENTS_IMAGE'} and all(isinstance(v,str) and len(v)==71 and v.startswith('sha256:') and all(c in '0123456789abcdef' for c in v[7:]) for v in images.values()),'SIM_ACTIVATION_COMPOSE_IMAGE_PINS')
    return {'PATH':'/usr/bin:/bin','LANG':'C','DOCKER_HOST':'unix:///var/run/docker.sock',**images}
def run(args,timeout=45,*,compose_images=None):
    environment={'PATH':'/usr/bin:/bin','LANG':'C','DOCKER_HOST':'unix:///var/run/docker.sock'}
    if compose_images is not None:
        need(args[:2]==['/usr/bin/docker','compose'] and args[-3:]==['config','--format','json'],'SIM_ACTIVATION_COMPOSE_IMAGE_CONTEXT')
        environment=compose_environment(compose_images)
    r=subprocess.run(args,capture_output=True,timeout=timeout,env=environment)
    need(r.returncode==0,'SIM_ACTIVATION_COMMAND_FAILED');return r.stdout
def inspect(name):return json.loads(run(['/usr/bin/docker','inspect',name]))[0]
def spec(c):return {k:c[k] for k in ['Id','Image','Config','HostConfig','Mounts','NetworkSettings']}
def env(c):return dict(x.split('=',1) for x in c['Config']['Env'] if '=' in x)
def mounts(c):return {m['Destination']:{k:m.get(k) for k in ['Type','Source','Name','Destination','RW']} for m in c['Mounts']}
def owned_file(path):
    need(path.is_absolute() and path.resolve()==path and (ROOT in path.parents or path==LEGACY_COMPOSE),'SIM_ACTIVATION_COMPOSE_PATH')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid in {0,1000} and not s.st_mode&0o022 and s.st_size<=1048576,'SIM_ACTIVATION_COMPOSE_CUSTODY')
        raw=os.read(fd,1048577);need(len(raw)==s.st_size,'SIM_ACTIVATION_COMPOSE_CHANGED');return raw
    finally:os.close(fd)
def chain_from(containers):
    chains={}
    for service,c in containers.items():
        labels=c['Config']['Labels'];need(labels.get('com.docker.compose.project')=='sim' and labels.get('com.docker.compose.project.working_dir')==str(ROOT),'SIM_ACTIVATION_PROJECT')
        need(labels.get('com.docker.compose.project.environment_file','') in {'',str(ROOT/'.env')},'SIM_ACTIVATION_ENV_CHAIN')
        files=labels.get('com.docker.compose.project.config_files','').split(',');need(all(files),'SIM_ACTIVATION_COMPOSE_CHAIN')
        files=[Path(x) for x in files]
        if common.OVERLAY not in files:files.append(common.OVERLAY)
        need(len(files)==len(set(files)),'SIM_ACTIVATION_COMPOSE_CHAIN')
        chains[service]=files
    return chains
def receipt_config(receipt,plan):
    need(receipt.get('contractVersion')=='cop-sim-common-reset-fenced-v1' and receipt.get('resetEpoch')==plan['resetEpoch'] and receipt.get('servicesRestarted') is False and receipt.get('runtimeFlagsEnabled') is False and receipt.get('wholeAccountComplete') is False,'SIM_ACTIVATION_RESET_RECEIPT')
    need(receipt.get('completedPhases')==list(common.COMMON_PHASES)+['remaining','messaging_install','readback','sim_config'],'SIM_ACTIVATION_RESET_INCOMPLETE')
    cfg=receipt.get('simConfiguration',{})
    need(cfg.get('contractVersion')=='sim-clean-runtime-config-staged-v1' and cfg.get('intakeEnabled') is False and cfg.get('baseCleanEnabled') is False and cfg.get('servicesStarted') is False,'SIM_ACTIVATION_RESET_CONFIG')
    return cfg

OFFLINE=r'''import readline from 'node:readline';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const lines=readline.createInterface({input:process.stdin});const queue=[];let waiting;
lines.on('line',s=>{if(waiting){const r=waiting;waiting=undefined;r(s)}else queue.push(s)});
const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise(r=>waiting=r);
try{const p=JSON.parse(await next());const {Pool}=createRequire(p.pgPackage)('pg');
const {runSimUserInstall}=await import(pathToFileURL(p.module).href);
const assertStopped=async()=>{console.log(JSON.stringify({operation:'assert'}));if((JSON.parse(await next())).current!==true)throw Error('ACTIVATION_CUSTODY_LOST')};
const result=await runSimUserInstall({...p.config,phase:'readback'},{Pool,rootGate:{withResetAdmission(){throw Error('UNEXPECTED_RESET')}},assertWritersStopped:assertStopped});
console.log(JSON.stringify({operation:'result',value:result}));lines.close();
}catch{console.log(JSON.stringify({operation:'error',code:'SIM_ACTIVATION_SQL_UNAVAILABLE'}));process.exitCode=1;lines.close();}'''
CAPS=r'''let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',async()=>{try{const p=JSON.parse(raw);const out=[];
for(const x of p.checks){const r=await fetch(x.url,{headers:{authorization:'Bearer '+x.token},signal:AbortSignal.timeout(7000)});const b=await r.json();if(r.status!==200||b.contractVersion!==x.contract||b.component!==x.actualComponent||b.ready!==true||b.resetEpoch!==p.epoch||b.scope!=='cop_sim_shared_identity_v1'||b.wholeAccountComplete!==false||r.headers.get('cache-control')!=='no-store')throw Error('CAPS');
const no=await fetch(x.url,{signal:AbortSignal.timeout(7000)});if(no.status!==401)throw Error('AUTH');out.push({component:x.component,ready:true,unauthorizedStatus:401});}
if((await fetch('http://sim-web/api/v1/internal/sim-user-data/v1/capabilities',{signal:AbortSignal.timeout(7000)})).status!==404)throw Error('PUBLIC');
if((await fetch('http://sim-api:4000/api/v1/scenarios',{signal:AbortSignal.timeout(7000)})).status!==401)throw Error('OPERATOR');
console.log(JSON.stringify({checks:out,resetEpoch:p.epoch,privateWeb404:true,operatorUnauthorized401:true,wholeAccountComplete:false}));}catch{console.error('SIM_ACTIVATION_CAPABILITIES_FAILED');process.exitCode=1}});'''

class SimActivation:
    def __init__(self,receipt,private):
        need(os.getuid()==0 and socket.gethostname().split('.')[0]=='docker','SIM_ACTIVATION_ROOT_REQUIRED')
        self.fd=None;self.new={};self.started=False;self.ready=None;self.receipt_input=receipt;self.private=private
        self.raw_plan=common.protected(common.PLAN,modes=(0o600,));self.plan=json.loads(self.raw_plan)
        controller=common.load_sealed(self.plan['sources']['cop'],'scripts/account-safety/clean-reset-controller.py','activation_root_controller');self.host=controller.host
        self.plan=self.host.validate_plan(self.plan);self.cfg=receipt_config(receipt,self.plan)
        rel='scripts/activate-clean-sim.py';sim=self.plan['sources']['sim']
        need(rel in sim['files'] and Path(__file__).resolve()==Path(sim['root'])/rel and sha(common.protected(Path(__file__)))==sim['files'][rel],'SIM_ACTIVATION_SELF_SOURCE')
        self.proof=self.host._acceptance_module().validate_for_plan(self.plan)
        need(self.proof['reportSha256']==receipt['preStopReportSha256'],'SIM_ACTIVATION_PROOF_CHANGED')
        need(private['resetEpoch']==self.plan['resetEpoch'] and private['tokensNotBefore']==self.plan['tokensNotBefore'],'SIM_ACTIVATION_EPOCH')
    def acquire(self):
        need(self.fd is None,'SIM_ACTIVATION_ALREADY_OPEN');self.fd=os.open(LOCK,os.O_WRONLY|os.O_APPEND|os.O_NOFOLLOW)
        fcntl.flock(self.fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.env_raw,_=common.read_environment();self.cop_raw,_=common.read_environment(COP_ENV)
        need(sha(self.env_raw)==self.cfg['environmentSha256'] and sha(owned_file(common.OVERLAY))==self.cfg['overlaySha256'],'SIM_ACTIVATION_CONFIG_CHANGED')
        need(common.selected_values(self.cop_raw,{'COP_ACCOUNT_ERASURE_ENABLED'}).get('COP_ACCOUNT_ERASURE_ENABLED','false')=='false','SIM_ACTIVATION_GLOBAL_ENABLED')
        self.before={s:inspect(n) for s,(n,_)in SERVICES.items()}
        for s,c in self.before.items():
            need(c['Config']['Labels'].get('com.docker.compose.service')==s,'SIM_ACTIVATION_SERVICE_CHANGED')
            if s!='sim-web':
                expected=self.plan['localWriters'][SERVICES[s][0]];need(c['Id']==expected['id'] and c['Image']==expected['image'] and not c['State']['Running'] and not c['State']['Restarting'],'SIM_ACTIVATION_WRITER_NOT_FENCED')
        self.files=chain_from(self.before);self.file_raw={str(p):owned_file(p) for chain in self.files.values()for p in chain}
        self.assert_current()
    def assert_current(self):
        need(self.fd is not None,'SIM_ACTIVATION_CLOSED');s=os.fstat(self.fd);actual=LOCK.stat();expected=self.plan['operationLockMetadata']
        need((s.st_dev,s.st_ino)==(actual.st_dev,actual.st_ino)==(expected['device'],expected['inode']) and s.st_uid==expected['uid'] and s.st_gid==expected['gid'] and stat.S_IMODE(s.st_mode)==expected['mode'] and s.st_nlink==1,'SIM_ACTIVATION_LOCK_CHANGED')
        need(common.protected(common.PLAN,modes=(0o600,))==self.raw_plan and self.host._acceptance_module().validate_for_plan(self.plan)['reportSha256']==self.proof['reportSha256'],'SIM_ACTIVATION_PLAN_CHANGED')
        for source in self.plan['sources'].values():
            for leaf,digest in source['files'].items():need(sha(common.protected(Path(source['root'])/leaf))==digest,'SIM_ACTIVATION_SOURCE_CHANGED')
        need(run(['/usr/bin/findmnt','-n','-o','UUID','--mountpoint','/srv/x5-production']).decode().strip()=='2f93f595-b61b-4eea-9054-7afa9b275b5b','SIM_ACTIVATION_X5_CHANGED')
        x5=Path('/srv/x5-production');need(x5.resolve()==x5 and x5.stat().st_dev!=Path('/').stat().st_dev,'SIM_ACTIVATION_X5_CHANGED')
        need(common.read_environment()[0]==self.env_raw and common.read_environment(COP_ENV)[0]==self.cop_raw,'SIM_ACTIVATION_ENV_CHANGED')
        for path,raw in self.file_raw.items():need(owned_file(Path(path))==raw,'SIM_ACTIVATION_COMPOSE_CHANGED')
        sim_names={pair[0] for pair in SERVICES.values()}
        for name,binding in self.plan['localWriters'].items():
            if name in sim_names:continue
            c=inspect(name);need(c['Id']==binding['id'] and c['Image']==binding['image'] and not c['State']['Running'] and not c['State']['Restarting'],'SIM_ACTIVATION_OTHER_WRITER_CHANGED')
        for service,before in self.before.items():
            current=inspect(SERVICES[service][0]);expected=self.new.get(service,before)
            need(spec(current)==spec(expected),'SIM_ACTIVATION_CONTAINER_CHANGED')
            if service in self.new:need(current['State']['Running'] and not current['State']['Restarting'],'SIM_ACTIVATION_SERVICE_UNAVAILABLE')
            elif service!='sim-web':need(not current['State']['Running'] and not current['State']['Restarting'],'SIM_ACTIVATION_WRITER_NOT_FENCED')
    def offline_guard_readback(self):
        self.assert_current();need(not self.new,'SIM_ACTIVATION_ALREADY_STARTED')
        runtime=Path(self.plan['operatorRuntime']['root'])/'runtime';r=self.plan['operatorRuntime']
        for leaf,key in [('usr/local/bin/node','nodeSha256'),('lib/ld-musl-x86_64.so.1','loaderSha256')]:need(sha(common.protected(runtime/leaf,limit=200*1024*1024))==r[key],'SIM_ACTIVATION_NODE_CHANGED')
        args=[str(runtime/'lib/ld-musl-x86_64.so.1'),'--library-path',str(runtime/'lib')+':'+str(runtime/'usr/lib'),str(runtime/'usr/local/bin/node'),'--input-type=module','-e',OFFLINE]
        p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env={'PATH':'/usr/bin:/bin','LANG':'C'})
        payload={'pgPackage':str(Path(self.plan['sources']['cop']['root'])/'apps/cop-api/package.json'),'module':str(Path(self.plan['sources']['sim']['root'])/'scripts/lib/sim-user-data-private-install.mjs'),'config':self.private['simUserInstall']}
        try:
            # The pinned migration verifier compares the frozen manifest's JSON
            # key order too. Preserve input order here; canonical() is for hashes.
            p.stdin.write(json.dumps(payload,separators=(',',':')).encode()+b'\n');p.stdin.flush();deadline=time.monotonic()+120
            while True:
                need(time.monotonic()<deadline,'SIM_ACTIVATION_SQL_TIMEOUT');ready,_,_=select.select([p.stdout],[],[],5)
                self.assert_current()
                if not ready:continue
                line=p.stdout.readline(1048577);need(line and len(line)<=1048576,'SIM_ACTIVATION_SQL_CLOSED');message=json.loads(line)
                if message=={'operation':'assert'}:self.assert_current();p.stdin.write(b'{"current":true}\n');p.stdin.flush()
                else:
                    need(message.get('operation')=='result','SIM_ACTIVATION_SQL_UNAVAILABLE');result=message['value'];need(result['contractVersion']=='sim-user-private-install-readback-v1' and result['resetEpoch']==self.plan['resetEpoch'] and set(result['components'])=={'sim_user_data','sim_user_history'} and all(x['actualRestrictedAuthority'] is True and x['unused'] is True for x in result['components'].values()),'SIM_ACTIVATION_SQL_UNAVAILABLE');break
            p.stdin.close();need(p.wait(timeout=10)==0,'SIM_ACTIVATION_SQL_UNAVAILABLE');self.offline=True;return result
        finally:
            if p.poll()is None:p.kill();p.wait(timeout=10)
    def stage_composition(self):
        self.assert_current();need(getattr(self,'offline',False) and not self.new,'SIM_ACTIVATION_SQL_NOT_CHECKED')
        values=common.selected_values(self.env_raw,FLAGS|{'AI_ROUTER_ACCOUNT_ERASURE_ENABLED','DRIVER_ACCOUNT_ERASURE_ENABLED'})
        need(all(values.get(k)=='false' for k in FLAGS) and all(values.get(k,'false')=='false' for k in ['AI_ROUTER_ACCOUNT_ERASURE_ENABLED','DRIVER_ACCOUNT_ERASURE_ENABLED']),'SIM_ACTIVATION_FLAGS_CHANGED')
        after=common.render_environment(self.env_raw,{k:'true' for k in FLAGS});_,s=common.read_environment()
        # Replacement uses the same real activation custody, not reset authority.
        old=self.env_raw
        # replace_file's post-write custody must see the new expected bytes.
        class WriteAdmission:
            def assert_current(inner):
                actual=common.read_environment()[0]
                need(actual in {old,after},'SIM_ACTIVATION_ENV_CHANGED');self.env_raw=actual;self.assert_current()
        common.replace_file(common.SIM_ENV,after,s.st_uid,s.st_gid,0o600,WriteAdmission(),old)
        self.env_raw=after;self.staged=True;self.assert_current()
    def compose_args(self,service):
        args=['/usr/bin/docker','compose','--project-directory',str(ROOT),'--env-file',str(common.SIM_ENV)]
        for p in self.files[service]:args+=['-f',str(p)]
        return args
    def compose_image_pins(self):
        images=self.plan['candidateImages']
        return {'SIM_ERASURE_ROUTER_IMAGE':images['ai_router'],'SIM_ERASURE_DRIVER_IMAGE':images['situation_data'],'DRIVER_MEASUREMENTS_IMAGE':images['situation_data']}
    def up_services(self):
        self.assert_current();need(getattr(self,'staged',False) and not self.new,'SIM_ACTIVATION_NOT_STAGED')
        effective={service:json.loads(run(self.compose_args(service)+['--profile','*','config','--format','json'],compose_images=self.compose_image_pins()))['services'][service]for service in SERVICES}
        for service,(_,key)in SERVICES.items():
            c=effective[service];need(c['image']==self.plan['candidateImages'][key],'SIM_ACTIVATION_IMAGE_CHANGED')
            before=env(self.before[service]);values=c.get('environment',{})
            for k in FEATURES&before.keys():need(k in values and str(values[k])==before[k],'SIM_ACTIVATION_FEATURE_CHANGED')
        for service in ['ai-router-api','situation-data-api','sim-api','sim-web']:
            # Bind each completed transition before authorizing the next one.
            # A failed/timed-out command may still have created its own CID.
            self.assert_current();failed=False
            try:
                p=subprocess.run(self.compose_args(service)+['up','-d','--no-build','--no-deps','--pull','never',service],capture_output=True,timeout=180,env=compose_environment(self.compose_image_pins()))
                failed=p.returncode!=0
            except (subprocess.TimeoutExpired,OSError):failed=True
            name,key=SERVICES[service]
            try:
                c=inspect(name);need(c['Id']!=self.before[service]['Id'] and c['Image']==self.plan['candidateImages'][key] and c['Config']['Labels'].get('com.docker.compose.project')=='sim' and c['Config']['Labels'].get('com.docker.compose.service')==service,'SIM_ACTIVATION_NEW_CID_CHANGED')
                # Claim only this exact candidate identity. Never adopt an old or
                # foreign image for failure cleanup, even after partial up.
                self.new[service]=c
                need(set(c['NetworkSettings']['Networks'])==set(self.before[service]['NetworkSettings']['Networks']),'SIM_ACTIVATION_NETWORK_CHANGED')
                old=mounts(self.before[service]);new=mounts(c);ca='/etc/csm-sim/postgresql-ca.pem'
                if service in {'sim-api','ai-router-api'}:
                    need(new.get(ca,{}).get('Source')=='/etc/vcode-cop-pgbouncer/postgres-ca.crt' and new[ca]['RW'] is False,'SIM_ACTIVATION_CA_MOUNT');new.pop(ca);old.pop(ca,None)
                need(old==new,'SIM_ACTIVATION_MOUNTS_CHANGED')
            except (RuntimeError,KeyError,subprocess.SubprocessError):raise RuntimeError('SIM_ACTIVATION_UP_FAILED') from None
            need(not failed,'SIM_ACTIVATION_UP_FAILED')
            self.assert_current()
        self.started=True;self.assert_current()
    def verify_capabilities(self):
        self.assert_current();need(self.started,'SIM_ACTIVATION_NOT_STARTED')
        values=common.selected_values(self.env_raw,{'SIM_USER_DATA_COP_TOKEN','AI_ROUTER_COP_TOKEN','AI_ROUTER_SIM_TOKEN','DRIVER_MEASUREMENTS_COP_TOKEN'})
        checks=[('main','http://sim-api:4000/api/v1/internal/sim-user-data/v1/capabilities','SIM_USER_DATA_COP_TOKEN'),('router','http://ai-router-api:4050/api/v1/ai-router/internal/user-lifecycle/v1/capabilities','AI_ROUTER_COP_TOKEN'),('history','http://ai-router-api:4050/api/v1/ai-router/internal/sim-user-history/v1/capabilities','AI_ROUTER_SIM_TOKEN'),('driver','http://127.0.0.1:4020/api/v1/internal/user-lifecycle/v1/capabilities','DRIVER_MEASUREMENTS_COP_TOKEN'),('relay','http://127.0.0.1:4020/api/v1/internal/sim-user-data/v1/capabilities','SIM_USER_DATA_COP_TOKEN')]
        components={'main':'sim_user_data','router':'ai','history':'sim_router_history','driver':'driver','relay':'sim_user_data'}
        payload={'epoch':self.plan['resetEpoch'],'checks':[{'component':name,'url':url,'token':values[key],'contract':'cop-sim-user-lifecycle-v1' if name in {'router','driver'} else 'cop-sim-user-data-v1','actualComponent':components[name]} for name,url,key in checks]}
        deadline=time.monotonic()+90
        while True:
            states=[inspect(c['Id'])['State'].get('Health',{}).get('Status')for c in self.new.values()]
            need(all(x in {'healthy','starting'} for x in states),'SIM_ACTIVATION_HEALTH_UNAVAILABLE')
            if any(x!='healthy' for x in states):
                self.assert_current();need(time.monotonic()<deadline,'SIM_ACTIVATION_HEALTH_TIMEOUT');time.sleep(.5);continue
            r=subprocess.run(['/usr/bin/docker','exec','-i',self.new['situation-data-api']['Id'],'node','-e',CAPS],input=canonical(payload),capture_output=True,timeout=80,env={'PATH':'/usr/bin:/bin','LANG':'C','DOCKER_HOST':'unix:///var/run/docker.sock'})
            self.assert_current()
            if r.returncode==0:break
            need(time.monotonic()<deadline,'SIM_ACTIVATION_CAPABILITIES_FAILED');time.sleep(.5)
        result=json.loads(r.stdout);need(result['resetEpoch']==self.plan['resetEpoch'] and len(result['checks'])==5 and result.get('privateWeb404') is True and result.get('operatorUnauthorized401') is True and all(x['ready'] and x['unauthorizedStatus']==401 for x in result['checks']),'SIM_ACTIVATION_CAPABILITIES_FAILED')
        self.ready=result;return result
    def receipt(self):
        self.assert_current();need(self.ready is not None,'SIM_ACTIVATION_NOT_READY')
        return {'contractVersion':'sim-composition-activation-v1','stage':'guard-ready-awaiting-cop-canary','resetEpoch':self.plan['resetEpoch'],'preStopReportSha256':self.proof['reportSha256'],'environmentSha256':sha(self.env_raw),'overlaySha256':sha(self.file_raw[str(common.OVERLAY)]),'containers':{s:{'id':c['Id'],'image':c['Image'],'specSha256':sha(canonical(spec(c)))}for s,c in self.new.items()},'guardReadiness':self.ready,'globalCopFlagsChanged':False,'wholeAccountComplete':False}
    def close(self,failed=False):
        try:
            if failed:
                errors=[]
                for c in self.new.values():
                    try:
                        actual=inspect(c['Id']);need(spec(actual)==spec(c),'SIM_ACTIVATION_CLEANUP_CID_CHANGED');run(['/usr/bin/docker','stop','--time','15',c['Id']],timeout=25)
                    except (RuntimeError,subprocess.SubprocessError):errors.append(c['Id'])
                need(not errors,'SIM_ACTIVATION_CLEANUP_CID_CHANGED')
        finally:
            if self.fd is not None:os.close(self.fd);self.fd=None

@contextmanager
def begin_sim_activation(reset_receipt,private_config):
    value=SimActivation(reset_receipt,private_config)
    try:
        value.acquire();yield value
    except BaseException:
        value.close(failed=True);raise
    else:value.close()
