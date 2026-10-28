#!/usr/bin/env python3
"""Finite Root BUILD-ONLY candidate; not installed and no host GO implied.
Direct exec targets an existing exact worker CID; no buildx/bootstrap/create.
No app up, Compose pin/profile, application DB, credentials, prune or retries.
"""
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import time
import types
sys.dont_write_bytecode=True
ROOT=Path('/var/lib/csm-sim-maintenance')
SOURCE=ROOT/'build-source'
DOCKER=['/usr/bin/docker','--host','unix:///var/run/docker.sock']
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C','DOCKER_HOST':'unix:///var/run/docker.sock'}
BASE='sha256:4076069b3f8c935c0cd07ea2bf95d92703270b72197ff2b74a27d1aee8c6bdf0'
BASE_SIZE=203231596
WORKER_IMAGE='sha256:27933730df224df80c41f4e5a9b33fa78831a79fd31903df3bb7deb49363422f'
WORKER_REF='moby/buildkit@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea'
WORKER_NAME='buildx_buildkit_cop-x50'
WORKER_VOLUME='buildx_buildkit_cop-x50_state'
STATE=Path('/srv/x5-production/cache/cop/buildkit')
UUID='2f93f595-b61b-4eea-9054-7afa9b275b5b'
CLIENT_SHA='7809f0f3e4a85c880b929fa618668048a48bb23d251799f9960150ce9a8d5017'
TIMEOUT_SHA='f3547b3d78d08a028a4833ddb83b77cf012838c078bfd2b76355f53d1d8bba62'
DEFINITION_SHA='6a2db56a15a215a6e60e2d6156d9044ea314f309bd59727c5c86219796b44ae3'
CONTEXT_SHA='2c7ab57960af4e954784c49ed55de73e9085699c0fdb068f3574ecb217807cf3'
CONTROLLER_SHA='9afce0c0ce37118a81e72d5f2cab8312d3820ec5801b23c826fcf51302f59301'
FILES={'Dockerfile':'8f75ba8095d38d3ac4e696fd8ce956b9852345d5bef73fcd9ea846a6b3b29c3c',
 'apps/simulator-api/dist/user-data.js':'e78d951eb538f4962542c28c8436db45713ff3ba7588d8d2c98a0f4f34ab72bd',
 'packages/sim-user-data/bootstrap.mjs':'c1b44b61e7ac7902463f1d68c6fec74dccf3550b4a3d95d02544788436d11d05',
 'packages/sim-user-data/pg-errors.mjs':'af3c90eec2a0702e434feb57cd7607a8d7fb7c84c8f1d10c8084b7d13b16b2fc'}
PHASE='admission'
REMOTE_UNKNOWN=False
PIPELINE_TIMEOUT=330
class Stop(Exception):pass
def need(value,code='SIM_BUILD_ONLY_REJECTED'):
 if not value:raise Stop(code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def encoded(value):return (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
def digest(value):return sha(encoded(value))
def stable(s):return (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_mode,s.st_uid,s.st_gid,s.st_nlink)
def protected(path):
 need(path.is_absolute() and not any(p.is_symlink() for p in [path,*path.parents]))
 for p in path.parents:
  s=p.stat();need(s.st_uid==0 and stat.S_ISDIR(s.st_mode) and not s.st_mode&0o022)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,'rb') as stream:
  before=os.fstat(stream.fileno());need(stat.S_ISREG(before.st_mode) and before.st_uid==0 and before.st_nlink==1 and stat.S_IMODE(before.st_mode)==0o600 and before.st_size<=1048576)
  raw=stream.read(1048577);need(len(raw)==before.st_size and stable(os.fstat(stream.fileno()))==stable(before) and path.stat().st_ino==before.st_ino)
  return raw
def stop_process(p):
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
def run(args,timeout=30,limit=4194304):
 p=subprocess.Popen(args,env=ENV,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,bufsize=0);deadline=time.monotonic()+timeout;out=[];size=0;errors=0;streams=[p.stdout,p.stderr]
 try:
  while streams:
   remaining=deadline-time.monotonic();need(remaining>0,'BUILD_READ_DEADLINE')
   ready,_,_=select.select(streams,[],[],remaining);need(ready,'BUILD_READ_DEADLINE')
   for stream in ready:
    raw=os.read(stream.fileno(),65536)
    if not raw:streams.remove(stream);continue
    if stream is p.stdout:size+=len(raw);need(size<=limit,'BUILD_READ_BYTE_LIMIT');out.append(raw)
    else:errors+=len(raw);need(errors<=1048576,'BUILD_READ_BYTE_LIMIT')
  need(p.wait(timeout=max(.01,deadline-time.monotonic()))==0,'BUILD_COMMAND_FAILED')
  return b''.join(out)
 finally:stop_process(p);p.stdout.close();p.stderr.close()
def inspect(name):return json.loads(run(DOCKER+['inspect',name]))[0]
def app_identity():
 c=inspect('csm-sim-api');need(c['Image']==BASE and c['State']['Running'] and c['State']['Health']['Status']=='healthy')
 result={k:c[k] for k in ['Id','Image','RestartCount','Config','HostConfig','Mounts']}
 result['process']={k:c['State'][k] for k in ['Running','StartedAt','Pid']};result['healthy']=True
 return result
def age(go):
 now=time.time();need(type(go['createdAt']) is int and type(go['expiresAt']) is int and 0<go['expiresAt']-go['createdAt']<=900 and go['createdAt']<=now<go['expiresAt'],'BUILD_GO_EXPIRED')
 need(all(type(go[k]) is int and 0<=now-go[k]<=60 for k in ['capacityReviewedAt','buildIdleReviewedAt']),'BUILD_OWNER_REVIEW_EXPIRED')
def admission():
 raw=protected(ROOT/'build-go.json');go=json.loads(raw)
 expected={'contract','releaseId','createdAt','expiresAt','capacityReviewedAt','buildIdleReviewedAt','workerCid','workerStartedAt','workerRestartCount','workerStateDigest','sourceHashes','dockerBinarySha256','copOwnerAckEvidenceSha256','storageCloseoutEvidenceSha256'}
 need(set(go)==expected and go['contract']=='sim-pg-build-only-go-v1')
 need(re.fullmatch('[0-9a-f]{32}',go['releaseId']) and re.fullmatch('[0-9a-f]{64}',go['workerCid']))
 need(set(go['sourceHashes'])=={'build-sim-pg-maintenance-oci.py','sim-pg-base-oci.py','sim-pg-disconnect-maintain.py'})
 for name,value in go['sourceHashes'].items():need(re.fullmatch('[0-9a-f]{64}',value) and sha(protected(SOURCE/name))==value)
 need(go['sourceHashes']['sim-pg-disconnect-maintain.py']==CONTROLLER_SHA)
 for field in ['copOwnerAckEvidenceSha256','storageCloseoutEvidenceSha256']:need(re.fullmatch('[0-9a-f]{64}',go[field]))
 need(sha(protected(ROOT/'cop-worker-owner-ack.json'))==go['copOwnerAckEvidenceSha256'] and sha(protected(ROOT/'storage-closeout.json'))==go['storageCloseoutEvidenceSha256'])
 # This private Root GO and its evidence custody are operator authority; no
 # caller-supplied facts/boolean/callback is accepted as admission.
 age(go);return go,raw
def client(cid,*args):return DOCKER+['exec',cid,'/usr/bin/buildctl','--addr','unix:///run/buildkit/buildkitd.sock','--timeout','5',*args]
def histories_idle(raw):
 rows=[json.loads(line) for line in raw.decode().splitlines() if line];need(len(rows)<=10000)
 for row in rows:
  need(isinstance(row,dict) and set(row)<={'record','type'} and row.get('type')==1 and isinstance(row.get('record'),dict),'BUILD_HISTORY_SCHEMA')
  pair=[]
  for key in ['CreatedAt','CompletedAt']:
   value=row['record'].get(key);need(isinstance(value,dict) and set(value)<={'seconds','nanos'} and type(value.get('seconds')) is int and value['seconds']>0 and type(value.get('nanos',0)) is int and 0<=value.get('nanos',0)<1000000000,'BUILD_WORKER_NOT_IDLE');pair.append((value['seconds'],value.get('nanos',0)))
  need(pair[0]<=pair[1] and pair[1][0]<=time.time()+30,'BUILD_WORKER_NOT_IDLE')
 return True
def worker(go,require_idle=True):
 c=inspect(go['workerCid']);need(c['Id']==go['workerCid'] and c['Name']=='/'+WORKER_NAME and c['Image']==WORKER_IMAGE and c['State']['Running'] is True and c['State']['StartedAt']==go['workerStartedAt'] and c['RestartCount']==go['workerRestartCount']==0,'BUILD_WORKER_IDENTITY')
 need(digest({k:c[k] for k in ['Config','HostConfig','Mounts']})==go['workerStateDigest'],'BUILD_WORKER_PROFILE')
 cached=json.loads(run(DOCKER+['image','inspect',WORKER_IMAGE]))[0]
 need(cached['Id']==WORKER_IMAGE and WORKER_REF in (cached.get('RepoDigests') or []),'BUILD_CACHED_WORKER_IMAGE')
 mounts=[v for v in c['Mounts'] if v['Destination']=='/var/lib/buildkit'];need(len(mounts)==1 and mounts[0].get('Name')==WORKER_VOLUME,'BUILD_WORKER_MOUNT')
 need(not any(Path(binary).is_relative_to(v['Destination']) for binary in ['/usr/bin/buildctl','/usr/bin/timeout'] for v in c['Mounts']),'BUILD_CLIENT_MOUNT')
 volume=json.loads(run(DOCKER+['volume','inspect',WORKER_VOLUME]))[0]
 need(volume['Driver']=='local' and volume['Options']=={'type':'none','o':'bind','device':str(STATE)},'BUILD_WORKER_VOLUME')
 need(os.stat(volume['Mountpoint']).st_dev==STATE.stat().st_dev and os.stat(volume['Mountpoint']).st_ino==STATE.stat().st_ino,'BUILD_VOLUME_PHYSICAL_BIND')
 need(mounts[0]['Source']==volume['Mountpoint'],'BUILD_WORKER_VOLUME_SOURCE')
 need(run(DOCKER+['exec',go['workerCid'],'sha256sum','/usr/bin/buildctl']).decode().split()[0]==CLIENT_SHA,'BUILD_CLIENT_BYTES')
 need(run(DOCKER+['exec',go['workerCid'],'sha256sum','/usr/bin/timeout']).decode().split()[0]==TIMEOUT_SHA,'BUILD_TIMEOUT_BYTES')
 need(run(client(go['workerCid'],'--version')).decode().strip()=='buildctl github.com/moby/buildkit v0.33.1 8c91502cf280bd70a0c50912ce251c46a8881d9f','BUILD_CLIENT_VERSION')
 for line in run(DOCKER+['diff',go['workerCid']]).decode().splitlines():
  change,path=line.split(' ',1);need(path not in {'/usr','/usr/bin','/usr/bin/buildctl','/usr/bin/timeout'},'BUILD_CLIENT_WRITABLE_DIFF')
 definition=Path('/home/voldzi/.docker/buildx/instances/cop-x5');need(not definition.is_symlink() and definition.stat().st_uid==1000 and sha(definition.read_bytes())==DEFINITION_SHA,'BUILD_DEFINITION_PROVENANCE')
 if require_idle:histories_idle(run(client(go['workerCid'],'debug','histories','--format','{{json .}}')))
 return c
def capacity(extra=0):
 need(run(['/usr/bin/findmnt','-n','-o','UUID','--mountpoint','/srv/x5-production']).decode().strip()==UUID,'BUILD_X5_UUID')
 need(not any(p.is_symlink() for p in [STATE,*STATE.parents]) and STATE.stat().st_dev==Path('/srv/x5-production').stat().st_dev!=Path('/').stat().st_dev,'BUILD_X5_DEVICE')
 need(shutil.disk_usage('/').free>=2*1024**3+extra and shutil.disk_usage(STATE).free>=10*1024**3+extra,'BUILD_DISK_RESERVE')
def source_policy():
 return {'version':1,'rules':[{'action':1,'selector':{'identifier':scheme,'match_type':0}} for scheme in ['docker-image://*','http://*','https://*','git://*']]}
def build_argv(cid,inside,digest_value,tag):
 need(re.fullmatch('[0-9a-f]{64}',cid) and re.fullmatch('sha256:[0-9a-f]{64}',digest_value) and re.fullmatch('csm-sim-pg-observer:root-[0-9a-f]{32}',tag))
 need(re.fullmatch('/var/lib/buildkit/sim-pg-maintenance-[0-9a-f]{32}',inside))
 return DOCKER+['exec','--env','DOCKER_CONFIG='+inside+'/empty-config','--env','HOME='+inside+'/empty-config',cid,
  '/usr/bin/timeout','-k','15','-s','TERM','300','/usr/bin/buildctl','--addr','unix:///run/buildkit/buildkitd.sock','--timeout','5','build','--frontend','dockerfile.v0',
  '--local','context='+inside+'/context','--local','dockerfile='+inside+'/context','--oci-layout','simbase='+inside+'/base-oci',
  '--opt','context:sim_reviewed_base=oci-layout://simbase@'+digest_value,'--opt','filename=Dockerfile','--opt','platform=linux/amd64',
  '--opt','force-network-mode=none','--source-policy-file',inside+'/source-policy.json',
  '--output','type=docker,name='+tag+',compression=uncompressed']
def context_files(raw):
 need(sha(raw)==CONTEXT_SHA and len(raw)==40960,'BUILD_CONTEXT_BYTES');files={}
 with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
  need(not archive.pax_headers)
  for member in archive:
   need(member.name in FILES and member.name not in files and member.type==tarfile.REGTYPE and not member.pax_headers and member.offset_data==member.offset+512 and member.uid==member.gid==member.mtime==0 and member.mode==0o644)
   payload=archive.extractfile(member).read();need(sha(payload)==FILES[member.name]);files[member.name]=payload
 need(set(files)==set(FILES));return files
def write_file(path,data,mode=0o600,mtime=None):
 fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,mode)
 with os.fdopen(fd,'wb') as out:os.fchmod(out.fileno(),mode);os.fchown(out.fileno(),0,0);out.write(data);out.flush();os.fsync(out.fileno())
 if mtime is not None:os.utime(path,(mtime,mtime),follow_symlinks=False)
 directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(directory)
 finally:os.close(directory)
def job_inputs(job):
 directories=[job/'context',*[p for p in (job/'context').rglob('*') if p.is_dir()]]
 need({str(p.relative_to(job/'context')) for p in directories}=={str(p) for f in FILES for p in Path(f).parents},'BUILD_CONTEXT_DIRECTORY_DRIFT')
 for directory in directories:
  s=directory.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o755 and s.st_mtime_ns==0,'BUILD_CONTEXT_DIRECTORY_DRIFT')
 files=[p for p in (job/'context').rglob('*') if p.is_file() or p.is_symlink()]
 need({str(p.relative_to(job/'context')) for p in files}==set(FILES),'BUILD_CONTEXT_DRIFT')
 for p in files:
  s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_uid==s.st_gid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o644 and s.st_mtime_ns==0 and sha(p.read_bytes())==FILES[str(p.relative_to(job/'context'))],'BUILD_CONTEXT_DRIFT')
 need((job/'source-policy.json').read_bytes()==encoded(source_policy()) and (job/'empty-config/config.json').read_bytes()==b'{}','BUILD_POLICY_OR_EMPTY_AUTH_DRIFT')
def oci_inputs(job,result):
 layout=job/'base-oci';need((layout/'oci-layout').read_bytes()==b'{"imageLayoutVersion":"1.0.0"}','BUILD_OCI_LAYOUT_DRIFT');raw=(layout/'index.json').read_bytes();index=json.loads(raw)
 need(index=={'schemaVersion':2,'manifests':[{'mediaType':'application/vnd.oci.image.manifest.v1+json','digest':result['ociManifestDigest'],'size':(layout/'blobs/sha256'/result['ociManifestDigest'][7:]).stat().st_size,'platform':{'architecture':'amd64','os':'linux'}}]},'BUILD_OCI_INDEX_DRIFT')
 manifest_raw=(layout/'blobs/sha256'/result['ociManifestDigest'][7:]).read_bytes();need('sha256:'+sha(manifest_raw)==result['ociManifestDigest'])
 manifest=json.loads(manifest_raw);need(manifest['config']['digest']==BASE and len(manifest['layers'])==14)
 expected={v['digest'][7:] for v in [manifest['config'],*manifest['layers']]}|{result['ociManifestDigest'][7:]}
 need({p.name for p in (layout/'blobs/sha256').iterdir()}==expected,'BUILD_OCI_BLOBS_DRIFT')
 for name in expected:
  p=layout/'blobs/sha256'/name;s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600)
  h=hashlib.sha256()
  with p.open('rb') as blob:
   while True:
    chunk=blob.read(65536)
    if not chunk:break
    h.update(chunk)
  need(h.hexdigest()==name,'BUILD_OCI_BLOB_BYTES')
def load_source(name,raw):
 module=types.ModuleType('reviewed_'+name.replace('-','_'));exec(compile(raw,name,'exec'),module.__dict__);return module
def pipeline(args):
 """Bounded direct-client stdout → docker load. Failure is UNKNOWN remotely.
 Killing this host exec client is never represented as canceling remote solve.
 """
 global REMOTE_UNKNOWN
 capacity();producer=subprocess.Popen(args,env=ENV,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,bufsize=0);REMOTE_UNKNOWN=True
 consumer=None;deadline=time.monotonic()+PIPELINE_TIMEOUT;pending=b'';total=0;logs=0;watched=[];eof=False;last_space=0
 try:
  consumer=subprocess.Popen(DOCKER+['image','load'],env=ENV,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,bufsize=0)
  os.set_blocking(consumer.stdin.fileno(),False)
  watched=[producer.stdout,producer.stderr,consumer.stdout,consumer.stderr]
  while watched or pending:
   remaining=deadline-time.monotonic();need(remaining>0,'BUILD_PIPELINE_TIMEOUT_REMOTE_UNKNOWN')
   if time.monotonic()-last_space>.5:capacity();last_space=time.monotonic()
   reads=[p for p in watched if p is not producer.stdout or len(pending)<65536]
   ready,writable,_=select.select(reads,[consumer.stdin] if pending else [],[],min(remaining,1))
   for stream in ready:
    raw=os.read(stream.fileno(),65536)
    if not raw:
     watched.remove(stream)
     if stream is producer.stdout:eof=True
     continue
    if stream is producer.stdout:pending+=raw;total+=len(raw);need(total<=2*(BASE_SIZE+6291456)+16777216,'BUILD_CANDIDATE_STREAM_BUDGET')
    else:logs+=len(raw);need(logs<=1048576,'BUILD_LOG_BUDGET')
   if writable and pending:
    try:written=os.write(consumer.stdin.fileno(),pending);pending=pending[written:]
    except BlockingIOError:pass
   if eof and not pending and consumer.stdin is not None:consumer.stdin.close();consumer.stdin=None
  need(producer.wait(timeout=max(.01,deadline-time.monotonic()))==0 and consumer.wait(timeout=max(.01,deadline-time.monotonic()))==0,'BUILD_EXPORT_OR_LOAD_FAILED_REMOTE_UNKNOWN')
  REMOTE_UNKNOWN=False
  return total
 finally:
  stop_process(producer)
  if consumer:stop_process(consumer)
  for stream in [producer.stdout,producer.stderr,*([consumer.stdin,consumer.stdout,consumer.stderr] if consumer else [])]:
   if stream is not None:stream.close()
def main():
 global PHASE
 need(os.geteuid()==0 and socket.gethostname().split('.')[0]=='docker' and sys.argv[1:]==['--build-only'] and Path(__file__)==SOURCE/'build-sim-pg-maintenance-oci.py' and not os.environ.get('PYTHONPATH') and not os.environ.get('PYTHONHOME'),'BUILD_FIXED_OPERATION')
 go,go_raw=admission();need(sha(Path('/usr/bin/docker').read_bytes())==go['dockerBinarySha256'],'BUILD_DOCKER_BYTES')
 need(sha(protected(SOURCE/'build-sim-pg-maintenance-oci.py'))==go['sourceHashes']['build-sim-pg-maintenance-oci.py'])
 control=load_source('controller',protected(SOURCE/'sim-pg-disconnect-maintain.py'));convert=load_source('converter',protected(SOURCE/'sim-pg-base-oci.py'))
 need(shutil.which('docker',path=control.ENV['PATH'])=='/usr/bin/docker','BUILD_GATE_DOCKER_RESOLUTION')
 lock=os.open(ROOT/'cop-sim-build.lock',os.O_CREAT|os.O_NOFOLLOW|os.O_RDWR,0o600)
 try:
  s=os.fstat(lock);need(s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  capacity(4*BASE_SIZE+268435456);node=worker(go);before=app_identity();base=json.loads(run(DOCKER+['image','inspect',BASE]))[0]
  need(base['Id']==BASE and base['Size']==BASE_SIZE and base['Os']=='linux' and base['Architecture']=='amd64' and len(base['RootFS']['Layers'])==14 and not base['Config'].get('OnBuild'),'BUILD_BASE_ONBUILD_OR_SIZE')
  context=context_files(protected(ROOT/'build-input/build-context.tar'))
  tag='csm-sim-pg-observer:root-'+go['releaseId'];need(not run(DOCKER+['image','ls','--filter','reference='+tag,'--format','{{.ID}}']).strip(),'BUILD_TAG_ALREADY_EXISTS')
  need(admission()==(go,go_raw));age(go);PHASE='owned_job'
  job=STATE/('sim-pg-maintenance-'+go['releaseId']);job.mkdir(mode=0o700);inside='/var/lib/buildkit/'+job.name
  (job/'context').mkdir(mode=0o700);(job/'empty-config').mkdir(mode=0o700)
  write_file(job/'empty-config/config.json',b'{}');write_file(job/'source-policy.json',encoded(source_policy()))
  for relative,payload in context.items():
   path=job/'context'/relative;path.parent.mkdir(mode=0o700,parents=True,exist_ok=True);write_file(path,payload,0o644,0)
  # Only newly created context directories, protected by the enclosing 0700 job.
  # Canonical metadata applies to what buildctl actually sends, not only the tar.
  for directory in sorted([job/'context',*[p for p in (job/'context').rglob('*') if p.is_dir()]],key=lambda p:len(p.parts),reverse=True):
   need(not directory.is_symlink());os.chown(directory,0,0);os.chmod(directory,0o755);os.utime(directory,(0,0),follow_symlinks=False)
  PHASE='base_stream';worker(go);need(admission()==(go,go_raw));age(go)
  p=subprocess.Popen(DOCKER+['image','save',BASE],env=ENV,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True,bufsize=0)
  try:
   result=convert.convert_stream(control.DeadlineReader(p.stdout,time.monotonic()+120),job/'base-oci',base)
   need(p.wait(timeout=5)==0,'BUILD_BASE_EXPORT_FAILED')
  finally:stop_process(p);p.stdout.close()
  job_inputs(job);oci_inputs(job,result);capacity(2*BASE_SIZE+268435456);worker(go);need(app_identity()==before and admission()==(go,go_raw));age(go)
  PHASE='solve_export_load';count=pipeline(build_argv(go['workerCid'],inside,result['ociManifestDigest'],tag))
  PHASE='actual_image_gate';candidate=json.loads(run(DOCKER+['image','inspect',tag]))[0];need(re.fullmatch('sha256:[0-9a-f]{64}',candidate['Id']) and candidate['Id']!=BASE)
  control.image_gate(candidate['Id']);job_inputs(job);oci_inputs(job,result);capacity();worker(go);need(app_identity()==before,'BUILD_APP_CHANGED')
  need(protected(ROOT/'build-go.json')==go_raw and time.time()<go['expiresAt'],'BUILD_POST_GO_DRIFT_OR_EXPIRY')
  receipt={'contract':'sim-pg-build-only-complete-v1','candidateImage':candidate['Id'],'baseImage':BASE,'contextSha256':CONTEXT_SHA,'baseOciManifest':result['ociManifestDigest'],'workerCid':go['workerCid'],'sourceHashes':go['sourceHashes'],'goSha256':sha(go_raw),'streamBytes':count,'actualImageGatePassed':True,'applicationChanged':False,'releaseAuthorized':False}
  write_file(job/'complete.json',encoded(receipt));print(json.dumps(receipt))
 finally:os.close(lock)
if __name__=='__main__':
 try:main()
 except Exception:
  print(json.dumps({'status':'stopped_requires_Root_review','phase':PHASE,'remoteSolveCompletionUnknown':REMOTE_UNKNOWN,'automaticRetry':False,'releaseAuthorized':False}));sys.exit(2)
