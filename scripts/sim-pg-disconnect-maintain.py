#!/usr/bin/env python3
"""OFFLINE REVIEW CANDIDATE. Not installed, not executable as production GO.

New narrow ADR0048 authority: Root-only one-off pin/recreate and separately
approved image-only rollback. No reset/enrollment/administrative SQL or retries.
Root must create/review protected profile + fresh GO before either operation.
"""
import copy
from decimal import Decimal
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import select
import signal
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import time
import uuid

ROOT=Path('/var/lib/csm-sim-maintenance')
SOURCE=ROOT/'source'
LAYERS=[Path('/srv/sim')/x for x in ['docker-compose.yml','docker-compose.x5.yml','docker-compose.driver-measurements.yml','docker-compose.clean-user-data.json']]
PIN=LAYERS[-1]
NAME='csm-sim-api'
X5='/srv/x5-production'
X5_UUID='2f93f595-b61b-4eea-9054-7afa9b275b5b'
BASE='sha256:4076069b3f8c935c0cd07ea2bf95d92703270b72197ff2b74a27d1aee8c6bdf0'
FILES={'app/apps/simulator-api/dist/user-data.js':'e78d951eb538f4962542c28c8436db45713ff3ba7588d8d2c98a0f4f34ab72bd',
 'app/packages/sim-user-data/bootstrap.mjs':'c1b44b61e7ac7902463f1d68c6fec74dccf3550b4a3d95d02544788436d11d05',
 'app/packages/sim-user-data/pg-errors.mjs':'af3c90eec2a0702e434feb57cd7607a8d7fb7c84c8f1d10c8084b7d13b16b2fc'}
ENV={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','HOME':'/root','DOCKER_HOST':'unix:///var/run/docker.sock'}
PHASE='preflight'
EXPORT_TIMEOUT=120
COMPOSE_OLD='5.6.0'
COMPOSE_TARGET='5.6.1'
COMPOSE_VERSION_LABEL='com.docker.compose.version'
DC=['docker','--host','unix:///var/run/docker.sock','compose','--project-name','sim','--project-directory','/srv/sim','--env-file','/srv/sim/.env']
for p in LAYERS:DC+=['-f',str(p)]
class Stop(Exception):pass
def need(x,code):
 if not x:raise Stop(code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def encoded(x):return (json.dumps(x,sort_keys=True,separators=(',',':'))+'\n').encode()
def digest(x):return sha(encoded(x))
def command(args,input=None):
 try:return subprocess.check_output(args,input=input,env=ENV,cwd='/srv/sim',stderr=subprocess.PIPE,timeout=120)
 except (OSError,subprocess.SubprocessError):raise Stop('COMMAND_FAILED_DETAILS_WITHHELD') from None
def inspect(name):return json.loads(command(['docker','inspect',name]))[0]
def stable_stat(s):return (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_mode,s.st_uid,s.st_gid,s.st_nlink)
def config_bytes(path):
 need(not any(p.is_symlink() for p in [path,*path.parents]),'CONFIG_SYMLINK')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  a=os.fstat(fd);need(stat.S_ISREG(a.st_mode) and a.st_nlink==1 and a.st_size<=1048576,'CONFIG_CUSTODY')
  raw=os.read(fd,1048577);need(len(raw)==a.st_size and stable_stat(os.fstat(fd))==stable_stat(a) and os.lstat(path).st_ino==a.st_ino,'CONFIG_READ_DRIFT');return raw
 finally:os.close(fd)
def protected(path):
 for p in path.parents:
  s=p.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022,'PROTECTED_PARENT')
 s=path.lstat();need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and not s.st_mode&0o077 and s.st_size<=1048576,'PROTECTED_FILE')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  a=os.fstat(fd);raw=os.read(fd,1048577);b=os.fstat(fd)
  need(stable_stat(a)==stable_stat(b) and len(raw)==a.st_size and os.lstat(path).st_ino==a.st_ino,'PROTECTED_FILE_CHANGED');return raw
 finally:os.close(fd)
def validate_go_age(go):
 now=time.time();need(type(go['createdAt']) is int and type(go['expiresAt']) is int and 0<go['expiresAt']-go['createdAt']<=900 and go['createdAt']<=now<go['expiresAt'],'GO_EXPIRED')
 need(all(type(go[k]) is int and 0<=now-go[k]<=60 for k in ['capacityReviewedAt','buildIdleReviewedAt']),'OWNER_ACTIVITY_REVIEW_EXPIRED')
def approval_paths(action):
 if action=='activate':return ROOT/'profile.json',ROOT/'go.json'
 return ROOT/'profile-dns-v1.json',ROOT/('go-dns-rollback-v1.json' if action=='rollback' else 'go-dns-v1.json')
def profile_and_go(action):
 profile_path,go_path=approval_paths(action)
 profile=json.loads(protected(profile_path));go=json.loads(protected(go_path))
 need(set(profile)=={'contract','handlerSha256','probeSha256','candidateImage','baseImage','dataFilesystem'} and profile['contract']=='sim-image-only-root-profile-v1','PROFILE')
 need(profile['baseImage']==BASE and re.fullmatch('sha256:[0-9a-f]{64}',profile['candidateImage']) and profile['candidateImage']!=BASE,'IMAGE_SCOPE')
 need(sha(protected(SOURCE/'sim-pg-disconnect-maintain.py'))==profile['handlerSha256'],'HANDLER_CHANGED')
 need(sha(protected(SOURCE/'sim-maintenance-lineage-probe.mjs'))==profile['probeSha256'],'PROBE_CHANGED')
 expected={'contract','action','releaseId','profileSha256','createdAt','expiresAt','expectedCid','expectedImage','expectedStartedAt','expectedRestartCount','runtimeSha256','composeSha256','layerFileSha256','lineage','pinParentMetadata','minimumFreeBytes','capacityReviewedAt','buildIdleReviewedAt'}
 need(set(go)==expected and go['contract']=='sim-image-only-root-go-v1' and go['action']==action,'GO_SCHEMA')
 validate_go_age(go)
 need(re.fullmatch('[0-9a-f]{32}',go['releaseId']) and re.fullmatch('[0-9a-f]{64}',go['expectedCid']),'GO_IDENTITY')
 need(go['expectedImage']==BASE if action=='activate' else go['expectedImage'] in {BASE,profile['candidateImage']},'GO_IMAGE_ACTION')
 need(go['profileSha256']==sha(protected(profile_path)),'PROFILE_GO_MISMATCH')
 need(set(go['lineage'])=={'contract','verified','binding','config','journal'} and go['lineage']['contract']=='sim-maintenance-readonly-lineage-v1' and go['lineage']['verified'] is True,'GO_LINEAGE')
 need(set(go['layerFileSha256'])==set(map(str,LAYERS)),'GO_LAYERS')
 validate_go_age(go) # Protected reads above can themselves consume the lease.
 return profile,go
def compose_metadata_gate(c,versions=(COMPOSE_OLD,COMPOSE_TARGET)):
 labels=c['Config'].get('Labels') or {}
 need(labels.get('com.docker.compose.project.environment_file')=='/srv/sim/.env','COMPOSE_ENV_PATH_DRIFT')
 need(labels.get('com.docker.compose.replace')==NAME,'COMPOSE_REPLACE_NAME_DRIFT')
 need(labels.get(COMPOSE_VERSION_LABEL) in versions,'COMPOSE_VERSION_LABEL_DRIFT')
def compose_cli_gate():
 need(command(['docker','--host','unix:///var/run/docker.sock','compose','version','--short']).decode().strip() in {COMPOSE_TARGET,'v'+COMPOSE_TARGET},'COMPOSE_CLI_VERSION_DRIFT')
def raw_normalized_runtime(c):
 compose_metadata_gate(c)
 x=copy.deepcopy({k:c.get(k) for k in ['Config','HostConfig','Mounts']})
 x['Config'].pop('Image',None)
 if x['Config'].get('Hostname')==c.get('Id','')[:12]:x['Config']['Hostname']='__docker_generated_hostname__'
 for k in ['com.docker.compose.config-hash','com.docker.compose.image']:x['Config'].get('Labels',{}).pop(k,None)
 # Only the finite reviewed tool-version transition is canonicalized; env-file
 # path, replace NAME and every other retained label remain full hash inputs.
 x['Config']['Labels'][COMPOSE_VERSION_LABEL]='__reviewed_compose_5_6_0_to_5_6_1__'
 env=x['Config'].get('Env') or [];pairs=[v.split('=',1) for v in env]
 need(all(len(v)==2 for v in pairs) and len({v[0] for v in pairs})==len(pairs),'ENV_DUPLICATE')
 x['Config']['Env']=dict(pairs)
 x['networks']={k:{'NetworkID':v.get('NetworkID'),'Aliases':v.get('Aliases')} for k,v in c['NetworkSettings']['Networks'].items()}
 return x
DNS_FIELDS=('Dns','DnsOptions','DnsSearch')
def normalized_runtime(c):
 x=raw_normalized_runtime(c)
 for key in DNS_FIELDS:
  if key not in x['HostConfig']:continue
  value=x['HostConfig'][key]
  need(value is None or (type(value) is list and all(type(v) is str for v in value)),'DNS_SERIALIZATION_TYPE')
  if value is None:x['HostConfig'][key]=[]
 return x
def dns_amendment(profile,go,current):
 # This finite bridge is not a general profile or lineage migration facility.
 old_profile_raw=protected(ROOT/'profile.json');old_go_raw=protected(ROOT/'go.json')
 old_profile=json.loads(old_profile_raw);old_go=json.loads(old_go_raw)
 release='78a7cc8faa074cb284d6c3523f03ee38'
 intent_raw=protected(ROOT/(release+'-activate.json'));intent=json.loads(intent_raw)
 failed_raw=protected(ROOT/'operator-invocation-result.json');failed=json.loads(failed_raw)
 amendment=json.loads(protected(ROOT/'dns-serialization-amendment.json'))
 need(set(amendment)=={'contract','originalProfileSha256','originalGoSha256','originalIntentSha256','originalFailedResultSha256','newProfileSha256','releaseId','candidateImage','runtimeSha256','observedRawRuntimeSha256','acceptedCid','acceptedStartedAt','acceptedRestartCount','changedFields'},'DNS_AMENDMENT_SCHEMA')
 need(amendment['contract']=='sim-empty-dns-profile-amendment-v1' and amendment['releaseId']==release,'DNS_AMENDMENT_SCOPE')
 need(old_profile['handlerSha256']=='46af72cd310c509d64a1d68ab8a422caf43629c1bee4b88a98f65738840d1598','DNS_ORIGINAL_HANDLER')
 need(sha(protected(SOURCE/'sim-pg-disconnect-maintain.46af.py'))==old_profile['handlerSha256'],'DNS_ORIGINAL_SOURCE')
 expected_profile=copy.deepcopy(old_profile);expected_profile['handlerSha256']=profile['handlerSha256']
 need(profile==expected_profile and profile['candidateImage']=='sha256:0e6b989a135cf618cd02903a54b76a272f4ed574b73005a2c502c7ce304f15cd','DNS_PROFILE_SCOPE')
 for key,raw in [('originalProfileSha256',old_profile_raw),('originalGoSha256',old_go_raw),('originalIntentSha256',intent_raw),('originalFailedResultSha256',failed_raw),('newProfileSha256',protected(ROOT/'profile-dns-v1.json'))]:
  need(amendment[key]==sha(raw),'DNS_AMENDMENT_ARTIFACT_DRIFT')
 need(failed['exitCode']==2 and failed['automaticRetry'] is False,'DNS_ORIGINAL_FAILURE')
 failure=json.loads(failed['stdout'])
 need(failure.get('status')=='stopped_requires_review' and failure.get('code')=='POST_RUNTIME' and failure.get('phase')=='recreate','DNS_ORIGINAL_FAILURE')
 need(old_go['action']=='activate' and old_go['releaseId']==release and old_go['expectedImage']==BASE and old_go['profileSha256']==sha(old_profile_raw),'DNS_ORIGINAL_GO')
 need(intent['phase']=='intent_not_completion' and intent['oldImage']==BASE and intent['newImage']==profile['candidateImage'] and intent['baselineCid']==old_go['expectedCid'],'DNS_ORIGINAL_INTENT')
 need(intent['profileSha256']==sha(old_profile_raw) and intent['lineage']==old_go['lineage']==go['lineage'],'DNS_LINEAGE')
 need(intent['runtimeSha256']==old_go['runtimeSha256']==go['runtimeSha256']==amendment['runtimeSha256']=='ac363097ca5a677189897d62560e534854e1f068ba1c5d9c7b2713eff6fa03cd','DNS_PREIMAGE')
 need(intent['composeSha256']==old_go['composeSha256'] and intent['layerFileSha256']==old_go['layerFileSha256'],'DNS_ORIGINAL_INTENT')
 need(go['releaseId']==release and amendment['candidateImage']==profile['candidateImage']==current['Image']==go['expectedImage'],'DNS_CANDIDATE')
 need(current['Id']!=old_go['expectedCid'],'DNS_GENERATION')
 need(amendment['changedFields']==['HostConfig.'+k for k in DNS_FIELDS],'DNS_FIELD_SCOPE')
 need(all(current['HostConfig'].get(k,'missing') is None for k in DNS_FIELDS),'DNS_CURRENT_SHAPE')
 need(digest(raw_normalized_runtime(current))==amendment['observedRawRuntimeSha256'] and digest(normalized_runtime(current))==old_go['runtimeSha256'],'DNS_EXACT_PREIMAGE')
 need((current['Id'],current['State']['StartedAt'],current['RestartCount'])==(amendment['acceptedCid'],amendment['acceptedStartedAt'],amendment['acceptedRestartCount']) and current['RestartCount']==0,'DNS_GENERATION')
 return sha(old_profile_raw),sha(protected(ROOT/'dns-serialization-amendment.json'))
def pin_read(go):
 # Anchored mixed-owner path; exact layout is a Root-reviewed input, not chmod.
 need(set(go['pinParentMetadata'])=={'/','/srv','/srv/sim'},'PIN_PARENT_SCOPE')
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  for name,path in [(None,'/'),('srv','/srv'),('sim','/srv/sim')]:
   if name:
    new=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=new
   s=os.fstat(fd);need([s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode)]==go['pinParentMetadata'][path],'PIN_PARENT_CHANGED')
  f=os.open(PIN.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
  try:
   a=os.fstat(f);need(stat.S_ISREG(a.st_mode) and a.st_uid==0 and not a.st_mode&0o022 and a.st_nlink==1 and a.st_size<1048576,'PIN_CUSTODY')
   raw=os.read(f,1048577);need(stable_stat(os.fstat(f))==stable_stat(a) and len(raw)==a.st_size,'PIN_READ_DRIFT')
   return fd,raw,a
  finally:os.close(f)
 except BaseException:os.close(fd);raise
def changed_pin(raw,old,new):
 obj=json.loads(raw);need(obj['services']['sim-api']['image']==old,'PIN_IMAGE_DRIFT')
 old_bytes=json.dumps(old).encode();new_bytes=json.dumps(new).encode()
 need(raw.count(old_bytes)==1,'PIN_IMAGE_NOT_UNIQUE')
 out=raw.replace(old_bytes,new_bytes,1);expected=copy.deepcopy(obj);expected['services']['sim-api']['image']=new
 need(json.loads(out)==expected,'PIN_SEMANTIC_DRIFT');return out
def replace_pin(profile,go,expected,replacement):
 fd,raw,meta=pin_read(go);temp='.sim-maintain-'+uuid.uuid4().hex
 try:
  need(raw==expected,'PIN_CAS_DRIFT')
  f=os.open(temp,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,meta.st_mode&0o777,dir_fd=fd)
  try:
   os.fchown(f,meta.st_uid,meta.st_gid);os.fchmod(f,meta.st_mode&0o777)
   with os.fdopen(f,'wb',closefd=False) as h:h.write(replacement);h.flush();os.fsync(f)
  finally:os.close(f)
  # temp-file fsync can block. Re-read the actual protected profile/GO and
  # filesystem/build gates, not a caller-provided success callback/boolean.
  fresh_mutation_gate(go['action'],profile,go)
  fd2,again,_meta=pin_read(go)
  try:need(again==expected,'PIN_CAS_DRIFT')
  finally:os.close(fd2)
  need(profile_and_go(go['action'])==(profile,go),'PRE_RENAME_GO_DRIFT')
  # The protected reads above may be slow: repeat CAS after them, then perform
  # the final in-memory age check with no intervening file/process I/O.
  fd3,again,_meta=pin_read(go)
  try:need(again==expected,'PIN_CAS_DRIFT')
  finally:os.close(fd3)
  validate_go_age(go)
  os.replace(temp,PIN.name,src_dir_fd=fd,dst_dir_fd=fd);os.fsync(fd)
 finally:
  try:os.unlink(temp,dir_fd=fd)
  except FileNotFoundError:pass
  os.close(fd)
def lineage():
 script=protected(SOURCE/'sim-maintenance-lineage-probe.mjs')
 result=json.loads(command(['docker','exec','-i',NAME,'node','--input-type=module'],script))
 need(set(result)=={'contract','verified','binding','config','journal'} and result['verified'] is True,'LINEAGE_UNAVAILABLE');return result
def runtime_files(expected_image):
 files={p.removeprefix('app/'):v for p,v in FILES.items()}
 files.update({'packages/sim-user-data/authority.mjs':'a0b3fd882baff5ee24401af035ff99134b8ea1f5cc362c88c909cb9bd67ad3d2',
               'packages/sim-user-data/ledger.mjs':'61a4dc6d62b45819274a271fdb36c90c92a6fa724e121af7a72c8db96481603b'})
 if expected_image==BASE:
  files.update({'apps/simulator-api/dist/user-data.js':'bb34e391f98985da89dc5bedfb2352a0155d2a3e241c30f51d2b2491f8039749',
                'packages/sim-user-data/bootstrap.mjs':'3f51a4d243608e57953464fa751e5b1e346a80fc6664958ac3fdbfa69074f4ec','packages/sim-user-data/pg-errors.mjs':None})
 script=("const f=require('fs'),c=require('crypto');console.log(JSON.stringify(Object.fromEntries("+json.dumps(list(files))+".map(p=>{try{return[p,c.createHash('sha256').update(f.readFileSync(p)).digest('hex')]}catch(e){if(e.code==='ENOENT')return[p,null];throw e}}))));").encode()
 need(json.loads(command(['docker','exec','-i',NAME,'node'],script))==files,'RUNTIME_MODULE_DRIFT')
def health():
 script=b"Promise.all(['/health/ready','/api/v1/internal/sim-user-data/v1/capabilities'].map(async p=>(await fetch('http://127.0.0.1:4000'+p,{signal:AbortSignal.timeout(10000)})).status)).then(x=>console.log(JSON.stringify(x))).catch(()=>process.exit(2))"
 need(json.loads(command(['docker','exec','-i',NAME,'node'],script))==[200,401],'READINESS_OR_AUTH')
def validate_tar(raw,expected_sha,expected_files=None):
 expected_files=FILES if expected_files is None else expected_files
 # Root proved immutable BASE4076's existing directory is root:root 0775 and
 # current Docker diff changes neither it nor ancestors (2026-10-28). Permit
 # exactly that inherited metadata in these two single-file COPY layers only.
 inherited775=any(expected_files=={p:FILES[p]} for p in ['app/packages/sim-user-data/bootstrap.mjs','app/packages/sim-user-data/pg-errors.mjs'])
 need(len(raw)<=2097152 and 'sha256:'+sha(raw)==expected_sha,'LAYER_DIGEST')
 dirs={'app','app/apps','app/apps/simulator-api','app/apps/simulator-api/dist','app/packages','app/packages/sim-user-data'}
 seen=set()
 with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
  need(not archive.pax_headers,'LAYER_EXTENDED_METADATA')
  for m in archive:
   need(not m.pax_headers and not getattr(m,'sparse',None) and m.type in {tarfile.REGTYPE,tarfile.AREGTYPE,tarfile.DIRTYPE} and m.offset_data==m.offset+512,'LAYER_EXTENDED_METADATA')
   name=m.name.rstrip('/');need(name not in seen,'DUPLICATE_LAYER_PATH');seen.add(name)
   need(m.uid==0 and m.gid==0 and not m.linkname,'LAYER_CUSTODY')
   if m.isdir():need(name in dirs and m.mode==(0o775 if name=='app/packages/sim-user-data' and inherited775 else 0o755),'LAYER_DIR')
   else:
    need(m.isfile() and name in expected_files and m.mode==0o644 and m.size<1048576,'LAYER_FILE')
    need(sha(archive.extractfile(m).read())==expected_files[name],'LAYER_CONTENT')
 need(set(expected_files).issubset(seen),'MISSING_LAYER_FILE')
class DeadlineReader:
 def __init__(self,pipe,deadline):self.pipe=pipe;self.deadline=deadline
 def read(self,size):
  remaining=self.deadline-time.monotonic();need(remaining>0,'IMAGE_EXPORT_DEADLINE')
  readable,_,_=select.select([self.pipe],[],[],remaining)
  need(bool(readable) and time.monotonic()<self.deadline,'IMAGE_EXPORT_DEADLINE')
  return os.read(self.pipe.fileno(),min(size,65536))
def exported_layers(reader,budget):
 # Parse bounded headers ourselves: tarfile streaming would consume an oversized
 # PAX/GNU extension before yielding its logical member. Extension budget is ZERO.
 used=0;headers=0
 def exact(n):
  nonlocal used
  chunks=[]
  while n:
   part=reader.read(min(n,65536));need(bool(part),'TRUNCATED_EXPORT')
   used+=len(part);need(used<=budget,'EXPORT_BYTE_BUDGET');chunks.append(part);n-=len(part)
  return b''.join(chunks)
 while True:
  h=exact(512)
  if h==b'\0'*512:
   need(exact(512)==b'\0'*512,'EXPORT_TRAILER')
   while True:
    tail=reader.read(65536)
    if not tail:return
    used+=len(tail);need(used<=budget and not tail.strip(b'\0'),'EXPORT_TRAILER')
  headers+=1;need(headers<=10000,'EXPORT_HEADER_BUDGET')
  member=tarfile.TarInfo.frombuf(h,'utf-8','strict')
  need(member.type in {tarfile.REGTYPE,tarfile.AREGTYPE,tarfile.DIRTYPE} and member.size>=0,'EXPORT_EXTENDED_METADATA')
  if member.isdir():need(member.size==0,'EXPORT_DIR_SIZE')
  remaining=member.size;small=remaining<=2097152;chunks=[]
  while remaining:
   chunk=exact(min(remaining,65536));remaining-=len(chunk)
   if small:chunks.append(chunk)
  if member.size%512:exact(512-member.size%512)
  if member.isfile() and small:yield b''.join(chunks)
def image_gate(candidate):
 old=json.loads(command(['docker','image','inspect',BASE]))[0];new=json.loads(command(['docker','image','inspect',candidate]))[0]
 need(old['Os']==new['Os']=='linux' and old['Architecture']==new['Architecture'],'IMAGE_PLATFORM')
 need(old['Config']==new['Config'],'IMAGE_CONFIG_CHANGED')
 a=old['RootFS']['Layers'];b=new['RootFS']['Layers'];need(b[:-3]==a and len(b)==len(a)+3 and len(set(b[-3:]))==3,'IMAGE_BASE_LAYERS')
 expected_layers={layer:{path:FILES[path]} for layer,path in zip(b[-3:],FILES)}
 # Stream the image without staging large base layers to disk. Never extract.
 deadline=time.monotonic()+EXPORT_TIMEOUT
 p=subprocess.Popen(['docker','image','save',candidate],env=ENV,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True,bufsize=0)
 matched=set()
 try:
  budget=min(4294967296,max(16777216,int(new.get('Size',0))*2+16777216))
  for raw in exported_layers(DeadlineReader(p.stdout,deadline),budget):
   need(time.monotonic()<deadline,'IMAGE_EXPORT_DEADLINE')
   layer='sha256:'+sha(raw)
   if layer in expected_layers:
    need(layer not in matched,'DUPLICATE_EXPORTED_LAYER');validate_tar(raw,layer,expected_layers[layer]);matched.add(layer)
  remaining=deadline-time.monotonic();need(remaining>0,'IMAGE_EXPORT_DEADLINE')
  need(p.wait(timeout=remaining)==0 and matched==set(expected_layers),'IMAGE_LAYER_NOT_PROVEN')
 except subprocess.TimeoutExpired:raise Stop('IMAGE_EXPORT_DEADLINE') from None
 finally:
  if p.poll() is None:
   os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
  p.stdout.close()
def no_known_active_builds():
 # This is a conservative known-process check, NOT proof that a remote/daemon
 # builder is idle. A fresh Root build-owner attestation is also mandatory.
 for entry in Path('/proc').iterdir():
  if not entry.name.isdecimal():continue
  try:args=(entry/'cmdline').read_bytes().split(b'\0')[:7]
  except (FileNotFoundError,ProcessLookupError):continue
  if not args:continue
  executable=os.path.basename(os.fsdecode(args[0]))
  if executable in {'docker','docker-buildx','buildctl','pnpm','npm','yarn','node'}:
   need(b'build' not in args[1:],'ACTIVE_BUILD_PROCESS')
def filesystem_identity(current):
 need(not Path(X5).is_symlink(),'X5_SYMLINK')
 mounts=[x for x in current.get('Mounts',[]) if x.get('Destination')=='/data']
 need(len(mounts)==1 and mounts[0]['Type']=='bind','DATA_BIND_REQUIRED')
 source=Path(mounts[0]['Source']);need(source.is_absolute() and source.is_relative_to(X5) and source!=Path(X5),'DATA_SOURCE_SCOPE')
 need(not any(p.is_symlink() for p in [source,*source.parents]),'DATA_SOURCE_SYMLINK')
 rows=[x.split() for x in Path('/proc/self/mountinfo').read_text().splitlines() if len(x.split())>6 and x.split()[4]==X5]
 need(len(rows)==1,'X5_MOUNT_REQUIRED');row=rows[0]
 need(command(['findmnt','-n','-o','UUID','--mountpoint',X5]).decode().strip()==X5_UUID,'X5_UUID_CHANGED')
 mount=os.stat(X5);data=os.stat(source);root=os.stat('/')
 need(stat.S_ISDIR(data.st_mode) and data.st_dev==mount.st_dev and mount.st_dev!=root.st_dev,'DATA_FILESYSTEM_CHANGED')
 return {'mountpoint':X5,'uuid':X5_UUID,'mountId':row[0],'majorMinor':row[2],'fsRoot':row[3],
  'mountStDev':mount.st_dev,'sourcePath':str(source),'sourceStDev':data.st_dev,'sourceInode':data.st_ino,
  'sourceMode':stat.S_IMODE(data.st_mode),'sourceUid':data.st_uid,'sourceGid':data.st_gid}
def filesystem_gate(profile,go,current):
 expected=profile['dataFilesystem'];need(isinstance(expected,dict) and 'minimumFreeBytesX5' in expected,'FILESYSTEM_PROFILE')
 identity={k:v for k,v in expected.items() if k!='minimumFreeBytesX5'}
 need(filesystem_identity(current)==identity,'FILESYSTEM_IDENTITY_DRIFT')
 floor=expected['minimumFreeBytesX5'];need(type(floor) is int and floor>=2147483648 and shutil.disk_usage(X5).free>=floor,'X5_DISK_MARGIN')
 need(type(go['minimumFreeBytes']) is int and go['minimumFreeBytes']>=2147483648 and shutil.disk_usage('/srv/sim').free>=go['minimumFreeBytes'],'DISK_MARGIN')
def fresh_mutation_gate(action,profile,go):
 current=inspect(NAME)
 compose_metadata_gate(current,(COMPOSE_OLD,) if action=='activate' else ((COMPOSE_TARGET,) if go['expectedImage']!=BASE else (COMPOSE_OLD,COMPOSE_TARGET)))
 filesystem_gate(profile,go,current);no_known_active_builds();compose_cli_gate()
 if action=='rollback':dns_reverse_acceptance(profile,go,current)
 # Last operation before mutation: re-read protected approval and evaluate age
 # AFTER potentially slow filesystem/process reads, not before them.
 need(profile_and_go(action)==(profile,go),'FRESH_GO_DRIFT')
def facts(profile,go,expected_image):
 c=inspect(NAME);need(c['Id']==go['expectedCid'] and c['Image']==expected_image,'CID_IMAGE_DRIFT')
 need(c['State'].get('StartedAt')==go['expectedStartedAt'] and c.get('RestartCount')==go['expectedRestartCount'],'PROCESS_GENERATION_DRIFT')
 need(digest(normalized_runtime(c))==go['runtimeSha256'],'RUNTIME_DRIFT')
 need(c['Config']['Labels'].get('com.docker.compose.project.config_files')==','.join(map(str,LAYERS)),'LAYER_PATH_DRIFT')
 need({str(p):sha(config_bytes(p)) for p in LAYERS}==go['layerFileSha256'],'LAYER_CONTENT_DRIFT')
 need(digest(json.loads(command(DC+['config','--format','json'])))==go['composeSha256'],'COMPOSE_DRIFT')
 runtime_files(expected_image)
 need(lineage()==go['lineage'],'LINEAGE_DRIFT');health()
 filesystem_gate(profile,go,c)
 no_known_active_builds()
 return c
def before_service_gate(compose,current,image):
 service=compose['services']['sim-api'];ic=image['Config'];actual=current['Config']
 expected={}
 for entry in ic.get('Env') or []:
  k,sep,v=entry.partition('=');need(sep and k not in expected,'IMAGE_ENV_STRUCTURE');expected[k]=v
 configured=service.get('environment') or {};need(isinstance(configured,dict) and all(isinstance(v,str) for v in configured.values()),'COMPOSE_ENV_STRUCTURE')
 expected.update(configured)
 actual_env={}
 for entry in actual.get('Env') or []:
  k,sep,v=entry.partition('=');need(sep and k not in actual_env,'ENV_DUPLICATE');actual_env[k]=v
 need(expected==actual_env,'PRE_EXISTING_ENV_RENDER_DRIFT')
 # Compose null/missing inherits; []/'' deliberately clears. A non-null
 # entrypoint also discards image CMD unless Compose supplies command itself.
 # Never use truthiness here: that would silently erase explicit empty overrides.
 entrypoint=service.get('entrypoint')
 expected_entrypoint=ic.get('Entrypoint') if entrypoint is None else ([] if entrypoint=='' else entrypoint)
 command_value=service.get('command')
 expected_command=(ic.get('Cmd') if entrypoint is None else []) if command_value is None else ([] if command_value=='' else command_value)
 need(expected_entrypoint==actual.get('Entrypoint') and expected_command==actual.get('Cmd'),'PRE_EXISTING_EXEC_RENDER_DRIFT')
 for ck,ik in [('user','User'),('working_dir','WorkingDir')]:
  expected_value=service.get(ck,ic.get(ik))
  # The one observed Engine serialization: no user in BOTH Compose and image
  # becomes Config.User=''. Do not generalize explicit null or other fields.
  if ck=='user' and ck not in service and ik not in ic:expected_value=''
  need(expected_value==actual.get(ik),'PRE_EXISTING_EXEC_RENDER_DRIFT')
def duration_ns(value):
 if value is None:return 0
 parts=re.findall(r'([0-9]+(?:\.[0-9]+)?)(ns|us|ms|s|m|h)',str(value))
 need(parts and ''.join(n+u for n,u in parts)==str(value),'DURATION_UNSUPPORTED')
 units={'ns':1,'us':1000,'ms':1000000,'s':1000000000,'m':60000000000,'h':3600000000000}
 return int(sum(Decimal(n)*units[u] for n,u in parts))
def critical_service_gate(compose,current,image):
 before_service_gate(compose,current,image)
 compose_metadata_gate(current)
 s=compose['services']['sim-api'];h=current['HostConfig'];ic=image['Config'];cfg=current['Config']
 allowed={'build','image','container_name','environment','expose','healthcheck','restart','volumes','networks','labels',
  'command','entrypoint','user','working_dir','read_only','privileged','cap_add','cap_drop','security_opt','group_add',
  'init','tty','stdin_open','mem_limit','mem_reservation','memswap_limit','cpus','cpu_shares','cpu_period','cpu_quota','cpuset','pids_limit',
  'oom_kill_disable','oom_score_adj','shm_size','stop_signal','stop_grace_period'}
 need(not(set(s)-allowed),'UNSUPPORTED_COMPOSE_SERVICE_FIELD')
 need(s.get('container_name')==NAME and s.get('image')==current['Image'],'COMPOSE_TARGET_IDENTITY')
 # No ports, host networking, devices, new sysctls, tmpfs, deploy overrides or
 # unknown escape hatches are inferred/ignored by this fixed SIM contract.
 need(not h.get('PortBindings'),'PUBLIC_PORT_SCOPE')
 expected={
  'Privileged':s.get('privileged',False),'ReadonlyRootfs':s.get('read_only',False),'CapAdd':s.get('cap_add',[]),'CapDrop':s.get('cap_drop',[]),
  'SecurityOpt':s.get('security_opt',[]),'GroupAdd':s.get('group_add',[]),'Init':s.get('init'),
  'Memory':int(s.get('mem_limit',0)),'MemoryReservation':int(s.get('mem_reservation',0)),'MemorySwap':int(s.get('memswap_limit',0)),
  'NanoCpus':int(Decimal(str(s.get('cpus',0)))*1000000000),'CpuShares':int(s.get('cpu_shares',0)),
  'CpuPeriod':int(s.get('cpu_period',0)),'CpuQuota':int(s.get('cpu_quota',0)),'CpusetCpus':s.get('cpuset',''),'PidsLimit':int(s.get('pids_limit',0)),
  'OomKillDisable':s.get('oom_kill_disable',False),'OomScoreAdj':s.get('oom_score_adj',0),'ShmSize':int(s.get('shm_size',67108864)),
  'AutoRemove':False,'PublishAllPorts':False,'ContainerIDFile':'','VolumeDriver':'','VolumesFrom':[],
  'Devices':[],'DeviceRequests':[],'DeviceCgroupRules':[],'Ulimits':[],'Links':[],'Tmpfs':{},'Sysctls':{},'StorageOpt':{},'Annotations':{},
  'PidMode':'','IpcMode':'private','UTSMode':'','UsernsMode':'','Isolation':'','Runtime':'runc','CgroupnsMode':'private','Cgroup':'','CgroupParent':'',
  'Dns':[],'DnsOptions':[],'DnsSearch':[],'ExtraHosts':[],'ConsoleSize':[0,0],
  'CpuRealtimePeriod':0,'CpuRealtimeRuntime':0,'CpuCount':0,'CpuPercent':0,'CpusetMems':'','MemorySwappiness':None,'KernelMemory':0,
  'BlkioWeight':0,'BlkioWeightDevice':[],'BlkioDeviceReadBps':[],'BlkioDeviceWriteBps':[],'BlkioDeviceReadIOps':[],'BlkioDeviceWriteIOps':[],
  'IOMaximumIOps':0,'IOMaximumBandwidth':0}
 for key,wanted in expected.items():
  actual=h.get(key)
  if actual is None and wanted is not None:actual=type(wanted)() if not isinstance(wanted,str) else ''
  need(actual==wanted,'PRE_HOST_SECURITY_RESOURCE_DRIFT')
 masks={'/proc/acpi','/proc/asound','/proc/interrupts','/proc/kcore','/proc/keys','/proc/latency_stats','/proc/timer_list','/proc/timer_stats','/proc/sched_debug','/proc/scsi','/sys/firmware','/sys/devices/virtual/powercap'}
 readonly={'/proc/bus','/proc/fs','/proc/irq','/proc/sys','/proc/sysrq-trigger'}
 need(set(h.get('MaskedPaths') or [])==masks and set(h.get('ReadonlyPaths') or [])==readonly,'ENGINE_DEFAULT_SECURITY_UNPROVEN')
 need(h.get('LogConfig')=={'Type':'json-file','Config':{}},'ENGINE_LOG_PROFILE_UNPROVEN')
 restart=s.get('restart','no').split(':');need(len(restart)<=2 and restart[0] in {'no','always','unless-stopped','on-failure'},'RESTART_UNSUPPORTED')
 need(h.get('RestartPolicy')=={'Name':restart[0],'MaximumRetryCount':int(restart[1]) if len(restart)==2 else 0},'RESTART_DRIFT')
 desired=s.get('volumes') or [];need(len({v['target'] for v in desired})==len(desired),'DUPLICATE_MOUNT')
 actual=current.get('Mounts') or [];need(len({v['Destination'] for v in actual})==len(actual),'DUPLICATE_LIVE_MOUNT')
 need({v['target']:(v['source'],not v.get('read_only',False),v['type']) for v in desired}=={v['Destination']:(v['Source'],v['RW'],v['Type']) for v in actual},'PRE_MOUNT_DRIFT')
 host_mounts={v['Target']:v for v in h.get('Mounts') or []}
 for v in desired:
  need(set(v)<={'type','source','target','read_only','bind'} and v['type']=='bind','MOUNT_CONTRACT_UNSUPPORTED')
  options=v.get('bind') or {};need(set(options)<={'create_host_path','propagation'},'BIND_OPTIONS_UNSUPPORTED')
  live=next(x for x in actual if x['Destination']==v['target'])
  need(live.get('Propagation','rprivate')==options.get('propagation','rprivate'),'PROPAGATION_DRIFT')
  if v['target'] in host_mounts:
   hm=host_mounts[v['target']];need(set(hm)<={'Type','Source','Target','ReadOnly','BindOptions'},'HOST_MOUNT_FIELD_UNSUPPORTED')
   need((hm.get('Type'),hm.get('Source'),hm.get('Target'),hm.get('ReadOnly',False))==('bind',v['source'],v['target'],v.get('read_only',False)),'HOST_MOUNT_DRIFT')
   bo=hm.get('BindOptions') or {};need(set(bo)<={'Propagation','CreateMountpoint'} and bo.get('CreateMountpoint',False)==options.get('create_host_path',False),'HOST_BIND_OPTIONS_DRIFT')
  else:need(options.get('create_host_path',True) is True,'BIND_CUSTODY_UNPROVEN')
 binds=h.get('Binds') or []
 wanted_binds={v['source']+':'+v['target']+(':'+('ro' if v.get('read_only') else 'rw')) for v in desired if v['target'] not in host_mounts}
 need(set(binds)==wanted_binds and len(binds)==len(wanted_binds) and set(host_mounts)<={v['target'] for v in desired},'HOST_BINDS_DRIFT')
 networks=s.get('networks') or {};need(isinstance(networks,dict) and len(networks)==1,'NETWORK_CONTRACT_UNSUPPORTED')
 key,options=next(iter(networks.items()));options=options or {};need(set(options)<={'aliases'},'NETWORK_OPTIONS_UNSUPPORTED')
 network=compose['networks'][key];need(set(network)<={'name','external','driver','ipam'},'NETWORK_DEFINITION_UNSUPPORTED')
 need(not network.get('ipam') and network.get('driver','bridge')=='bridge','NETWORK_DEFINITION_UNSUPPORTED')
 network_name=network['name'];live=current['NetworkSettings']['Networks']
 need(set(live)=={network_name} and h.get('NetworkMode')==network_name,'PRE_NETWORK_DRIFT')
 need(set(live[network_name].get('Aliases') or [])=={NAME,'sim-api'}|set(options.get('aliases') or []),'NETWORK_ALIAS_DRIFT')
 check=s.get('healthcheck');wanted=ic.get('Healthcheck') or {}
 if check is not None:
  need(set(check)<={'test','interval','timeout','start_period','start_interval','retries','disable'},'HEALTH_FIELD_UNSUPPORTED')
  wanted={'Test':['NONE']} if check.get('disable') else {'Test':check['test']}
  for a,b in [('interval','Interval'),('timeout','Timeout'),('start_period','StartPeriod'),('start_interval','StartInterval')]:
   if a in check:wanted[b]=duration_ns(check[a])
  if 'retries' in check:wanted['Retries']=check['retries']
 # Only Docker's documented serialization of omitted zero values is normalized.
 zero=lambda x:{k:v for k,v in x.items() if v not in (None,0)}
 need(zero(cfg.get('Healthcheck') or {})==zero(wanted),'PRE_HEALTH_DRIFT')
 exposed=set(ic.get('ExposedPorts') or {})|{str(x) if '/' in str(x) else str(x)+'/tcp' for x in s.get('expose',[])}
 need(set(cfg.get('ExposedPorts') or {})==exposed,'EXPOSE_DRIFT')
 need(cfg.get('Tty',False)==s.get('tty',False) and cfg.get('OpenStdin',False)==s.get('stdin_open',False),'TTY_DRIFT')
 need(cfg.get('StdinOnce',False) is False and not cfg.get('NetworkDisabled',False),'CONFIG_RUNTIME_UNSUPPORTED')
 need(cfg.get('Hostname')==current.get('Id','')[:12] and (cfg.get('Domainname') or '')==(ic.get('Domainname') or ''),'HOSTNAME_DRIFT')
 stop=s.get('stop_signal',ic.get('StopSignal'));need((cfg.get('StopSignal') or '')==(stop or ''),'STOP_SIGNAL_DRIFT')
 need((cfg.get('StopTimeout') if cfg.get('StopTimeout') is not None else 10)==duration_ns(s.get('stop_grace_period','10s'))//1000000000,'STOP_TIMEOUT_DRIFT')
 generated={'com.docker.compose.project','com.docker.compose.service','com.docker.compose.project.working_dir','com.docker.compose.project.config_files','com.docker.compose.container-number','com.docker.compose.version','com.docker.compose.config-hash','com.docker.compose.image','com.docker.compose.oneoff','com.docker.compose.depends_on','com.docker.compose.project.environment_file','com.docker.compose.replace'}
 expected_labels={**(ic.get('Labels') or {}),**(s.get('labels') or {})}
 need(not any(k.startswith('com.docker.compose.') for k in (s.get('labels') or {})),'RESERVED_COMPOSE_LABEL')
 actual_labels={k:v for k,v in (cfg.get('Labels') or {}).items() if k not in generated}
 need(actual_labels==expected_labels,'PRE_LABEL_DRIFT')
 known=set(expected)|{'Binds','Mounts','NetworkMode','PortBindings','RestartPolicy','LogConfig','MaskedPaths','ReadonlyPaths'}
 need(not(set(h)-known),'UNKNOWN_HOSTCONFIG_FIELD')
def receipt(path,value):
 # Only bookkeeping under already Root-owned private directory, never data mount.
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as out:out.write(encoded(value));out.flush();os.fsync(out.fileno())
 directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(directory)
 finally:os.close(directory)
def intent_then_pin(action,profile,go,path,value,raw,replacement):
 # Keep the durable intent and the final fresh admission inseparable in code.
 # A slow fsync must not turn a once-fresh approval into mutation authority.
 fresh_mutation_gate(action,profile,go)
 receipt(path,value)
 fresh_mutation_gate(action,profile,go)
 replace_pin(profile,go,raw,replacement)
def accept_existing_dns(profile,go,profile_raw,go_raw):
 current=facts(profile,go,profile['candidateImage'])
 bridge,amendment_sha=dns_amendment(profile,go,current)
 image_gate(profile['candidateImage'])
 rendered=json.loads(command(DC+['config','--format','json']))
 critical_service_gate(rendered,current,json.loads(command(['docker','image','inspect',current['Image']]))[0])
 previous=json.loads(protected(ROOT/(go['releaseId']+'-activate.json')))
 inverse=copy.deepcopy(rendered);inverse['services']['sim-api']['image']=BASE
 need(digest(inverse)==previous['composeSha256'],'DNS_INVERSE_COMPOSE')
 fd,pin,_=pin_read(go);os.close(fd)
 need(sha(changed_pin(pin,profile['candidateImage'],BASE))==previous['pinSha256'],'DNS_INVERSE_PIN')
 need(all(go['layerFileSha256'][str(p)]==previous['layerFileSha256'][str(p)] for p in LAYERS[:-1]),'DNS_LAYER_DRIFT')
 final=facts(profile,go,profile['candidateImage'])
 need(dns_amendment(profile,go,final)==(bridge,amendment_sha),'DNS_AMENDMENT_DRIFT')
 need(profile_and_go('accept-existing-dns')==(profile,go),'DNS_FINAL_APPROVAL')
 pp,gp=approval_paths('accept-existing-dns')
 need(protected(pp)==profile_raw and protected(gp)==go_raw,'DNS_FINAL_APPROVAL')
 validate_go_age(go) # Protected readback may itself consume the fresh approval.
 # Separate actual post-acceptance: never writes original forward completion.
 receipt(ROOT/(go['releaseId']+'-dns-post-acceptance.json'),{'contract':'sim-empty-dns-post-acceptance-v1','completed':True,'cid':final['Id'],'startedAt':final['State']['StartedAt'],'restartCount':final['RestartCount'],'image':final['Image'],'lineage':go['lineage'],'runtimeSha256':go['runtimeSha256'],'profileSha256':sha(profile_raw),'originalProfileSha256':bridge,'amendmentSha256':amendment_sha,'appUpExecuted':False,'dataRestored':False})
 print(json.dumps({'status':'existing_candidate_accepted','action':'accept-existing-dns','image':final['Image'],'cid':final['Id'],'appUpExecuted':False}))
def dns_reverse_acceptance(profile,go,current):
 bridge,amendment_sha=dns_amendment(profile,go,current)
 accepted=json.loads(protected(ROOT/(go['releaseId']+'-dns-post-acceptance.json')))
 need(accepted=={'contract':'sim-empty-dns-post-acceptance-v1','completed':True,'cid':current['Id'],'startedAt':current['State']['StartedAt'],'restartCount':current['RestartCount'],'image':current['Image'],'lineage':go['lineage'],'runtimeSha256':go['runtimeSha256'],'profileSha256':go['profileSha256'],'originalProfileSha256':bridge,'amendmentSha256':amendment_sha,'appUpExecuted':False,'dataRestored':False},'ROLLBACK_DNS_ACCEPTANCE')
 return bridge
def main():
 global PHASE
 need(os.geteuid()==0 and socket.gethostname().split('.')[0]=='docker','ROOT_HOST')
 need(Path(__file__)==SOURCE/'sim-pg-disconnect-maintain.py','SEALED_SOURCE_LOCATION')
 need(sys.argv[1:] in [['--accept-existing-dns'],['--rollback']],'ACTION')
 action=sys.argv[1][2:]
 s=ROOT.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700,'STATE_DIRECTORY')
 lock=os.open(ROOT/'operation.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 try:
  s=os.fstat(lock);need(s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600,'LOCK_CUSTODY');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  profile,go=profile_and_go(action)
  profile_path,go_path=approval_paths(action)
  profile_before=protected(profile_path);go_before=protected(go_path)
  need(json.loads(profile_before)==profile and json.loads(go_before)==go,'APPROVAL_CHANGED_DURING_READ')
  if action=='accept-existing-dns':
   PHASE='existing_dns_post_acceptance';accept_existing_dns(profile,go,profile_before,go_before);return
  candidate=profile['candidateImage'];old=go['expectedImage'];new=candidate if action=='activate' else BASE
  pin_old=BASE if action=='activate' else candidate
  previous_path=ROOT/(go['releaseId']+'-activate.json')
  current=facts(profile,go,old)
  if action=='rollback':
   bridge=dns_reverse_acceptance(profile,go,current)
   prev=json.loads(protected(previous_path));need(prev['oldImage']==BASE and prev['newImage']==candidate and prev['lineage']==go['lineage'] and prev['profileSha256']==bridge and prev['runtimeSha256']==go['runtimeSha256'],'ROLLBACK_CURRENT_LINEAGE')
   need(all(go['layerFileSha256'][str(p)]==prev['layerFileSha256'][str(p)] for p in LAYERS[:-1]),'ROLLBACK_LAYER_DRIFT')
  PHASE='image_gate';image_gate(candidate)
  need(profile_and_go(action)==(profile,go),'POST_IMAGE_GO_DRIFT')
  need(inspect(NAME)['Id']==current['Id'],'POST_IMAGE_CID_DRIFT')
  facts(profile,go,old)
  need(protected(profile_path)==profile_before and protected(go_path)==go_before,'GO_DRIFT')
  fd,raw,_meta=pin_read(go);os.close(fd);replacement=changed_pin(raw,pin_old,new)
  if action=='rollback':need(sha(replacement)==prev['pinSha256'],'ROLLBACK_PIN_DRIFT')
  before=json.loads(command(DC+['config','--format','json']));critical_service_gate(before,current,json.loads(command(['docker','image','inspect',old]))[0]);expected=copy.deepcopy(before);expected['services']['sim-api']['image']=new
  if action=='rollback':need(digest(expected)==prev['composeSha256'],'ROLLBACK_COMPOSE_DRIFT')
  path=ROOT/(go['releaseId']+'-'+action+'.json')
  # Intent is durable BEFORE pin mutation. Failure never auto-retries or resets.
  PHASE='intent';intent_then_pin(action,profile,go,path,{'contract':'sim-image-only-maintenance-attempt-v1','oldImage':old,'newImage':new,'lineage':go['lineage'],'baselineCid':current['Id'],'pinSha256':sha(raw),'composeSha256':go['composeSha256'],'layerFileSha256':go['layerFileSha256'],'runtimeSha256':go['runtimeSha256'],'profileSha256':sha(profile_before),'phase':'intent_not_completion'},raw,replacement)
  PHASE='pin_written'
  rendered=json.loads(command(DC+['config','--format','json']));need(rendered==expected,'RENDERED_CANDIDATE_DRIFT')
  need(lineage()==go['lineage'] and inspect(NAME)['Id']==current['Id'],'PRE_RECREATE_DRIFT')
  need(protected(go_path)==go_before and time.time()<go['expiresAt'],'GO_EXPIRED_OR_CHANGED')
  check=copy.deepcopy(rendered);check['services']['sim-api']['image']=old
  critical_service_gate(check,inspect(NAME),json.loads(command(['docker','image','inspect',old]))[0])
  fresh_mutation_gate(action,profile,go)
  recreated=current['Image']!=new
  if recreated:
   PHASE='recreate';command(DC+['up','-d','--no-deps','--no-build','--pull','never','sim-api'])
  # Read-only wait, never repeat the mutating command.
  for _ in range(60):
   c=inspect(NAME)
   if c['Image']==new and c['State'].get('Health',{}).get('Status')=='healthy':break
   time.sleep(1)
  compose_metadata_gate(c,(COMPOSE_TARGET,) if recreated else (current['Config']['Labels'][COMPOSE_VERSION_LABEL],));compose_cli_gate()
  need(c['Image']==new and c['State'].get('Running') is True and c['State'].get('Health',{}).get('Status')=='healthy' and c.get('RestartCount')==(0 if recreated else current['RestartCount']) and digest(normalized_runtime(c))==go['runtimeSha256'],'POST_RUNTIME')
  need((c['Id']!=current['Id']) if recreated else (c['Id']==current['Id'] and c['State']['StartedAt']==current['State']['StartedAt']),'POST_CID_GENERATION')
  PHASE='post_acceptance';health();runtime_files(new);filesystem_gate(profile,go,c);need(lineage()==go['lineage'],'POST_LINEAGE_DRIFT')
  need(protected(profile_path)==profile_before and protected(go_path)==go_before and time.time()<go['expiresAt'],'POST_GO_DRIFT_OR_EXPIRY')
  receipt(ROOT/(go['releaseId']+'-'+action+'-complete.json'),{'completed':True,'cid':c['Id'],'image':new,'lineage':go['lineage'],'dataRestored':False})
  print(json.dumps({'status':'completed','action':action,'image':new,'cid':c['Id']}))
 finally:os.close(lock)
def run_cli():
 try:main()
 except (Stop,OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError,tarfile.TarError,UnicodeError) as error:
  code=str(error) if isinstance(error,Stop) and re.fullmatch('[A-Z_]{1,80}',str(error)) else 'SIM_MAINTAIN_FAILED_DETAILS_WITHHELD'
  print(json.dumps({'status':'stopped_requires_review','automaticRetry':False,'code':code,'phase':PHASE}));sys.exit(2)
if __name__=='__main__':run_cli()
