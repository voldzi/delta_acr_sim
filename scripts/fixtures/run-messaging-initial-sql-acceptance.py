"""New isolated PG/native SQL acceptance. Never contacts production services."""
import hashlib,json,os,select,subprocess,sys,time
from pathlib import Path
OWNER='sim-messaging-initial-sql-20261017'
BASE=Path('/srv/x5-production/staging/cop/cop-clean-whole12-956262c6abdb/messaging-initial-sql-v1')
PG='sha256:b07129cc272f688c98f5b343138a0a52fa45b3d82f50d7a53ff441330624cd2e'
NATIVE='sha256:c4ff9f063d6681b638ef87fe26b184f4dc2caa5d38f050289170ed329bddb2b5'
def docker(*args):return subprocess.check_output(['/usr/bin/docker',*args],stderr=subprocess.PIPE,timeout=120)
def info(cid):return json.loads(docker('inspect',cid))[0]
def start():
 assert sys.argv[1:]==['--isolated-only'] and os.getuid()==1000
 for image in [PG,NATIVE]:assert json.loads(docker('image','inspect',image))[0]['Id']==image
 assert docker('ps','-aq','--filter','label=cop.test.owner='+OWNER).strip()==b''
 for name in ['cop','messaging']:
  assert (BASE/name).is_dir() and not (BASE/name).is_symlink()
 pg=docker('run','-d','--name',OWNER+'-pg','--label','cop.test.owner='+OWNER,'--network','none','--memory','512m','--cpus','1','--tmpfs','/var/lib/postgresql:rw,size=768m','--tmpfs','/var/run/postgresql:rw,size=16m','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_INITDB_ARGS=--locale=C --encoding=UTF8',PG,'postgres','-c','cluster_name=sim_messaging_initial_acceptance_20261017').decode().strip()
 for i in range(60):
  r=subprocess.run(['/usr/bin/docker','exec',pg,'pg_isready','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  if r.returncode==0:break
  time.sleep(.5)
 else:raise RuntimeError('FRESH_PG_NOT_READY')
 def args(name):
  return ['run','-d','--name',OWNER+'-'+name,'--label','cop.test.owner='+OWNER,'--network','container:'+pg,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000','--memory','768m','--cpus','1','--tmpfs','/data:rw,size=128m,uid=1000,gid=1000,mode=0700','--tmpfs','/tmp:rw,size=64m,uid=1000,gid=1000,mode=0700','--tmpfs','/dev/shm:rw,size=64m,uid=1000,gid=1000,mode=0700']
 mounts=[]
 for source,target in [(BASE/'cop','/cop-source'),(BASE/'messaging','/message-source'),(BASE/'messaging-initial-sql-operator.py','/operator.py')]:
  mounts+=['--mount','type=bind,source='+str(source)+',target='+target+',readonly']
 operator=docker(*args('operator'),*mounts,'--entrypoint','/usr/local/bin/python',NATIVE,'-c','import time;time.sleep(86400)').decode().strip()
 native=docker(*args('native'),'--entrypoint','/usr/local/bin/python',NATIVE,'-c','import time;time.sleep(86400)').decode().strip()
 def step(mode):
  out=docker('exec',operator,'python','/operator.py',mode).decode()
  for line in out.splitlines():
   try:x=json.loads(line)
   except ValueError:continue
   print(json.dumps(x),flush=True)
 step('--prepare')
 send=subprocess.Popen(['/usr/bin/docker','exec',operator,'tar','-C','/dev/shm/initial-sql-private/native-config','-cf','-','.'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 r=subprocess.run(['/usr/bin/docker','exec','-i',native,'tar','-C','/data','-xf','-'],stdin=send.stdout,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30);send.stdout.close();assert send.wait()==0 and r.returncode==0
 docker('exec','-d',native,'sh','-c','exec python -m synapse.app.homeserver -c /data/homeserver.yaml > /data/native-test.log 2>&1')
 step('--register')
 docker('pause',native)
 def custody():
  a,b=info(native),info(pg)
  assert a['Id']==native and a['Image']==NATIVE and a['State']['Running'] and a['State']['Paused']
  assert b['Id']==pg and b['Image']==PG and b['State']['Running'] and b['HostConfig']['NetworkMode']=='none'
  assert a['HostConfig']['NetworkMode']=='container:'+pg and not a['HostConfig']['PortBindings'] and not b['HostConfig']['PortBindings']
  v={'native':{'id':native,'image':NATIVE,'paused':True,'pid':a['State']['Pid']},'pg':{'id':pg,'image':PG,'network':'none'}}
  return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 writer=custody()
 p=subprocess.Popen(['/usr/bin/docker','exec','-i',operator,'python','/operator.py','--install'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 p.stdin.write((json.dumps({'writerInventorySha256':writer})+'\n').encode());p.stdin.flush()
 deadline=time.monotonic()+180;proof=None
 try:
  while True:
   assert time.monotonic()<deadline
   ready,_,_=select.select([p.stdout],[],[],10)
   if not ready:continue
   line=p.stdout.readline()
   if not line:break
   x=json.loads(line)
   if x.get('kind')=='verify-isolated-paused-writer':
    assert custody()==writer
    p.stdin.write((json.dumps({'nonce':x['nonce'],'verifiedWriterDigest':writer})+'\n').encode());p.stdin.flush()
   else:
    print(json.dumps(x),flush=True)
    if x.get('contractVersion')=='actual-messaging-initial-sql-acceptance-v1':proof=x
  assert p.wait(timeout=10)==0 and proof
  proof={**proof,'pgContainer':pg,'nativeContainer':native,'operatorContainer':operator,'copRevision':'8776eb4','messagingRevision':'0876f91','actualNativeImage':NATIVE}
  (BASE/'public-receipt.json').write_text(json.dumps(proof)+'\n');print(json.dumps(proof),flush=True)
 finally:
  if p.poll() is None:p.kill();p.wait()
  # Preserve exact synthetic DB/RAM and paused writer for failure diagnostics.
if __name__=='__main__':
 try:start()
 except Exception as e:
  import traceback
  print(json.dumps({'error':'INITIAL_SQL_HOST_FAILED','type':type(e).__name__,'lines':[x.lineno for x in traceback.extract_tb(e.__traceback__)]}),flush=True);sys.exit(1)
