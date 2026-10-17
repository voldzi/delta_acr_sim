"""Root coordinator-only final four-flag transition. No identity or data reset."""
import json,os,socket
FLAGS=('CSM_ACCOUNT_ERASURE_ENABLED','CSM_ACCOUNT_ERASURE_OWNER_V2_ENABLED','CSM_ACCOUNT_ERASURE_LOCAL_CONTENT_ENABLED','CSM_COP_MOBILITY_EFFECTS_ERASURE_ENABLED')
def need(v,code='MESSAGING_ENABLE_UNPROVEN'):
 if not v:raise RuntimeError(code)
def validate_disabled(receipt,images):
 need(receipt.get('contractVersion')=='cop-messaging-disabled-runtime-result-v1' and receipt.get('runtimeReady')is True and receipt.get('erasureEnabled')is False and receipt.get('oldImageFallback')is False)
 bindings=receipt.get('containerBindings',{})
 need(set(bindings)=={'csm-messaging-api','csm-matrix-synapse'})
 for name,key in [('csm-messaging-api','messaging_api'),('csm-matrix-synapse','synapse')]:
  need(bindings[name]['image']==images[key] and len(bindings[name]['id'])==64)
 return bindings
REMOTE_PROGRAM=r'''
import fcntl,hashlib,json,os,shlex,socket,stat,subprocess,sys,time
from pathlib import Path
BASE=Path('/srv/csm-messaging');A='csm-messaging-api';N='csm-matrix-synapse'
FLAGS=('CSM_ACCOUNT_ERASURE_ENABLED','CSM_ACCOUNT_ERASURE_OWNER_V2_ENABLED','CSM_ACCOUNT_ERASURE_LOCAL_CONTENT_ENABLED','CSM_COP_MOBILITY_EFFECTS_ERASURE_ENABLED')
def need(v):
 if not v:raise RuntimeError('MESSAGING_ENABLE_UNPROVEN')
def run(a,t=60):
 p=subprocess.run(a,capture_output=True,timeout=t);need(p.returncode==0);return p.stdout
def inspect(n):return json.loads(run(['/usr/bin/docker','inspect',n]))[0]
def env(v):return dict(i.split('=',1)for i in v['Config']['Env']if'='in i)
def read(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and s.st_uid in[0,1000]and s.st_nlink==1 and not s.st_mode&0o022 and s.st_size<=1048576)
  raw=os.read(fd,1048577);z=os.fstat(fd);need(len(raw)==s.st_size and(s.st_ino,s.st_mtime_ns,s.st_ctime_ns)==(z.st_ino,z.st_mtime_ns,z.st_ctime_ns));return raw,s
 finally:os.close(fd)
def write_flags(path,raw,meta,old,new):
 import re
 keys=set();lines=[]
 for line in raw.decode().splitlines():
  match=re.match(r'^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=',line)
  if match and match[1]in FLAGS:
   need(match[1]not in keys and line.split('=',1)[1].strip()==old);keys.add(match[1]);lines.append(match[1]+'='+new)
  else:lines.append(line)
 need(keys==set(FLAGS));updated=('\n'.join(lines)+'\n').encode()
 temp=BASE/'.env.erasure-enable-new';fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  with os.fdopen(fd,'wb')as f:f.write(updated);os.fchown(f.fileno(),meta.st_uid,meta.st_gid);os.fsync(f.fileno())
  now=path.lstat();need((now.st_ino,now.st_mtime_ns,now.st_ctime_ns,now.st_size)==(meta.st_ino,meta.st_mtime_ns,meta.st_ctime_ns,meta.st_size)and path.read_bytes()==raw);os.replace(temp,path)
 finally:
  if temp.exists():temp.unlink()
 return updated
def main():
 need(os.getuid()==0 and socket.gethostname().split('.')[0]=='comm')
 x=json.load(sys.stdin);need(set(x)=={'contractVersion','expected'}and x['contractVersion']=='cop-messaging-enable-private-v1')
 fd=os.open(BASE/'.account-erasure-release.lock',os.O_WRONLY|os.O_NOFOLLOW);s=os.fstat(fd);need(s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 before={n:inspect(n)for n in[A,N]}
 for n,v in before.items():need(v['Id']==x['expected'][n]['id'] and v['Image']==x['expected'][n]['image'] and v['State']['Running']is True and not v['State']['Restarting'])
 oe=env(before[A]);need(all(oe.get(k)=='false'for k in FLAGS)and oe.get('CSM_ACCOUNT_ERASURE_AUTHORITY_MODE')=='database_v2')
 path=BASE/'.env';raw,meta=read(path);need(stat.S_IMODE(meta.st_mode)==0o600)
 labels=before[A]['Config']['Labels'];need(labels['com.docker.compose.project']=='csm-messaging'and labels['com.docker.compose.service']=='api'and labels['com.docker.compose.project.working_dir']==str(BASE))
 files=labels['com.docker.compose.project.config_files'].split(',');need(len(files)==len(set(files))and 1<=len(files)<=12)
 args=['/usr/bin/docker','compose','--project-name','csm-messaging','--project-directory',str(BASE),'--env-file',str(path),'--profile','matrix'];snap={}
 for filename in files:
  p=Path(filename);need(p.resolve()==p and(p.parent==BASE or p==BASE/'account-safety/disabled-runtime.compose.json'));snap[filename]=read(p)[0];args+=['-f',filename]
 oldconfig=json.loads(run(args+['config','--format','json']))
 updated=write_flags(path,raw,meta,'false','true');new=None
 try:
  config=json.loads(run(args+['config','--format','json']));oldapi=oldconfig['services']['api'];newapi=config['services']['api']
  need({k:v for k,v in oldapi.items()if k!='environment'}=={k:v for k,v in newapi.items()if k!='environment'})
  need({k:v for k,v in oldapi['environment'].items()if k not in FLAGS}=={k:v for k,v in newapi['environment'].items()if k not in FLAGS})
  need(all(str(newapi['environment'].get(k)).lower()=='true'for k in FLAGS))
  need({k:v for k,v in oldconfig['services'].items()if k!='api'}=={k:v for k,v in config['services'].items()if k!='api'})
  need(inspect(A)['Id']==before[A]['Id']and inspect(N)['Id']==before[N]['Id']);run(args+['up','-d','--no-deps','--no-build','--pull','never','api'],180)
  new=inspect(A);need(new['Id']!=before[A]['Id']and new['Image']==before[A]['Image']and new['State']['Running']is True)
  ne=env(new);need(all(ne.get(k)=='true'for k in FLAGS)and {k:v for k,v in ne.items()if k not in FLAGS}=={k:v for k,v in oe.items()if k not in FLAGS})
  need(new['Mounts']==before[A]['Mounts']and set(new['NetworkSettings']['Networks'])==set(before[A]['NetworkSettings']['Networks'])and new['HostConfig']['PortBindings']==before[A]['HostConfig']['PortBindings'])
  native=inspect(N);need(native['Id']==before[N]['Id']and native['State']['Running']is True)
  for filename,b in snap.items():need(read(Path(filename))[0]==b)
  probe='case CsmMessaging.AccountErasureAcceptance.verify() do {:ok, _} -> IO.puts("COP_ERASURE_ACCEPTANCE_OK"); _ -> raise "COP_ERASURE_ACCEPTANCE_FAILED" end'
  accepted=False
  for _ in range(30):
   p=subprocess.run(['/usr/bin/docker','exec',A,'/app/bin/csm_messaging','rpc',probe],capture_output=True,timeout=20)
   if p.returncode==0 and b'COP_ERASURE_ACCEPTANCE_OK'in p.stdout:accepted=True;break
   time.sleep(1)
  need(accepted)
  health=inspect(A)['State'].get('Health',{});need(health.get('Status')=='healthy')
  print(json.dumps({'contractVersion':'cop-messaging-enabled-runtime-result-v1','runtimeReady':True,'accountErasureAcceptanceVerified':True,'authorityMode':'database_v2','fourFlagsEnabled':True,'nonErasureEnvironmentPreserved':True,'nativeContainerPreserved':True,'containerBindings':{A:{'id':new['Id'],'image':new['Image']},N:x['expected'][N]},'oldImageFallback':False}),flush=True)
 except BaseException:
  # Do not resurrect the old writer. Stop only the exact candidate we created.
  current=inspect(A)
  if new is not None and current['Id']==new['Id']and current['Image']==before[A]['Image']:run(['/usr/bin/docker','stop','--time','20',current['Id']])
  currentraw,currentmeta=read(path)
  if currentraw==updated:write_flags(path,currentraw,currentmeta,'true','false')
  raise
if __name__=='__main__':
 try:main()
 except BaseException:
  print(json.dumps({'code':'MESSAGING_ENABLE_FAILED','oldImageFallback':False}),flush=True);raise SystemExit(2)
'''
def enable_messaging(host,remote,disabled_receipt,candidate_images):
 need(os.getuid()==0 and socket.gethostname().split('.')[0]=='docker')
 need(type(remote)is host.CommunicationResetTransport)
 expected=validate_disabled(disabled_receipt,candidate_images)
 raw=remote.run(['/usr/bin/python3','-I','-c',REMOTE_PROGRAM],input=json.dumps({'contractVersion':'cop-messaging-enable-private-v1','expected':expected}).encode(),timeout=900)
 need(len(raw)<=16384);result=json.loads(raw)
 need(result.get('contractVersion')=='cop-messaging-enabled-runtime-result-v1'and result.get('accountErasureAcceptanceVerified')is True and result.get('fourFlagsEnabled')is True and result.get('oldImageFallback')is False)
 return result
PAUSE_PROGRAM=REMOTE_PROGRAM.split('\ndef main():',1)[0]+r'''
def main():
 need(os.getuid()==0 and socket.gethostname().split('.')[0]=='comm')
 x=json.load(sys.stdin);need(set(x)=={'contractVersion','expected'}and x['contractVersion']=='cop-messaging-pause-private-v1')
 fd=os.open(BASE/'.account-erasure-release.lock',os.O_WRONLY|os.O_NOFOLLOW);s=os.fstat(fd);need(s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 before={n:inspect(n)for n in[A,N]}
 for n,v in before.items():need(v['Id']==x['expected'][n]['id']and v['Image']==x['expected'][n]['image'])
 need(all(env(before[A]).get(k)=='true'for k in FLAGS))
 path=BASE/'.env';raw,meta=read(path);write_flags(path,raw,meta,'true','false')
 need(inspect(A)['Id']==before[A]['Id']);run(['/usr/bin/docker','stop','--time','20',before[A]['Id']])
 after=inspect(A);need(after['Id']==before[A]['Id']and after['State']['Running']is False)
 need(inspect(N)['Id']==before[N]['Id'])
 print(json.dumps({'messagingCandidateStopped':True,'configurationFlagsDisabled':True,'oldImageFallback':False}),flush=True)
if __name__=='__main__':
 try:main()
 except BaseException:
  print(json.dumps({'code':'MESSAGING_CANDIDATE_PAUSE_FAILED'}),flush=True);raise SystemExit(2)
'''
def pause_enabled_messaging(host,remote,enabled_receipt):
 need(os.getuid()==0 and socket.gethostname().split('.')[0]=='docker'and type(remote)is host.CommunicationResetTransport)
 need(enabled_receipt.get('contractVersion')=='cop-messaging-enabled-runtime-result-v1'and enabled_receipt.get('fourFlagsEnabled')is True)
 r=json.loads(remote.run(['/usr/bin/python3','-I','-c',PAUSE_PROGRAM],input=json.dumps({'contractVersion':'cop-messaging-pause-private-v1','expected':enabled_receipt['containerBindings']}).encode(),timeout=90))
 need(r=={'messagingCandidateStopped':True,'configurationFlagsDisabled':True,'oldImageFallback':False});return r
