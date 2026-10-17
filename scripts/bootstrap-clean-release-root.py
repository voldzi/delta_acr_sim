#!/usr/bin/python3 -I
"""Root public-artifact bootstrap ONLY; no PG prompt/reset/activation.
Exact manifest SHA is supplied explicitly by the human-reviewed release command.
No downloaded code is imported before archive SHA and immutable image checks.
"""
import argparse,hashlib,json,os,posixpath,shutil,socket,stat,subprocess,tarfile,tempfile
from pathlib import Path
TARGET=Path('/srv/x5-production/staging/cop/clean-operator-shared-v3')
DEPS='sha256:2e61857d00f7fe0326a7b50a8f96f0cb4563d4d9028645dc08efe51b84e800df'
APP='sha256:28648cded21fbd52602a197693d0b0dc9eb213cd2bd84d6227b7da34c0cbab86'
REVISIONS={'cop':'8776eb4e4aab9517b1c26343aff2c709f0956438','messaging':'0876f91b5e4e28f20a2904b2c5b2355d5cfde56f'}
UUID='2f93f595-b61b-4eea-9054-7afa9b275b5b'
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C'}
def need(v,c):
 if not v:raise RuntimeError(c)
def sha(b):return hashlib.sha256(b).hexdigest()
def command(args,timeout=60):
 p=subprocess.run(args,stdin=subprocess.DEVNULL,capture_output=True,env=ENV,timeout=timeout)
 need(p.returncode==0,'ROOT_BOOTSTRAP_COMMAND_FAILED');return p.stdout
def context():
 need(os.getuid()==0 and socket.gethostname().split('.')[0]=='docker' and __import__('sys').flags.isolated==1,'ROOT_BOOTSTRAP_CONTEXT')
 need(command(['/usr/bin/findmnt','-n','-o','UUID','--mountpoint','/srv/x5-production']).decode().strip()==UUID,'ROOT_BOOTSTRAP_X5_UUID')
 need(Path('/srv/x5-production').resolve()==Path('/srv/x5-production') and Path('/srv/x5-production').stat().st_dev!=Path('/').stat().st_dev,'ROOT_BOOTSTRAP_X5_DEVICE')
 need(shutil.disk_usage('/srv/x5-production').free>=3*1024**3,'ROOT_BOOTSTRAP_HEADROOM')
def check_transports():
 """Before any PG password or writer freeze. No key copy/provision/agent."""
 for host in ['comm.home.cz','storage.home.cz']:
  p=subprocess.run(['/usr/bin/ssh','-F','/dev/null','-o','BatchMode=yes','-o','PasswordAuthentication=no','-o','KbdInteractiveAuthentication=no','-o','IdentityAgent=none','-o','ForwardAgent=no','-o','ForwardX11=no','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','UserKnownHostsFile=/home/voldzi/.ssh/known_hosts','-o','GlobalKnownHostsFile=/dev/null','-o','ConnectTimeout=8','voldzi@'+host,'/usr/bin/sudo','-n','/usr/bin/id','-u'],stdin=subprocess.DEVNULL,capture_output=True,env=ENV,timeout=20)
  need(p.returncode==0 and p.stdout==b'0\n','ROOT_EXISTING_TRANSPORT_UNAVAILABLE_'+host.split('.')[0].upper())
def public_bytes(path,maximum):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<=maximum,'ROOT_PUBLIC_ARTIFACT_SCOPE')
  b=b''
  while True:
   chunk=os.read(fd,1024*1024)
   if not chunk:break
   b+=chunk;need(len(b)<=maximum,'ROOT_PUBLIC_ARTIFACT_SIZE')
  t=os.fstat(fd);need((s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)==(t.st_dev,t.st_ino,t.st_size,t.st_mtime_ns,t.st_ctime_ns) and len(b)==s.st_size,'ROOT_PUBLIC_ARTIFACT_CHANGED')
  return b
 finally:os.close(fd)
def valid_member(member):
 name=member.name
 need(name and not name.startswith('/') and '..' not in Path(name).parts and '\0' not in name,'ROOT_ARCHIVE_PATH')
 return name
def extract(archive,destination,selector,allow_links):
 """Only root-owned fresh private destination; never follow archive symlinks."""
 destination.mkdir(mode=0o700,parents=True,exist_ok=True);links=[];count=total=0
 with tarfile.open(archive,'r:') as t:
  for m in t:
   name=valid_member(m)
   if not selector(name):continue
   count+=1;total+=m.size;need(count<100000 and total<1024**3,'ROOT_ARCHIVE_LIMIT')
   p=destination/name;need(p.parent.resolve().is_relative_to(destination.resolve()),'ROOT_ARCHIVE_PARENT')
   if m.isdir():p.mkdir(mode=0o700,parents=True,exist_ok=True)
   elif m.isfile():
    p.parent.mkdir(mode=0o700,parents=True,exist_ok=True);need(not p.exists() and not p.is_symlink(),'ROOT_ARCHIVE_DUPLICATE')
    with t.extractfile(m) as src,p.open('xb') as out:shutil.copyfileobj(src,out)
    p.chmod(0o700 if m.mode&0o111 else 0o600)
   elif allow_links and (m.issym() or m.islnk()):links.append((p,m.linkname,m.islnk(),name))
   else:need(False,'ROOT_ARCHIVE_SPECIAL_OR_LINK')
 for p,target,hard,name in links:
  need(not target.startswith('/') and '..' not in Path(posixpath.normpath(posixpath.join(posixpath.dirname(name),target))).parts,'ROOT_ARCHIVE_LINK_ESCAPE')
  p.parent.mkdir(mode=0o700,parents=True,exist_ok=True);need(not p.exists() and not p.is_symlink(),'ROOT_ARCHIVE_LINK_DUPLICATE')
  if hard:
   source=destination/target;need(source.is_file() and not source.is_symlink() and source.resolve().is_relative_to(destination),'ROOT_ARCHIVE_HARDLINK')
   shutil.copyfile(source,p)
  else:p.symlink_to(target)
def tree(root):
 return {str(p.relative_to(root)):sha(p.read_bytes()) for p in sorted(root.rglob('*')) if p.is_file() and not p.is_symlink()}
def freeze(root):
 for folder,dirs,files in os.walk(root,followlinks=False):
  for name in files:
   p=Path(folder)/name
   if not p.is_symlink():p.chmod(0o555 if p.stat().st_mode&0o111 else 0o444)
  for name in dirs:
   p=Path(folder)/name
   if not p.is_symlink():p.chmod(0o555)
 root.chmod(0o555)
def bootstrap_clean_release(manifest_path,expected_sha):
 """Re-export immutable images, never adopt an existing UID1000 runtime."""
 context();check_transports()
 raw=public_bytes(manifest_path,1048576);need(sha(raw)==expected_sha,'ROOT_RELEASE_MANIFEST_SHA')
 m=json.loads(raw);need(m['contractVersion']=='cop-sim-root-public-artifacts-v1' and set(m['archives'])=={'cop','sim','messaging'},'ROOT_RELEASE_MANIFEST_SCOPE')
 need(m['dependencyImage']==DEPS and m['copApiImage']==APP,'ROOT_RELEASE_IMAGE_PIN')
 for lane,revision in REVISIONS.items():need(m['archives'][lane]['revision']==revision,'ROOT_RELEASE_SOURCE_REVISION')
 need(len(m['archives']['sim']['revision'])==40 and all(c in '0123456789abcdef' for c in m['archives']['sim']['revision']),'ROOT_RELEASE_SIM_REVISION')
 verified={}
 for lane,item in m['archives'].items():
  need(Path(item['file']).name==item['file'],'ROOT_RELEASE_ARCHIVE_NAME')
  b=public_bytes(Path(manifest_path).parent/item['file'],512*1024**2)
  need(sha(b)==item['sha256'],'ROOT_RELEASE_ARCHIVE_SHA');verified[lane]=b
 need(not TARGET.exists() and not TARGET.is_symlink(),'ROOT_TRUSTED_RUNTIME_TARGET_OCCUPIED_DO_NOT_ADOPT')
 need(TARGET.parent.resolve()==TARGET.parent and TARGET.parent.stat().st_uid==0 and not TARGET.parent.stat().st_mode&0o022,'ROOT_BOOTSTRAP_PARENT')
 stage=Path(tempfile.mkdtemp(prefix='.clean-root-new-',dir=TARGET.parent));containers=[]
 try:
  for lane,image in [('dependency',DEPS),('candidate',APP)]:
   actual=json.loads(command(['/usr/bin/docker','image','inspect',image]))[0]['Id'];need(actual==image,'ROOT_RELEASE_IMAGE_CHANGED')
   cid=command(['/usr/bin/docker','create','--network','none','--label','cop.clean.bootstrap=public-artifact-only',image]).decode().strip();containers.append(cid)
   archive=stage/(lane+'.tar')
   command(['/usr/bin/docker','export','--output',str(archive),cid],180)
   if lane=='dependency':
    allowed={'usr/local/bin/node','lib/ld-musl-x86_64.so.1','lib/libc.musl-x86_64.so.1','usr/lib/libstdc++.so.6','usr/lib/libstdc++.so.6.0.34','usr/lib/libgcc_s.so.1'}
    extract(archive,stage/'runtime',lambda n:n in allowed,True)
   else:extract(archive,stage,lambda n:n=='app' or n.startswith('app/'),True)
   archive.unlink()
  original_dist=tree(stage/'app/apps/cop-api/dist');need(bool(original_dist),'ROOT_CANDIDATE_DIST_MISSING')
  sources={}
  for lane,b in verified.items():
   archive=stage/(lane+'-source.tar');archive.write_bytes(b)
   dest=stage/('overlay-cop' if lane=='cop' else lane)
   extract(archive,dest,lambda n:True,False);archive.unlink()
   if lane=='cop':
    need(not (dest/'apps/cop-api/dist').exists(),'ROOT_SOURCE_MUST_NOT_OVERWRITE_DIST')
    shutil.copytree(dest,stage/'app',dirs_exist_ok=True);shutil.rmtree(dest);dest=stage/'app'
   sources[lane]={'revision':m['archives'][lane]['revision'],'root':str(TARGET/('app' if lane=='cop' else lane)),
     'files':{k:v for k,v in tree(dest).items() if 'node_modules' not in Path(k).parts and Path(k).suffix in {'.py','.mjs','.json','.sql','.js','.ts'}}}
  need(tree(stage/'app/apps/cop-api/dist')==original_dist,'ROOT_ACTUAL_CANDIDATE_DIST_CHANGED')
  need(sha((stage/'runtime/usr/local/bin/node').read_bytes())=='c8726a01ce4ac245ea9e5cb483992a90e628e5847d98f9a9f3be048d09a50d75','ROOT_NODE_PIN')
  need(sha((stage/'runtime/lib/ld-musl-x86_64.so.1').read_bytes())=='38d022ce7425ff105ccfb53598f606e6e5f5f0a34bfbc793d65e6f34c9d72806','ROOT_LOADER_PIN')
  receipt={'contractVersion':'cop-sim-root-bootstrap-only-v1','manifestSha256':expected_sha,'sources':sources,'actualCandidateDistSha256':sha(json.dumps(original_dist,sort_keys=True).encode()),'dependencyImage':DEPS,'copApiImage':APP,'plansPrepared':0,'resetExecuted':False,'productionActivated':False}
  (stage/'bootstrap-public.json').write_text(json.dumps(receipt)+'\n');freeze(stage);stage.rename(TARGET)
  return receipt
 finally:
  for cid in containers:command(['/usr/bin/docker','rm',cid])
  # Preserve failed root-owned staging for review; never adopt or auto-delete.
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--check-existing-transports',action='store_true');p.add_argument('--bootstrap-public-manifest');p.add_argument('--manifest-sha256');a=p.parse_args()
 context()
 if a.check_existing_transports:
  need(not a.bootstrap_public_manifest,'ROOT_BOOTSTRAP_MODE');check_transports();print(json.dumps({'existingRootTransportsVerified':True,'postgresPasswordRequested':False}));return
 need(a.bootstrap_public_manifest and a.manifest_sha256 and len(a.manifest_sha256)==64 and all(c in '0123456789abcdef' for c in a.manifest_sha256),'ROOT_BOOTSTRAP_EXPLICIT_MANIFEST')
 r=bootstrap_clean_release(a.bootstrap_public_manifest,a.manifest_sha256)
 print(json.dumps({k:v for k,v in r.items() if k!='sources'}))
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'error':str(e) if isinstance(e,RuntimeError) else 'ROOT_BOOTSTRAP_FAILED','productionActivated':False}));raise SystemExit(1)
