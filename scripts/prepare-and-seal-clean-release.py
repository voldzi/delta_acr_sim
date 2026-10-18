#!/usr/bin/python3 -I
"""Root-only interactive preparation and explicit disabled reset.
No stored administrator password, automatic GO, key provisioning/network or model calls.
An explicitly approved fixed RAM-only transport is cleaned in the outer finally.
Run only from docker Root. Private config never leaves this process/child pipes.
"""
import argparse,contextlib,ctypes,getpass,hashlib,importlib.util,io,json,os,re,shlex,socket,stat,subprocess,sys,tarfile,time,uuid,types
from pathlib import Path
HERE=Path(__file__).resolve().parent
TARGET=Path('/srv/x5-production/staging/cop/clean-operator-shared-v3')
BASE=Path('/srv/cop/runtime/clean-reset')
RUNTIME_BINDING=Path('/srv/cop/runtime/api/active.json')
V4_MANIFEST=Path('/srv/x5-production/staging/cop/clean-release-public-20261017-v4/public-manifest-v4.json')
V4_MANIFEST_SHA='4f163f1a49ded1b9d805848ca913ac1f474b6500fc36ce48f992e3ae0280f6be'
V4_REPORT_SHA='66b6fb13c8a52c3d06f6aecafe3c9b101e5376cda3049988843e9d4961e0e38a'
V4_ARCHIVE=TARGET.with_name('clean-operator-shared-v3-preserved-v4-f4f0474')
FIXED_COP_REVISION='4ed81c5a5ea0772a8d83636473925f07fe92b389'
V5_MANIFEST=V4_MANIFEST.parent/'resume-2/public-manifest-v5.json'
V5_MANIFEST_SHA='3ef1c647ca905e59b30e0215d7560091d360203f7702c015a747a05e557ad8ad'
V5_ARCHIVE=TARGET.with_name('clean-operator-shared-v3-preserved-v5-4ed81c5')
V6_MANIFEST=V4_MANIFEST.parent/'resume-3/public-manifest-v6.json'
V6_MANIFEST_SHA='e3752ed80d7c001049beb0ac95bbeaa2bcdd754ceb5c940eadeea8447c6b62e1'
V6_ARCHIVE=TARGET.with_name('clean-operator-shared-v3-preserved-v6-3ec5366-sim15d8a75')
V9_MANIFEST=V4_MANIFEST.parent/'resume-6/public-manifest-v9.json'
V9_MANIFEST_SHA='d842c5556b41ed227ab39654d73ca9be382846c0dcd6fa1d768cdf8ca002531a'
V9_ARCHIVE=TARGET.with_name('clean-operator-shared-v3-preserved-v9-6c01ef7-sim08d81c3')
V11_MANIFEST=V4_MANIFEST.parent/'resume-8/public-manifest-v11.json'
V11_MANIFEST_SHA='208e495be91f20b8f94f1bbc10fcd072e9addeeadb6a36da887de99e0c222eb2'
V11_ARCHIVE=TARGET.with_name('clean-operator-shared-v3-preserved-v11-d089c91-sim08d81c3')
TRANSITION_COP_REVISION='d4fdca88a74ba59a7ac81092c70c15ab780a1b9c'
TRANSITION_COP_ARCHIVE='cop-d4fdca8-public.tar'
TRANSITION_COP_ARCHIVE_SHA='2ee830a11ce2cf09170b4f8fa93dfa0292f235de705fd5b7682cbc641596e543'
TRANSITION_ACCEPTANCE_MEMBER='scripts/account-safety/clean-release-acceptance.py'
TRANSITION_ACCEPTANCE_SHA='d9a7bb767742a7e93e139a1ae8ad81d65d30f8722323eb1c0c98477014517ca4'
TRANSITION_RECOVERY_MEMBER='scripts/account-safety/preserve-prepared-v11.py'
TRANSITION_RECOVERY_SHA='a56cc2da42a37ce9fceae7e95caec3eeb54eeb3aca6f68d2c76f4e4151fe2be2'
COP_RUNTIME_SOURCE_SHA='ef033dbeb103ba630f4613f90922198b71be72b93ad878ae707de5342364f6c9'
COMMON_FAILURE_CODES=frozenset(['COMMON_BASE_CLEAN_EPOCH','COMMON_CA_MISSING','COMMON_CLOSURE_MISSING','COMMON_CLOSURE_PREFLIGHT_MISSING','COMMON_COMPLETED_REPLAY_MODE','COMMON_CONFIG_EPOCH','COMMON_DEPLOY_GUARD_CHANGED','COMMON_DEPLOY_GUARD_CONFIGURATION','COMMON_DEPLOY_GUARD_CUSTODY','COMMON_DEPLOY_GUARD_PRESERVATION','COMMON_DEPLOY_GUARD_SOURCE','COMMON_DEPLOY_GUARD_UNKNOWN','COMMON_ENV_CHANGED','COMMON_ENV_CUSTODY','COMMON_ENV_DUPLICATE','COMMON_ENV_PARENT','COMMON_ENV_VALUE','COMMON_EXISTING_IDENTITY_MISSING','COMMON_ISSUER_CHANGED','COMMON_MESSAGING_INSTALL_MISSING','COMMON_NEW_SECRET_FORMAT','COMMON_OUTPUT_CHANGED','COMMON_OUTPUT_EXISTS','COMMON_OUTPUT_PATH','COMMON_OUTPUT_READBACK','COMMON_PLAN_CHANGED','COMMON_ROOT_REQUIRED','COMMON_ROUTER_HASH_CHANGED','COMMON_SIM_RUNTIME_MODE','COMMON_SIM_SOURCE_HASH','COMMON_SIM_SOURCE_NOT_ENROLLED','COMMON_SOURCE_CHANGED','COMMON_SOURCE_CUSTODY','COMMON_SOURCE_HASH','COMMON_SOURCE_NOT_ENROLLED','COMMON_SOURCE_PATH','COMMON_WHOLE_PROOF_CHANGED'])
RETIREMENT_PROBE_SHA='7940e142da215f3d28c413dd59344da2210220972d923d247c69e69709947a5b'
KEYCLOAK_PREPARATION_SHA='48db373f5d8cff560ae9365dd8f4ea569677342dc31ca2cc917e463394d5e045'
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C'}
BOOTSTRAP_SHA='8679eb2debec377927a15c40a4e4432d5ef43bf01031d8860bb5ab6986a1bdc9'
TEMP_KEY_HELPER=Path('/home/voldzi/cop-clean-release-temporary-comm-key.py')
TEMP_KEY_SHA='87ea81867ac8bdb3605b7b186c550710b7b9ac268da7667b1b6ce60b22dd852a'
TEMP_AUTHORIZE=Path('/home/voldzi/temporary-comm-authorize.py')
TEMP_AUTHORIZE_SHA='70a0f585254c7f3e0cce91c4c5e8a4d90d761c4db4c401473641002bbba5562a'
TEMP_PEER_HELPER=Path('/home/voldzi/temporary-release-key.py')
TEMP_PEER_HELPER_SHA='446508abf4eb990cb0b0b61d22fd703fd5eee2c152db1a41f922b76e041ad0b8'
def need(v,c):
 if not v:raise RuntimeError(c)
def sha(b):return hashlib.sha256(b).hexdigest()
def transition_module(bootstrap_module,manifest,manifest_path,relative):
 """Explicitly reviewed new validator, before replacing the old public bundle.
 Never monkeypatch the old module, change report bytes/time or extract code to
 disk. The exact new COP archive and fixed regular member are verified first.
 """
 need(os.getuid()==0 and socket.gethostname().split('.')[0]=='docker' and sys.flags.isolated,'RELEASE_TRANSITION_ACCEPTANCE_CONTEXT')
 cop=manifest['archives']['cop']
 need(cop['revision']==bootstrap_module.REVISIONS['cop']==TRANSITION_COP_REVISION and cop['file']==TRANSITION_COP_ARCHIVE and cop['sha256']==TRANSITION_COP_ARCHIVE_SHA,'RELEASE_TRANSITION_ACCEPTANCE_SOURCE')
 pins={TRANSITION_ACCEPTANCE_MEMBER:TRANSITION_ACCEPTANCE_SHA,TRANSITION_RECOVERY_MEMBER:TRANSITION_RECOVERY_SHA}
 need(relative in pins,'RELEASE_TRANSITION_SOURCE_SCOPE')
 path=Path(manifest_path).parent/TRANSITION_COP_ARCHIVE
 archive=bootstrap_module.public_bytes(path,512*1024**2)
 need(sha(archive)==TRANSITION_COP_ARCHIVE_SHA,'RELEASE_TRANSITION_ACCEPTANCE_ARCHIVE_SHA')
 with tarfile.open(fileobj=io.BytesIO(archive),mode='r:')as bundle:
  members=bundle.getmembers();need(len(members)<=100000,'RELEASE_TRANSITION_ACCEPTANCE_ARCHIVE_LIMIT')
  matches=[m for m in members if m.name==relative]
  need(len(matches)==1 and matches[0].isfile()and 0<matches[0].size<=1048576,'RELEASE_TRANSITION_ACCEPTANCE_MEMBER')
  stream=bundle.extractfile(matches[0]);need(stream is not None,'RELEASE_TRANSITION_ACCEPTANCE_MEMBER')
  with stream:source=stream.read(1048577)
  need(len(source)==matches[0].size and sha(source)==pins[relative],'RELEASE_TRANSITION_ACCEPTANCE_SOURCE_SHA')
 module=types.ModuleType('verified_transition_acceptance')
 module.__file__=str(path)+'!/'+relative
 exec(compile(source,module.__file__,'exec'),module.__dict__)
 return module
def validate_transition_acceptance(bootstrap_module,manifest,manifest_path,raw):
 need(isinstance(raw,bytes)and sha(raw)==manifest['acceptanceReport']['sha256']==V4_REPORT_SHA,'RELEASE_TRANSITION_ACCEPTANCE_REPORT')
 module=transition_module(bootstrap_module,manifest,manifest_path,TRANSITION_ACCEPTANCE_MEMBER)
 need(module.REPORT==BASE/'whole12-acceptance.json'and callable(getattr(module,'validate_clean_whole_report_bytes',None)),'RELEASE_TRANSITION_ACCEPTANCE_INTERFACE')
 value=module.validate_clean_whole_report_bytes(raw,manifest['candidateImages'],time.time())
 need(value.get('reportSha256')==V4_REPORT_SHA,'RELEASE_TRANSITION_ACCEPTANCE_BINDING')
 return value
def load(path,name):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def verified_bootstrap_code():
 # Verify bytes before executing a neighboring public helper; no hash/import race.
 path=HERE/'bootstrap-clean-release-root.py'
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<1048576,'RELEASE_BOOTSTRAP_SCOPE')
  raw=os.read(fd,1048576);need(len(raw)==s.st_size and sha(raw)==BOOTSTRAP_SHA,'RELEASE_BOOTSTRAP_CODE_SHA')
 finally:os.close(fd)
 module=types.ModuleType('verified_bootstrap');module.__file__=str(path)
 exec(compile(raw,str(path),'exec'),module.__dict__)
 return module
def root_read(path,max_size=1048576):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and not s.st_mode&0o022 and s.st_size<=max_size,'RELEASE_ROOT_FILE_CUSTODY')
  b=os.read(fd,max_size+1);t=os.fstat(fd);need(len(b)==s.st_size and (s.st_ino,s.st_mtime_ns,s.st_ctime_ns)==(t.st_ino,t.st_mtime_ns,t.st_ctime_ns),'RELEASE_ROOT_FILE_CHANGED');return b
 finally:os.close(fd)
def directory_identity(s):return (s.st_dev,s.st_ino,s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))
def open_control_parent():
 need(os.geteuid()==0 and socket.gethostname().split('.')[0]=='docker','RELEASE_CONTROL_ROOT_CONTEXT')
 flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW;fds=[];chain=[]
 try:
  fd=os.open('/',flags);fds.append(fd);s=os.fstat(fd)
  need(stat.S_ISDIR(s.st_mode)and s.st_uid==0 and not s.st_mode&0o022,'RELEASE_CONTROL_ANCESTRY')
  chain.append((Path('/'),directory_identity(s)));path=Path('/')
  for part in ['srv','cop','runtime']:
   fd=os.open(part,flags,dir_fd=fds[-1]);fds.append(fd);s=os.fstat(fd);path/=part
   need(stat.S_ISDIR(s.st_mode),'RELEASE_CONTROL_ANCESTRY')
   if part=='srv':need(s.st_uid==0 and not s.st_mode&0o022,'RELEASE_CONTROL_ANCESTRY')
   else:need((s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(1000,1000,0o755 if part=='cop'else 0o700),'RELEASE_CONTROL_PARENT_CUSTODY')
   chain.append((path,directory_identity(s)))
  return fds.pop(),chain
 finally:
  for fd in reversed(fds):os.close(fd)
def check_control_parent(chain):
 for path,expected in chain:
  s=path.lstat();need(stat.S_ISDIR(s.st_mode)and directory_identity(s)==expected,'RELEASE_CONTROL_PARENT_CAS')
def ensure_control_directory(accepted_report_sha=None,require_existing=False):
 need(BASE==Path('/srv/cop/runtime/clean-reset'),'RELEASE_CONTROL_FIXED_SCOPE')
 parent,chain=open_control_parent();child=None
 def inventory():
  out={}
  for name in sorted(os.listdir(parent)):
   if name==BASE.name:continue
   s=os.stat(name,dir_fd=parent,follow_symlinks=False)
   out[name]=(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
  return out
 try:
  check_control_parent(chain);before=inventory();created=BASE.name not in os.listdir(parent)
  need(not require_existing or not created,'RELEASE_CONTROL_EXISTING_REQUIRED')
  if created:os.mkdir(BASE.name,0o700,dir_fd=parent)
  child=os.open(BASE.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
  s=os.fstat(child)
  need(stat.S_ISDIR(s.st_mode)and(s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(0,0,0o700),'RELEASE_CONTROL_DIRECTORY_CUSTODY')
  names=set(os.listdir(child))
  need(not names or(accepted_report_sha==V4_REPORT_SHA and names=={'whole12-acceptance.json'}),'RELEASE_CONTROL_DIRECTORY_CUSTODY')
  if names:
   report=BASE/'whole12-acceptance.json';r=report.lstat()
   need((r.st_uid,r.st_gid,stat.S_IMODE(r.st_mode),r.st_nlink)==(0,0,0o600,1),'RELEASE_CONTROL_REPORT_CUSTODY')
   need(sha(root_read(report))==accepted_report_sha,'RELEASE_CONTROL_REPORT_SHA')
  need(not require_existing or names=={'whole12-acceptance.json'},'RELEASE_CONTROL_REPORT_REQUIRED')
  if created:os.fchown(child,0,0);os.fchmod(child,0o700);os.fsync(child);os.fsync(parent)
  after=os.fstat(child);path=os.stat(BASE.name,dir_fd=parent,follow_symlinks=False)
  need(directory_identity(after)==directory_identity(path)and(after.st_uid,after.st_gid,stat.S_IMODE(after.st_mode))==(0,0,0o700),'RELEASE_CONTROL_DIRECTORY_CAS')
  check_control_parent(chain);need(inventory()==before,'RELEASE_CONTROL_SIBLINGS_CHANGED')
  return {'controlDirectoryPrepared':True,'created':created,'existingRuntimeUnchanged':True}
 finally:
  if child is not None:os.close(child)
  os.close(parent)
def rename_public_bundle_noreplace(parent,source,destination):
 """Atomic no-replace rename only; no copy, deletion or overwrite fallback."""
 libc=ctypes.CDLL(None,use_errno=True)
 if sys.platform=='linux':fn=libc.renameat2;flag=1
 elif sys.platform=='darwin':fn=libc.renameatx_np;flag=4
 else:raise RuntimeError('RELEASE_TRANSITION_PLATFORM')
 fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
 if fn(parent,os.fsencode(source),parent,os.fsencode(destination),flag):raise OSError(ctypes.get_errno(),'RELEASE_TRANSITION_RENAME_FAILED')
def preserve_public_v4(bootstrap_module,new_manifest,manifest_path,*,from_v5=False,from_v6=False,from_v9=False,from_v11=False):
 """Preserve exact public V4, never adopt or remove a prior operation.
 Root must directly inventory BASE; a prior error/EACCES proves no absence.
 Failure preserves evidence for manual review, with no automatic rollback.
 """
 bootstrap_module.context()
 need(sum([from_v5,from_v6,from_v9,from_v11])<=1,'RELEASE_TRANSITION_MODE')
 old_manifest=V11_MANIFEST if from_v11 else V9_MANIFEST if from_v9 else V6_MANIFEST if from_v6 else V5_MANIFEST if from_v5 else V4_MANIFEST
 old_sha=V11_MANIFEST_SHA if from_v11 else V9_MANIFEST_SHA if from_v9 else V6_MANIFEST_SHA if from_v6 else V5_MANIFEST_SHA if from_v5 else V4_MANIFEST_SHA
 destination=V11_ARCHIVE if from_v11 else V9_ARCHIVE if from_v9 else V6_ARCHIVE if from_v6 else V5_ARCHIVE if from_v5 else V4_ARCHIVE
 fixed_name='clean-operator-shared-v3-preserved-v11-d089c91-sim08d81c3'if from_v11 else'clean-operator-shared-v3-preserved-v9-6c01ef7-sim08d81c3'if from_v9 else'clean-operator-shared-v3-preserved-v6-3ec5366-sim15d8a75'if from_v6 else'clean-operator-shared-v3-preserved-v5-4ed81c5'if from_v5 else'clean-operator-shared-v3-preserved-v4-f4f0474'
 need(TARGET==Path('/srv/x5-production/staging/cop/clean-operator-shared-v3')and destination==TARGET.with_name(fixed_name),'RELEASE_TRANSITION_FIXED_PATHS')
 raw=bootstrap_module.public_bytes(old_manifest,1048576)
 need(sha(raw)==old_sha,'RELEASE_TRANSITION_OLD_MANIFEST_SHA');old=json.loads(raw)
 candidate=json.loads(json.dumps(new_manifest))
 if from_v11:
  need(old['archives']['cop']['revision']=='d089c9129c3798a7fbfe3d77e2bc4a052c770f16'and old['archives']['sim']['revision']=='08d81c335b362146c81e269c0c1e412b3e9d1ba9','RELEASE_TRANSITION_OLD_REVISIONS')
  need(candidate['archives']['cop']['revision']==bootstrap_module.REVISIONS['cop']==TRANSITION_COP_REVISION and candidate['archives']['sim']['revision']==bootstrap_module.REVISIONS['sim']=='e5b8128c4087f078117815fe12e2e110096f15dc','RELEASE_TRANSITION_NEW_REVISIONS')
  for lane in ['cop','sim']:candidate['archives'][lane]=old['archives'][lane]
 elif from_v9:
  need(old['archives']['cop']['revision']=='6c01ef77cee511397e83f44aaa8ede8d13aeaa06'and old['archives']['sim']['revision']=='08d81c335b362146c81e269c0c1e412b3e9d1ba9','RELEASE_TRANSITION_OLD_REVISIONS')
  need(candidate['archives']['cop']['revision']==bootstrap_module.REVISIONS['cop']==TRANSITION_COP_REVISION and candidate['archives']['sim']==old['archives']['sim'],'RELEASE_TRANSITION_NEW_REVISIONS')
  candidate['archives']['cop']=old['archives']['cop']
 elif from_v6:
  need(old['archives']['cop']['revision']=='3ec5366e4de676cf68fddae50c0df625df39c284'and old['archives']['sim']['revision']=='15d8a75f1a260f1946e35774e727a2636decc841','RELEASE_TRANSITION_OLD_REVISIONS')
  need(candidate['archives']['cop']['revision']==bootstrap_module.REVISIONS['cop']=='6c01ef77cee511397e83f44aaa8ede8d13aeaa06'and candidate['archives']['sim']['revision']==bootstrap_module.REVISIONS['sim']=='08d81c335b362146c81e269c0c1e412b3e9d1ba9','RELEASE_TRANSITION_NEW_REVISIONS')
  for lane in ['cop','sim']:candidate['archives'][lane]=old['archives'][lane]
 else:
  old_revision=FIXED_COP_REVISION if from_v5 else 'f4f0474ec5c5697010b9bdfddb58fac3f1786610'
  new_revision=bootstrap_module.REVISIONS['cop']if from_v5 else FIXED_COP_REVISION
  need(candidate['archives']['cop']['revision']==new_revision and new_revision!=old_revision,'RELEASE_TRANSITION_NEW_COP_REVISION')
  need(old['archives']['cop']['revision']==old_revision,'RELEASE_TRANSITION_OLD_COP_REVISION')
  candidate['archives']['cop']=old['archives']['cop']
 need(candidate==old and new_manifest['acceptanceReport']['sha256']==V4_REPORT_SHA,'RELEASE_TRANSITION_SCOPE_CHANGED')
 previous=verify_bootstrap(old_sha)
 need(previous.get('plansPrepared')==0 and previous.get('resetExecuted')is False and previous.get('productionActivated')is False,'RELEASE_TRANSITION_OLD_RECEIPT')
 need({k:v['revision']for k,v in previous['sources'].items()}=={k:v['revision']for k,v in old['archives'].items()},'RELEASE_TRANSITION_OLD_SOURCE_REVISION')
 ensure_control_directory(V4_REPORT_SHA,require_existing=True)
 proof_raw=root_read(BASE/'whole12-acceptance.json')
 if from_v9 or from_v11:
  # The old immutable validator has no authority to recognize the explicitly
  # approved finite age exception. Use only the new exact pinned source here.
  validate_transition_acceptance(bootstrap_module,new_manifest,manifest_path,proof_raw)
 else:
  old_host=load(Path(previous['sources']['cop']['root'])/'scripts/account-safety/clean-reset-root.py','transition_old_public_gate')
  old_host._acceptance_module().validate_clean_whole_report_v3(json.loads(proof_raw),new_manifest['candidateImages'],time.time())
 for item in new_manifest['archives'].values():
  need(Path(item['file']).name==item['file'],'RELEASE_TRANSITION_ARCHIVE_NAME')
  archive=bootstrap_module.public_bytes(Path(manifest_path).parent/item['file'],512*1024**2)
  need(sha(archive)==item['sha256'],'RELEASE_TRANSITION_ARCHIVE_SHA')
 parent=TARGET.parent
 need(parent.resolve()==parent,'RELEASE_TRANSITION_PARENT_PATH')
 fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  p=os.fstat(fd);need((p.st_uid,p.st_gid,stat.S_IMODE(p.st_mode))==(0,0,0o755),'RELEASE_TRANSITION_PARENT_CUSTODY')
  before=os.stat(TARGET.name,dir_fd=fd,follow_symlinks=False)
  need(stat.S_ISDIR(before.st_mode)and(before.st_uid,before.st_gid,stat.S_IMODE(before.st_mode))==(0,0,0o555),'RELEASE_TRANSITION_SOURCE_CUSTODY')
  need(destination.name not in os.listdir(fd),'RELEASE_TRANSITION_ARCHIVE_EXISTS')
  ensure_control_directory(V4_REPORT_SHA,require_existing=True)
  now=os.stat(TARGET.name,dir_fd=fd,follow_symlinks=False)
  need((before.st_dev,before.st_ino,before.st_mtime_ns,before.st_ctime_ns)==(now.st_dev,now.st_ino,now.st_mtime_ns,now.st_ctime_ns),'RELEASE_TRANSITION_SOURCE_CHANGED')
  need(directory_identity(parent.lstat())==directory_identity(p),'RELEASE_TRANSITION_PARENT_CHANGED')
  rename_public_bundle_noreplace(fd,TARGET.name,destination.name);os.fsync(fd)
  saved=os.stat(destination.name,dir_fd=fd,follow_symlinks=False)
  need(directory_identity(saved)==directory_identity(before)and TARGET.name not in os.listdir(fd),'RELEASE_TRANSITION_RENAME_UNPROVEN')
 finally:os.close(fd)
 return {'publicV11Preserved'if from_v11 else'publicV9Preserved'if from_v9 else'publicV6Preserved'if from_v6 else'publicV5Preserved'if from_v5 else'publicV4Preserved':True,'priorOperationAdopted':False,'productionActivated':False}
def read_current_runtime_binding(expected):
 path=RUNTIME_BINDING;need(path.resolve()==path,'RELEASE_RUNTIME_POINTER_PATH')
 parent=path.parent.lstat();need(stat.S_ISDIR(parent.st_mode)and(parent.st_uid,parent.st_gid,stat.S_IMODE(parent.st_mode))==(1000,1000,0o700),'RELEASE_RUNTIME_POINTER_PARENT')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and(s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(1000,1000,0o600)and s.st_nlink==1 and s.st_size<=65536,'RELEASE_RUNTIME_POINTER_CUSTODY')
  raw=os.read(fd,65537);t=os.fstat(fd);p=path.lstat()
  need(len(raw)==s.st_size and(s.st_dev,s.st_ino,s.st_mtime_ns,s.st_ctime_ns)==(t.st_dev,t.st_ino,t.st_mtime_ns,t.st_ctime_ns)==(p.st_dev,p.st_ino,p.st_mtime_ns,p.st_ctime_ns),'RELEASE_RUNTIME_POINTER_CAS')
 finally:os.close(fd)
 value=json.loads(raw)
 need(isinstance(value,dict)and set(value)=={'contractVersion','generation','releaseId','profileId','profileGeneration','imageId','containerId'}and value['contractVersion']=='cop-api-runtime-active-v1','RELEASE_RUNTIME_POINTER_SCHEMA')
 need(isinstance(value['generation'],str)and re.fullmatch('[a-f0-9]{32}',value['generation'])and isinstance(value['releaseId'],str)and re.fullmatch('release-[a-f0-9]{32}',value['releaseId']),'RELEASE_RUNTIME_POINTER_SCHEMA')
 need(isinstance(value['profileId'],str)and str(uuid.UUID(value['profileId']))==value['profileId']and value['profileGeneration']==value['profileId'],'RELEASE_RUNTIME_POINTER_SCHEMA')
 need(value['containerId']==expected['id']and value['imageId']==expected['image']and re.fullmatch('[a-f0-9]{64}',value['containerId'])and re.fullmatch('sha256:[a-f0-9]{64}',value['imageId']),'RELEASE_RUNTIME_POINTER_ACTUAL_MISMATCH')
 return value
def pinned_public_module(path,digest,name):
 # Public setup files may belong to UID1000. Exact bytes, not ownership, pin
 # executable authority. Never import the path again after checking its hash.
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<1048576,'RELEASE_TEMP_HELPER_SCOPE')
  raw=os.read(fd,1048576);need(len(raw)==s.st_size and sha(raw)==digest,'RELEASE_TEMP_HELPER_SHA')
 finally:os.close(fd)
 m=types.ModuleType(name);m.__file__=str(path);exec(compile(raw,str(path),'exec'),m.__dict__);return m
def cleanup_temporary_transport():
 # Runs even when bootstrap/preflight/confirmation fails. Inner phase close()
 # calls have already unwound; this is the sole lifetime owner of the RAM key.
 if os.path.lexists('/run/cop-clean-reset-peers'):
  helper=pinned_public_module(TEMP_PEER_HELPER,TEMP_PEER_HELPER_SHA,'release_peer_key_cleanup')
  result=helper.cleanup_release_identity()
  print(json.dumps({'temporaryPeerTransportCleanup':result}),flush=True)
  need(isinstance(result,dict)and set(result)=={'peers','controlPeers','controlSessionsClosed','temporaryPrivateIdentityRemoved','exactAuthorizationsAbsent'}and all(isinstance(result[k],dict)and set(result[k])=={'comm.home.cz','storage.home.cz'}and all(v is True for v in result[k].values())for k in ['peers','controlPeers'])and result['temporaryPrivateIdentityRemoved']is True and result['exactAuthorizationsAbsent']is True and result['controlSessionsClosed']is True,'RELEASE_PEER_CLEANUP_NOT_VERIFIED')
  return
 if not os.path.lexists('/run/cop-clean-reset-comm/temporary-identity.json'):return
 bootstrap=verified_bootstrap_code()
 helper=pinned_public_module(TEMP_KEY_HELPER,TEMP_KEY_SHA,'release_temp_key')
 authorize=pinned_public_module(TEMP_AUTHORIZE,TEMP_AUTHORIZE_SHA,'release_temp_authorize')
 class CleanupOnlyTransport:
  def open(self):need(bootstrap.temporary_comm_identity() is not None,'RELEASE_TEMP_IDENTITY_MISSING')
  def run(self,args,*,input=None,timeout=45):
   need(args==['/usr/bin/python3','-I','-c',authorize.REMOTE_PROGRAM,'remove'],'RELEASE_TEMP_CLEANUP_COMMAND_SCOPE')
   base=bootstrap.transport_args('comm.home.cz')
   need(base[-5:]==['voldzi@comm.home.cz','/usr/bin/sudo','-n','/usr/bin/id','-u'],'RELEASE_TEMP_TRANSPORT_SCOPE')
   r=subprocess.run(base[:-4]+[shlex.join(['/usr/bin/sudo','-n',*args])],input=input,capture_output=True,env=ENV,timeout=timeout)
   need(r.returncode==0,'RELEASE_TEMP_AUTHORIZATION_REMOVE_FAILED');return r.stdout
  def close(self):pass
 result=helper.cleanup_temporary_comm_key(types.SimpleNamespace(CommunicationResetTransport=CleanupOnlyTransport))
 need(result=={'temporaryPrivateIdentityRemoved':True,'exactAuthorizationAbsent':True},'RELEASE_TEMP_CLEANUP_NOT_VERIFIED')
 print(json.dumps({'temporaryTransportCleanup':result}))
def safe_failure_code(error):
 if isinstance(error,NameError) and isinstance(error.name,str) and re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,63}',error.name):return 'UNDEFINED_NAME_'+error.name
 # Never print arbitrary exception text, filenames, stderr or private payloads.
 if isinstance(error,RuntimeError)and len(error.args)==1 and isinstance(error.args[0],str)and re.fullmatch(r'(?:ROOT|RELEASE|RESET|CLEAN|SIM|MESSAGING|RETIREMENT)_[A-Z0-9_]{1,90}',error.args[0]):return error.args[0]
 if isinstance(error,RuntimeError)and len(error.args)==1 and isinstance(error.args[0],str)and error.args[0]in COMMON_FAILURE_CODES:return error.args[0]
 # The pinned COP runtime defines its own RuntimeError class. Recognize that
 # exact loaded class through its require frame, not a class-name/prefix match.
 # Only literals from the exact verified public source may reach the output.
 try:
  path=TARGET/'app/scripts/cop-api-runtime.py'
  frame=error.__traceback__
  while frame is not None:
   f=frame.tb_frame
   if(f.f_code.co_name=='require'and f.f_code.co_filename==str(path)
      and f.f_globals.get('__file__')==str(path)and type(error)is f.f_globals.get('RuntimeError')):
    raw=root_read(path);need(sha(raw)==COP_RUNTIME_SOURCE_SHA,'RELEASE_RUNTIME_DIAGNOSTIC_SOURCE')
    ast=__import__('ast');tree=ast.parse(raw)
    codes={n.args[-1].value for n in ast.walk(tree)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='require'and len(n.args)>=2 and isinstance(n.args[-1],ast.Constant)and isinstance(n.args[-1].value,str)}
    if len(error.args)==1 and isinstance(error.args[0],str)and error.args[0]in codes and re.fullmatch('[a-z][a-z0-9_]{1,100}',error.args[0]):return 'COP_RUNTIME_'+error.args[0].upper()
   frame=frame.tb_next
 except Exception:pass
 if isinstance(error,OSError):return 'OS_ERROR_'+str(error.errno if isinstance(error.errno,int)else 'UNKNOWN')
 return 'UNCLASSIFIED_'+type(error).__name__
def execution_phase(stage,action):
 need(stage in {'prepared_v11_preservation','work_child_provision','activation_module_load','activation_adapter_load','pre_stop_health_capture','common_module_load','common_reset','production_activation'},'RELEASE_EXECUTION_STAGE')
 try:return action()
 except Exception as error:
  print(json.dumps({'releaseExecutionFailure':{'stage':stage,'code':safe_failure_code(error)}}),flush=True)
  raise
def actual_retirement_preflight():
 """Execute the unchanged pinned read-only probe and require clear producers.
 Capturing its fixed public JSON avoids altering the already-reviewed probe.
 Nothing is accepted from a caller or synthesized from an absent cron line.
 """
 path=HERE/'inspect-retired-report-profile.py'
 probe=pinned_public_module(path,RETIREMENT_PROBE_SHA,'release_actual_retirement_preflight')
 arguments=sys.argv;output=io.StringIO()
 try:
  sys.argv=[str(path)]
  with contextlib.redirect_stdout(output):probe.main()
 finally:sys.argv=arguments
 raw=output.getvalue();need(len(raw)<=1048576,'RELEASE_RETIREMENT_PREFLIGHT_SIZE')
 value=json.loads(raw);current=value.get('current',{})
 need(value.get('contractVersion')=='cop-sim-retired-report-profile-readonly-v1'and value.get('rootReceiptCustodyVerified')is True and value.get('rootControlOnlyExpectedProofVerified')is True and value.get('currentSelectedProducersClear')is True,'RELEASE_RETIREMENT_PREFLIGHT_UNPROVEN')
 need(current.get('activeProducerCount')==0 and current.get('producerMatchCount')==0 and current.get('lockPresent')is False,'RELEASE_RETIREMENT_PRODUCERS_ACTIVE')
 print(json.dumps({'actualRetirementPreflight':value}),flush=True)
 return value
def prepare_peer_access_interactive():
 """Use the existing pinned one-release helper, never adopt old authority.
 COP installs only the public authorization from the Mac during this pause.
 The typed continuation is NOT proof: check_transports must still pass.
 """
 need(sys.stdin.isatty()and sys.stdout.isatty(),'RELEASE_INTERACTIVE_OPERATOR_REQUIRED')
 for path in ['/run/cop-clean-reset-comm','/run/cop-clean-reset-storage','/run/cop-clean-reset-peers','/home/voldzi/cop-clean-release-comm-public.json','/home/voldzi/cop-clean-release-peers-public.json']:
  need(not os.path.lexists(path),'RELEASE_EXISTING_TEMPORARY_AUTHORITY_REQUIRES_REVIEW')
 helper=pinned_public_module(TEMP_PEER_HELPER,TEMP_PEER_HELPER_SHA,'release_prepare_peer_access')
 result=helper.prepare()
 need(result.get('phase')=='temporary_release_peer_identity_prepared'and result.get('privateKeyPrintedOrTransferred')is False and result.get('applicationChanged')is False,'RELEASE_PEER_PREPARATION_UNPROVEN')
 print(json.dumps(result),flush=True)
 need(input('Send this public JSON to COP; after COP confirms both authorizations type TRANSPORT_READY: ')=='TRANSPORT_READY','RELEASE_PEER_CONTINUATION_NOT_CONFIRMED')
def prepare_missing_keycloak_worker(*,reconcile=False):
 """Approved provider setup for absent fields or explicit same-secret resume.
 No caller-selected path, credential export, secret rotation or TTY pipe.
 """
 path=Path('/srv/cop/.env');need(path.resolve()==path,'RELEASE_COP_ENV_PATH')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and s.st_uid in[0,1000]and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1 and s.st_size<=1048576,'RELEASE_COP_ENV_CUSTODY')
  raw=os.read(fd,1048577);t=os.fstat(fd);p=path.lstat()
  identity=lambda v:(v.st_dev,v.st_ino,v.st_size,v.st_mtime_ns,v.st_ctime_ns)
  need(len(raw)==s.st_size and identity(s)==identity(t)==identity(p),'RELEASE_COP_ENV_CHANGED')
 finally:os.close(fd)
 values={}
 for line in raw.decode().splitlines():
  key,sep,value=line.partition('=')
  if sep and key in['COP_KEYCLOAK_ERASURE_CLIENT_ID','COP_KEYCLOAK_ERASURE_CLIENT_SECRET']:
   need(key not in values,'RELEASE_KEYCLOAK_DUPLICATE_FIELD')
   value=value.strip()
   if len(value)>1 and value[0]==value[-1]and value[0]in['"',"'"]:value=value[1:-1]
   values[key]=value
 if values:
  need(set(values)=={'COP_KEYCLOAK_ERASURE_CLIENT_ID','COP_KEYCLOAK_ERASURE_CLIENT_SECRET'}and values['COP_KEYCLOAK_ERASURE_CLIENT_ID']=='cop-account-erasure-worker'and re.fullmatch('[A-Za-z0-9_-]{43,128}',values['COP_KEYCLOAK_ERASURE_CLIENT_SECRET']),'RELEASE_KEYCLOAK_PARTIAL_CONFIG_REQUIRES_REVIEW')
  # Existing configuration is not provider readiness; the mandatory following
  # Keycloak inspection still verifies actual authentication and permissions.
  if not reconcile:return
 else:need(not reconcile,'RELEASE_KEYCLOAK_RECONCILIATION_REQUIRES_EXISTING_CONFIG')
 need(sys.stdin.isatty()and sys.stdout.isatty(),'RELEASE_INTERACTIVE_OPERATOR_REQUIRED')
 if reconcile:
  need(input('Type RECONCILE_EXISTING_KEYCLOAK_WORKER to complete only the approved client using its existing stored secret, without rotation: ')=='RECONCILE_EXISTING_KEYCLOAK_WORKER','RELEASE_KEYCLOAK_RECONCILIATION_NOT_CONFIRMED')
 helper=HERE/'install-clean-erasure-client.mjs'
 fd=os.open(helper,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and s.st_nlink==1 and s.st_size<1048576,'RELEASE_KEYCLOAK_HELPER_CUSTODY')
  source=os.read(fd,1048576);t=os.fstat(fd)
  need(len(source)==s.st_size and identity(s)==identity(t)and sha(source)==KEYCLOAK_PREPARATION_SHA,'RELEASE_KEYCLOAK_HELPER_SHA')
 finally:os.close(fd)
 need(source.startswith(b'#!/usr/bin/env node\n'),'RELEASE_KEYCLOAK_HELPER_HASHBANG')
 # Node file parsing ignores the initial hashbang. Preserve all other verified
 # bytes and execute the verified buffer, never re-open its mutable public path.
 program="process.argv=[process.execPath,'cop-clean-keycloak-preparation','--apply'];\n"+source.split(b'\n',1)[1].decode()
 args=[str(TARGET/'runtime/lib/ld-musl-x86_64.so.1'),'--library-path',str(TARGET/'runtime/lib')+':'+str(TARGET/'runtime/usr/lib'),str(TARGET/'runtime/usr/local/bin/node'),'--input-type=module','-e',program]
 result=subprocess.run(args,env=ENV,timeout=900)
 need(result.returncode==0,'RELEASE_KEYCLOAK_PREPARATION_FAILED')
def run_with_transport_cleanup(action):
 original=None;result=None
 try:result=action()
 except BaseException as error:
  original=error
  print(json.dumps({'error':'ROOT_RELEASE_PHASE_FAILED','code':safe_failure_code(error)}),flush=True)
 try:cleanup_temporary_transport()
 except BaseException as error:
  print(json.dumps({'error':'RELEASE_TEMPORARY_TRANSPORT_CLEANUP_FAILED','cleanupVerified':False,'code':safe_failure_code(error)}),flush=True)
  if original is not None:raise original from None
  raise
 if original is not None:raise original from None
 return result
def verify_bootstrap(expected_sha):
 r=json.loads(root_read(TARGET/'bootstrap-public.json',16*1024*1024))
 need(r['manifestSha256']==expected_sha and r['dependencyImage']=='sha256:2e61857d00f7fe0326a7b50a8f96f0cb4563d4d9028645dc08efe51b84e800df' and r['copApiImage']=='sha256:28648cded21fbd52602a197693d0b0dc9eb213cd2bd84d6227b7da34c0cbab86','RELEASE_BOOTSTRAP_BINDING')
 for source in r['sources'].values():
  root=Path(source['root']);need(root.resolve()==root and root.stat().st_uid==0 and not root.stat().st_mode&0o222,'RELEASE_SOURCE_CUSTODY')
  actual={str(p.relative_to(root))for p in root.rglob('*')if p.is_file()and 'node_modules'not in p.relative_to(root).parts and p.suffix in {'.py','.mjs','.json','.sql','.js','.ts'}}
  need(actual==set(source['files']),'RELEASE_SOURCE_INVENTORY')
  for name,d in source['files'].items():
   need(not Path(name).is_absolute() and '..' not in Path(name).parts and (root/name).resolve()==root/name and sha(root_read(root/name,16*1024*1024))==d,'RELEASE_SOURCE_SHA')
 for leaf,d in [('usr/local/bin/node','c8726a01ce4ac245ea9e5cb483992a90e628e5847d98f9a9f3be048d09a50d75'),('lib/ld-musl-x86_64.so.1','38d022ce7425ff105ccfb53598f606e6e5f5f0a34bfbc793d65e6f34c9d72806')]:
  need(sha(root_read(TARGET/'runtime'/leaf,200*1024*1024))==d,'RELEASE_RUNTIME_SHA')
 return r
NODE=r"""
import fs from 'node:fs';
const p=JSON.parse(fs.readFileSync(0,'utf8'));
const root='/srv/x5-production/staging/cop/clean-operator-shared-v3';
let stage='module_import';
try{
 const {prepareCommonRootPrivateConfig}=await import(root+'/sim/scripts/lib/prepare-common-root-private.mjs');
 const {prepareCleanCopManifest}=await import(root+'/app/scripts/account-safety/prepare-clean-cop-manifest.mjs');
 const {parseOperatorHostEnvironment}=await import(root+'/app/scripts/account-safety/operator-profile-environment.mjs');
 stage='cop_env';
 const f=fs.openSync('/srv/cop/.env',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 let environment;
 try{const s=fs.fstatSync(f);if(!s.isFile()||s.nlink!==1||![0,1000].includes(s.uid)||(s.mode&0o777)!==0o600||s.size>1048576)throw Error('COP_ENV_CUSTODY');
 const b=fs.readFileSync(f);const a=fs.fstatSync(f);if(b.length!==s.size||a.ino!==s.ino||a.mtimeMs!==s.mtimeMs||a.ctimeMs!==s.ctimeMs)throw Error('COP_ENV_DRIFT');
 const e=parseOperatorHostEnvironment(b.toString());environment=Object.fromEntries(['COP_OIDC_ISSUER','COP_AI_CHAT_ROUTER_USER_ID_SECRET','COP_SIM_ERASURE_ACTOR_SECRET','COP_ACCOUNT_ERASURE_SECRET'].filter(k=>e[k]).map(k=>[k,e[k]]));}finally{fs.closeSync(f)}
 stage='common_inspection';
 const seven=await prepareCommonRootPrivateConfig(p.options);
 stage='cop_manifest';
 const cop=prepareCleanCopManifest({...p.copManifest,environment});
 const bytes=Buffer.from(JSON.stringify(cop.manifest)+'\n');
 process.stdout.write(JSON.stringify({privateConfig:seven.privateConfig,copSafetyPrepared:cop,copManifestBase64:bytes.toString('base64')}));
}catch(error){
 const sqlCodes=new Set(['28P01','28000','3D000','3F000','42P01','42703','42501','42601','08P01','08001','08006','25006','23505','0A000']);
 const guardCodes=new Set(['SIM_ROOT_PRIVATE_PREPARATION_REJECTED','SIM_USER_INSTALL_REJECTED','SIM_USER_INSTALL_CONTEXT','SIM_USER_INSTALL_TLS_REQUIRED','RESET_UNCLASSIFIED_QUEUE_OR_BILLING_DATA','WRONG_DATABASE','UNPLANNED_FOREIGN_KEY','RESET_SOURCE_DIGEST_MISMATCH','RESET_UNKNOWN_CATALOG','RESET_FILE_PARENT_UNSAFE','RESET_REPORT_DIRECTORY_PRIVATE_REQUIRED','RESET_UNKNOWN_FILE_OR_PRODUCER_LOCK','RESET_UNKNOWN_REPORT_FILE','RESET_UNKNOWN_ROUTE_FILE','RESET_ROUTE_ENCODING','RESET_ROUTE_FORMAT','SIM_APP_RESET_UNPROVEN','RESET_IDENTITY_CONFIG_INVALID','RESET_IDENTITY_AUTH_UNAVAILABLE','RESET_CLIENT_INVENTORY_UNPROVEN','RESET_USER_INVENTORY_UNPROVEN','RESET_USER_BINDING_UNPROVEN','RESET_SERVICE_IDENTITY_UNPROVEN','RESET_UNKNOWN_SERVICE_IDENTITY','CLEAN_COP_MANIFEST_PREPARATION_REJECTED']);
 const components=[['sim-user-data-private-install.mjs','sim_user_install'],['prepare-sim-root-private.mjs','sim_private'],['clean-user-reset.mjs','cop'],['clean-reset-ops.mjs','ai_driver'],['clean-reset-files.mjs','report_route_files'],['sim-user-data-reset-files.mjs','sim_app_files'],['clean-keycloak-reset.mjs','keycloak']];
 const component=components.find(([file])=>typeof error?.stack==='string'&&error.stack.includes('/'+file+':'))?.[1]??'unknown';
 process.stderr.write(JSON.stringify({code:'ROOT_PRIVATE_PREPARATION_FAILED',stage,component,sqlState:sqlCodes.has(error?.code)?error.code:null,guardCode:guardCodes.has(error?.message)?error.message:null})+'\n');process.exitCode=1}
"""
def node_prepare(options,decision):
 import base64
 payload={'options':options,'copManifest':{'resetEpoch':options['resetEpoch'],'tokensNotBefore':options['tokensNotBefore'],'applicationStoreId':str(uuid.uuid4()),'incarnationId':str(uuid.uuid4()),'guardStoreId':options['guardStoreId'],'initialDigest':'0'*64,'postgresCaSha256':sha(Path('/etc/vcode-cop-pgbouncer/postgres-ca.crt').read_bytes()),'decision':decision}}
 args=[str(TARGET/'runtime/lib/ld-musl-x86_64.so.1'),'--library-path',str(TARGET/'runtime/lib')+':'+str(TARGET/'runtime/usr/lib'),str(TARGET/'runtime/usr/local/bin/node'),'--input-type=module','-e',NODE]
 r=subprocess.run(args,input=json.dumps(payload).encode(),capture_output=True,env=ENV,timeout=180)
 if r.returncode!=0:
  stage='unknown'
  try:
   failure=json.loads(r.stderr)
   if isinstance(failure,dict)and set(failure)=={'code','stage','component','sqlState','guardCode'}and failure['code']=='ROOT_PRIVATE_PREPARATION_FAILED'and failure['stage']in['module_import','cop_env','common_inspection','cop_manifest']:
    stage=failure['stage']
    components=['unknown','sim_user_install','sim_private','cop','ai_driver','report_route_files','sim_app_files','keycloak']
    sql_codes=['28P01','28000','3D000','3F000','42P01','42703','42501','42601','08P01','08001','08006','25006','23505','0A000']
    need(failure['component']in components and(failure['sqlState']is None or failure['sqlState']in sql_codes),'RELEASE_NODE_DIAGNOSTIC_SCOPE')
    # guardCode is validated against the literal Node allowlist above, not a
    # generic uppercase regex which could accidentally admit arbitrary data.
    guard_codes=__import__('ast').literal_eval(NODE.split('const guardCodes=new Set(',1)[1].split(');',1)[0])
    need(failure['guardCode']is None or failure['guardCode']in guard_codes,'RELEASE_NODE_DIAGNOSTIC_SCOPE')
    print(json.dumps({'nodePreparationFailure':failure}),flush=True)
  except(ValueError,UnicodeError):pass
  raise RuntimeError('RELEASE_NODE_PREPARATION_FAILED_'+stage.upper())
 need(len(r.stdout)<=1048576,'RELEASE_NODE_PREPARATION_OUTPUT_LIMIT')
 value=json.loads(r.stdout);value['copManifestBytes']=base64.b64decode(value.pop('copManifestBase64'),validate=True);return value
def publish_new(path,raw):
 need(path.parent.is_dir() and path.parent.stat().st_uid==0 and not path.parent.stat().st_mode&0o022,'RELEASE_PLAN_PARENT')
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  with os.fdopen(fd,'wb',closefd=False) as f:f.write(raw);f.flush();os.fsync(fd)
 finally:os.close(fd)
 d=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(d)
 finally:os.close(d)
def publish_acceptance_report(bootstrap_module,host,manifest):
 artifact=manifest.get('acceptanceReport')
 need(isinstance(artifact,dict) and set(artifact)=={'path','sha256'},'RELEASE_ACCEPTANCE_ARTIFACT')
 path=Path(artifact['path']);staging=Path('/srv/x5-production/staging/cop')
 need(path.is_absolute() and path.resolve()==path and staging in path.parents,'RELEASE_ACCEPTANCE_PATH')
 raw=bootstrap_module.public_bytes(path,1048576)
 need(sha(raw)==artifact['sha256'],'RELEASE_ACCEPTANCE_SHA')
 report=json.loads(raw)
 need(report.get('contractVersion')=='cop-sim-whole-clean-acceptance-v3','RELEASE_ACCEPTANCE_V3_REQUIRED')
 host._acceptance_module().validate_clean_whole_report_bytes(raw,manifest['candidateImages'],time.time())
 # Never adopt a caller-selected target or silently replace another Root proof.
 target=BASE/'whole12-acceptance.json'
 need(host._acceptance_module().REPORT==target,'RELEASE_ACCEPTANCE_TARGET')
 if os.path.lexists(target):
  need(root_read(target)==raw,'RELEASE_ACCEPTANCE_EXISTING_CONFLICT')
 else:publish_new(target,raw)
 return {'acceptanceReportSha256':sha(raw),'rootAcceptancePublished':True}
def prepare_and_seal_clean_release(bootstrap,public_manifest,postgres_password,decision):
 """Actual twelve inspectors and protected publication, private return in RAM."""
 sources=bootstrap['sources'];cop=Path(sources['cop']['root']);sim=Path(sources['sim']['root'])
 controller=load(cop/'scripts/account-safety/clean-reset-controller.py','sealed_release_controller');host=controller.host
 collector=load(sim/'scripts/lib/collect-messaging-initial-private.py','sealed_release_collector')
 remaining=load(sim/'scripts/lib/prepare-common-remaining.py','sealed_release_remaining')
 remote=host.CommunicationResetTransport()
 s3=load(cop/'scripts/account-safety/clean-reset-s3.py','sealed_release_s3')
 storage=None
 try:
  remote.open()
  local=host.inspect_writers(host.command,host.LOCAL_WRITERS);distant=host.inspect_writers(remote.run,host.REMOTE_WRITERS)
  producers=host.DriverReportProducerCustody();_,_,producer=producers._inventory()
  need(producer['activeProducerCount']==0,'RELEASE_PRODUCER_ACTIVE')
  # Reviewed future paused state; freeze performs actual closure checks later.
  producer={**producer,'paused':True}
  producer_sha=sha(json.dumps(producer,sort_keys=True,separators=(',',':')).encode())
  lock=Path('/srv/cop/.storage.lock').lstat();need(stat.S_ISREG(lock.st_mode) and lock.st_nlink==1,'RELEASE_LOCK_SCOPE')
  plan={'contractVersion':'cop-sim-clean-reset-root-plan-v1','scope':'cop_sim_shared_identity_v1',
   'resetEpoch':str(uuid.uuid4()),'tokensNotBefore':int(time.time()),'sources':sources,
   'localWriters':{k:{'id':v['id'],'image':v['image']} for k,v in local.items()},
   'remoteWriters':{k:{'id':v['id'],'image':v['image']} for k,v in distant.items()},
   'producerInventorySha256':producer_sha,
   'operationLockMetadata':{'device':lock.st_dev,'inode':lock.st_ino,'uid':lock.st_uid,'gid':lock.st_gid,'mode':stat.S_IMODE(lock.st_mode)},
   'runtimeBinding':read_current_runtime_binding(local['cop-cop-api-1']),
   'operatorRuntime':{'root':str(TARGET),'imageId':bootstrap['dependencyImage'],'nodeSha256':'c8726a01ce4ac245ea9e5cb483992a90e628e5847d98f9a9f3be048d09a50d75','loaderSha256':'38d022ce7425ff105ccfb53598f606e6e5f5f0a34bfbc793d65e6f34c9d72806'},
   'candidateImages':public_manifest['candidateImages']}
  host._acceptance_module().verified_pre_stop_acceptance(plan['candidateImages'])
  prepared=node_prepare({'postgresPassword':postgres_password,'resetEpoch':plan['resetEpoch'],'tokensNotBefore':plan['tokensNotBefore'],'environmentId':str(uuid.uuid4()),'guardStoreId':str(uuid.uuid4())},decision)
  private={**prepared['privateConfig'],
    'expectedImages':{k:plan['localWriters'][k]['image'] for k in ['csm-sim-ai-router-api','csm-sim-situation-data-api']},
    'expectedMainImage':plan['localWriters']['csm-sim-api']['image']}
  message=collector.collect_messaging_initial_private(remote,postgres_password,plan)
  # Actual provider inventory supplied by the reviewed public manifest and
  # rechecked through the concrete storage transport before any writer freeze.
  storage=s3.ProductionStorage(plan);storage.open(public_manifest['storageProvider'])
  rest=remaining.inspect_remaining_private(plan,private,postgres_password,message['nativeAdminToken'],remote,storage)
  joined=remaining.finalize_private_preparation(private,rest,prepared['copSafetyPrepared'],prepared['copManifestBytes'],postgres_password)
  joined=remaining.attach_messaging_install_preparation(joined,message['envelope'],message['connections'],message['rootBase64'])
  plan['reviewedPlanDigests']=joined['publicSummary']['reviewedPlanDigests'];host.validate_plan(plan)
  # Never silently replace an earlier plan or accepted operation.
  need(not (BASE/'plan.json').exists() and not (BASE/'database-enrollment.json').exists(),'RELEASE_PRIOR_PLAN_REQUIRES_REVIEW')
  publish_new(BASE/'database-enrollment.json',prepared['copManifestBytes'])
  publish_new(BASE/'plan.json',(json.dumps(plan,separators=(',',':'))+'\n').encode())
  return {'privateConfig':joined['privateConfig'],'publicSummary':joined['publicSummary'],'plan':plan}
 finally:
  try:
   if storage:storage.close()
  finally:remote.close()
def main():
 # Root can write even beneath mode 0555: imports must not add bytecode to
 # either the preserved bundle or the freshly sealed public operator tree.
 sys.dont_write_bytecode=True
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--public-manifest',required=True);p.add_argument('--manifest-sha256',required=True)
 p.add_argument('--prepare-peer-access',action='store_true',help='Prepare the existing approved one-release RAM identity and pause for COP public authorization')
 p.add_argument('--reconcile-keycloak-worker',action='store_true',help='Explicitly complete the approved worker using its existing stored secret; no rotation')
 transitions=p.add_mutually_exclusive_group()
 transitions.add_argument('--recover-prepared-v11',action='store_true',help='Preserve only the exact proven-unapplied v11 preparation, then create a new release')
 transitions.add_argument('--preserve-public-v4',action='store_true',help='Explicit one-time V4 transition; never repeat after V4 preservation')
 transitions.add_argument('--preserve-public-v5',action='store_true',help='Preserve exact existing V5 public bundle; never adopt a reset plan')
 transitions.add_argument('--preserve-public-v9',action='store_true',help='Preserve exact V9 and change only the reviewed COP service-account inventory source')
 transitions.add_argument('--preserve-public-v6',action='store_true',help='Preserve exact V6 and bind the reviewed publisher/COP custody source updates only')
 transitions.add_argument('--resume-public-v6',action='store_true',help='Use only the already sealed exact V6 public bundle, without rename or bootstrap')
 modes=p.add_mutually_exclusive_group();modes.add_argument('--apply-disabled-reset',action='store_true');modes.add_argument('--complete-release',action='store_true');a=p.parse_args()
 need(not a.reconcile_keycloak_worker or a.resume_public_v6,'RELEASE_KEYCLOAK_RECONCILIATION_SCOPE')
 need(os.getuid()==0 and socket.gethostname().split('.')[0]=='docker' and sys.flags.isolated,'RELEASE_ROOT_CONTEXT')
 bootstrap_module=verified_bootstrap_code()
 bootstrap_module.context()
 raw=bootstrap_module.public_bytes(a.public_manifest,1048576);need(sha(raw)==a.manifest_sha256,'RELEASE_PUBLIC_MANIFEST_SHA');manifest=json.loads(raw)
 recovery=None
 if a.recover_prepared_v11:
  need(a.complete_release and a.prepare_peer_access and not a.reconcile_keycloak_worker,'RELEASE_PREPARED_V11_MODE')
  verify_bootstrap(V11_MANIFEST_SHA)
  recovery=transition_module(bootstrap_module,manifest,a.public_manifest,TRANSITION_RECOVERY_MEMBER)
  recovery.inventory()
  validate_transition_acceptance(bootstrap_module,manifest,a.public_manifest,root_read(BASE/'whole12-acceptance.json'))
 if a.resume_public_v6 or a.preserve_public_v6 or a.preserve_public_v9:
  if a.resume_public_v6:need(a.manifest_sha256==V6_MANIFEST_SHA and Path(a.public_manifest)==V6_MANIFEST,'RELEASE_RESUME_V6_MANIFEST_SCOPE')
  verify_bootstrap(V9_MANIFEST_SHA if a.preserve_public_v9 else V6_MANIFEST_SHA)
  ensure_control_directory(V4_REPORT_SHA,require_existing=True)
  if a.preserve_public_v9:
   # Refuse an expired/unbound exception before creating another RAM identity.
   validate_transition_acceptance(bootstrap_module,manifest,a.public_manifest,root_read(BASE/'whole12-acceptance.json'))
 if a.prepare_peer_access:
  need(a.recover_prepared_v11 or a.preserve_public_v5 or a.preserve_public_v6 or a.preserve_public_v9 or a.resume_public_v6,'RELEASE_PEER_PREPARATION_SCOPE')
  verify_bootstrap(V11_MANIFEST_SHA if a.recover_prepared_v11 else V9_MANIFEST_SHA if a.preserve_public_v9 else V6_MANIFEST_SHA if a.resume_public_v6 or a.preserve_public_v6 else V5_MANIFEST_SHA)
  prepare_peer_access_interactive()
 if a.recover_prepared_v11:
  bootstrap_module.check_transports()
  need(input('Type PRESERVE_UNAPPLIED_V11_AND_REBUILD to preserve the exact unused preparation without adopting it: ')=='PRESERVE_UNAPPLIED_V11_AND_REBUILD','RELEASE_PREPARED_V11_NOT_CONFIRMED')
  print(json.dumps(execution_phase('prepared_v11_preservation',recovery.preserve_unapplied_v11)),flush=True)
  print(json.dumps(execution_phase('work_child_provision',recovery.provision_work_child)),flush=True)
  print(json.dumps(preserve_public_v4(bootstrap_module,manifest,a.public_manifest,from_v11=True)),flush=True)
 if a.preserve_public_v4 or a.preserve_public_v5 or a.preserve_public_v6 or a.preserve_public_v9:
  need(sys.stdin.isatty() and sys.stdout.isatty(),'RELEASE_INTERACTIVE_OPERATOR_REQUIRED')
  bootstrap_module.check_transports()
  if a.preserve_public_v5:
   # Actual operational evidence inside this one command, before changing the
   # public bundle. No separate diagnostic round, acceptance claim or key setup.
   actual_retirement_preflight()
  if a.preserve_public_v6 or a.preserve_public_v9:
   prior=verify_bootstrap(V9_MANIFEST_SHA if a.preserve_public_v9 else V6_MANIFEST_SHA);old_host=load(Path(prior['sources']['cop']['root'])/'scripts/account-safety/clean-reset-root.py','release_publisher_transition_retirement')
   _,_,producer=old_host.DriverReportProducerCustody()._inventory()
   need(producer.get('profile')=='known-retired-v1'and producer.get('paused')is True and producer.get('activeProducerCount')==0,'RELEASE_PUBLISHER_TRANSITION_PRODUCERS_UNPROVEN')
   print(json.dumps({'actualRetiredProducerPreflight':producer}),flush=True)
  confirmation='PRESERVE_PUBLIC_V9_AND_REBUILD'if a.preserve_public_v9 else'PRESERVE_PUBLIC_V6_AND_REBUILD'if a.preserve_public_v6 else'PRESERVE_PUBLIC_V5_AND_REBUILD'if a.preserve_public_v5 else'PRESERVE_PUBLIC_V4_AND_REBUILD'
  need(input('Type '+confirmation+' to preserve only the verified public operator bundle: ')==confirmation,'RELEASE_TRANSITION_NOT_CONFIRMED')
  print(json.dumps(preserve_public_v4(bootstrap_module,manifest,a.public_manifest,from_v5=a.preserve_public_v5,from_v6=a.preserve_public_v6,from_v9=a.preserve_public_v9)),flush=True)
 if a.resume_public_v6:bootstrap_module.check_transports()
 elif not TARGET.exists():bootstrap_module.bootstrap_clean_release(a.public_manifest,a.manifest_sha256)
 else:bootstrap_module.check_transports()
 bootstrap=verify_bootstrap(a.manifest_sha256)
 cop=Path(bootstrap['sources']['cop']['root']);host=load(cop/'scripts/account-safety/clean-reset-root.py','release_early_root_gate')
 transitioning=a.recover_prepared_v11 or a.preserve_public_v4 or a.preserve_public_v5 or a.preserve_public_v6 or a.preserve_public_v9 or a.resume_public_v6
 ensure_control_directory(V4_REPORT_SHA if transitioning else None,require_existing=transitioning)
 publish_acceptance_report(bootstrap_module,host,manifest)
 # Blocks before asking PG password when exact whole-provider GO is missing.
 host._acceptance_module().verified_pre_stop_acceptance(manifest['candidateImages'])
 if a.recover_prepared_v11 or a.resume_public_v6 or a.preserve_public_v6 or a.preserve_public_v9:
  _,_,producer=host.DriverReportProducerCustody()._inventory()
  need(producer.get('profile')=='known-retired-v1'and producer.get('paused')is True and producer.get('activeProducerCount')==0,'RELEASE_RESUME_RETIRED_PROFILE_UNPROVEN')
  print(json.dumps({'actualRetiredProducerPreflight':producer}),flush=True)
  prepare_missing_keycloak_worker(reconcile=a.reconcile_keycloak_worker)
 need(sys.stdin.isatty() and sys.stdout.isatty(),'RELEASE_INTERACTIVE_OPERATOR_REQUIRED')
 need(input('Type ALL_TEST_ACCOUNTS_SHARED_IDENTITY_RESET to confirm the reviewed destructive scope: ')=='ALL_TEST_ACCOUNTS_SHARED_IDENTITY_RESET','RELEASE_SCOPE_NOT_CONFIRMED')
 password=getpass.getpass('PostgreSQL administrator password (RAM only): ')
 decision={k:True for k in ['allLegacyUsersTestOnly','currentKeycloakOnly','sharedIdentityRemovalApproved']}
 prepared=prepare_and_seal_clean_release(bootstrap,manifest,password,decision)
 print(json.dumps(prepared['publicSummary']))
 if a.apply_disabled_reset or a.complete_release:
  confirmation='COMPLETE_CLEAN_RELEASE'if a.complete_release else 'APPLY_DISABLED_RESET'
  need(input('Type '+confirmation+' to execute exactly these sealed plans: ')==confirmation,'RELEASE_APPLY_NOT_CONFIRMED')
  activation=None;modules=None
  if a.complete_release:
   activation=execution_phase('activation_module_load',lambda:load(Path(bootstrap['sources']['sim']['root'])/'scripts/complete-clean-release.py','sealed_complete_release'))
   modules=execution_phase('activation_adapter_load',lambda:activation.activation_modules(bootstrap))
   execution_phase('pre_stop_health_capture',lambda:activation.capture_before_freeze(modules,prepared['plan']))
  common=execution_phase('common_module_load',lambda:load(Path(bootstrap['sources']['sim']['root'])/'scripts/coordinate-clean-release.py','sealed_actual_common_reset'))
  receipt=execution_phase('common_reset',lambda:common.run_common_reset(prepared['privateConfig']));print(json.dumps(receipt))
  if a.complete_release:print(json.dumps(execution_phase('production_activation',lambda:activation.complete_release(modules,receipt,prepared['privateConfig']))))
  else:print(json.dumps({'disabledRuntimeRestartPending':True,'productionActivated':False}))
 # No private config serialization or secret file. Activation is a separate,
 # explicit interactive mode with concrete protected adapters and real probes.
if __name__=='__main__':
 try:run_with_transport_cleanup(main)
 except BaseException:
  print(json.dumps({'error':'ROOT_RELEASE_STOPPED_FAIL_CLOSED','productionActivated':False}));raise SystemExit(1)
