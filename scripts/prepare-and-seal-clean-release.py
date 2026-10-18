#!/usr/bin/python3 -I
"""Root-only interactive preparation and explicit disabled reset.
No stored administrator password, automatic GO, key provisioning/network or model calls.
An explicitly approved fixed RAM-only transport is cleaned in the outer finally.
Run only from docker Root. Private config never leaves this process/child pipes.
"""
import argparse,contextlib,ctypes,getpass,hashlib,importlib.util,io,json,os,re,shlex,socket,stat,subprocess,sys,time,uuid,types
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
RETIREMENT_PROBE_SHA='7940e142da215f3d28c413dd59344da2210220972d923d247c69e69709947a5b'
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C'}
BOOTSTRAP_SHA='7ce4915e14646d675940e6f03d9a38bced23922f9ff66bbac9c45e9c81fdc43c'
TEMP_KEY_HELPER=Path('/home/voldzi/cop-clean-release-temporary-comm-key.py')
TEMP_KEY_SHA='87ea81867ac8bdb3605b7b186c550710b7b9ac268da7667b1b6ce60b22dd852a'
TEMP_AUTHORIZE=Path('/home/voldzi/temporary-comm-authorize.py')
TEMP_AUTHORIZE_SHA='70a0f585254c7f3e0cce91c4c5e8a4d90d761c4db4c401473641002bbba5562a'
TEMP_PEER_HELPER=Path('/home/voldzi/temporary-release-key.py')
TEMP_PEER_HELPER_SHA='446508abf4eb990cb0b0b61d22fd703fd5eee2c152db1a41f922b76e041ad0b8'
def need(v,c):
 if not v:raise RuntimeError(c)
def sha(b):return hashlib.sha256(b).hexdigest()
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
def preserve_public_v4(bootstrap_module,new_manifest,manifest_path,*,from_v5=False):
 """Preserve exact public V4, never adopt or remove a prior operation.
 Root must directly inventory BASE; a prior error/EACCES proves no absence.
 Failure preserves evidence for manual review, with no automatic rollback.
 """
 bootstrap_module.context()
 old_manifest=V5_MANIFEST if from_v5 else V4_MANIFEST
 old_sha=V5_MANIFEST_SHA if from_v5 else V4_MANIFEST_SHA
 destination=V5_ARCHIVE if from_v5 else V4_ARCHIVE
 old_revision=FIXED_COP_REVISION if from_v5 else 'f4f0474ec5c5697010b9bdfddb58fac3f1786610'
 new_revision=bootstrap_module.REVISIONS['cop']if from_v5 else FIXED_COP_REVISION
 need(TARGET==Path('/srv/x5-production/staging/cop/clean-operator-shared-v3')and destination==TARGET.with_name('clean-operator-shared-v3-preserved-v5-4ed81c5'if from_v5 else'clean-operator-shared-v3-preserved-v4-f4f0474'),'RELEASE_TRANSITION_FIXED_PATHS')
 raw=bootstrap_module.public_bytes(old_manifest,1048576)
 need(sha(raw)==old_sha,'RELEASE_TRANSITION_OLD_MANIFEST_SHA');old=json.loads(raw)
 candidate=json.loads(json.dumps(new_manifest))
 need(candidate['archives']['cop']['revision']==new_revision and new_revision!=old_revision,'RELEASE_TRANSITION_NEW_COP_REVISION')
 need(old['archives']['cop']['revision']==old_revision,'RELEASE_TRANSITION_OLD_COP_REVISION')
 candidate['archives']['cop']=old['archives']['cop']
 need(candidate==old and new_manifest['acceptanceReport']['sha256']==V4_REPORT_SHA,'RELEASE_TRANSITION_SCOPE_CHANGED')
 previous=verify_bootstrap(old_sha)
 need(previous.get('plansPrepared')==0 and previous.get('resetExecuted')is False and previous.get('productionActivated')is False,'RELEASE_TRANSITION_OLD_RECEIPT')
 need({k:v['revision']for k,v in previous['sources'].items()}=={k:v['revision']for k,v in old['archives'].items()},'RELEASE_TRANSITION_OLD_SOURCE_REVISION')
 ensure_control_directory(V4_REPORT_SHA,require_existing=True)
 old_host=load(Path(previous['sources']['cop']['root'])/'scripts/account-safety/clean-reset-root.py','transition_old_public_gate')
 # The unchanged acceptance must still be current BEFORE preserving the bundle.
 old_host._acceptance_module().validate_clean_whole_report_v3(json.loads(root_read(BASE/'whole12-acceptance.json')),new_manifest['candidateImages'],time.time())
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
 return {'publicV5Preserved'if from_v5 else'publicV4Preserved':True,'priorOperationAdopted':False,'productionActivated':False}
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
 if isinstance(error,OSError):return 'OS_ERROR_'+str(error.errno if isinstance(error.errno,int)else 'UNKNOWN')
 return 'UNCLASSIFIED_'+type(error).__name__
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
try{
 const {prepareCommonRootPrivateConfig}=await import(root+'/sim/scripts/lib/prepare-common-root-private.mjs');
 const {prepareCleanCopManifest}=await import(root+'/app/scripts/account-safety/prepare-clean-cop-manifest.mjs');
 const {parseOperatorHostEnvironment}=await import(root+'/app/scripts/account-safety/operator-profile-environment.mjs');
 const f=fs.openSync('/srv/cop/.env',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 let environment;
 try{const s=fs.fstatSync(f);if(!s.isFile()||s.nlink!==1||![0,1000].includes(s.uid)||(s.mode&0o777)!==0o600||s.size>1048576)throw Error('COP_ENV_CUSTODY');
 const b=fs.readFileSync(f);const a=fs.fstatSync(f);if(b.length!==s.size||a.ino!==s.ino||a.mtimeMs!==s.mtimeMs||a.ctimeMs!==s.ctimeMs)throw Error('COP_ENV_DRIFT');
 const e=parseOperatorHostEnvironment(b.toString());environment=Object.fromEntries(['COP_OIDC_ISSUER','COP_AI_CHAT_ROUTER_USER_ID_SECRET','COP_SIM_ERASURE_ACTOR_SECRET','COP_ACCOUNT_ERASURE_SECRET'].filter(k=>e[k]).map(k=>[k,e[k]]));}finally{fs.closeSync(f)}
 const seven=await prepareCommonRootPrivateConfig(p.options);
 const cop=prepareCleanCopManifest({...p.copManifest,environment});
 const bytes=Buffer.from(JSON.stringify(cop.manifest)+'\n');
 process.stdout.write(JSON.stringify({privateConfig:seven.privateConfig,copSafetyPrepared:cop,copManifestBase64:bytes.toString('base64')}));
}catch{process.stderr.write('ROOT_PRIVATE_PREPARATION_FAILED\n');process.exitCode=1}
"""
def node_prepare(options,decision):
 import base64
 payload={'options':options,'copManifest':{'resetEpoch':options['resetEpoch'],'tokensNotBefore':options['tokensNotBefore'],'applicationStoreId':str(uuid.uuid4()),'incarnationId':str(uuid.uuid4()),'guardStoreId':options['guardStoreId'],'initialDigest':'0'*64,'postgresCaSha256':sha(Path('/etc/vcode-cop-pgbouncer/postgres-ca.crt').read_bytes()),'decision':decision}}
 args=[str(TARGET/'runtime/lib/ld-musl-x86_64.so.1'),'--library-path',str(TARGET/'runtime/lib')+':'+str(TARGET/'runtime/usr/lib'),str(TARGET/'runtime/usr/local/bin/node'),'--input-type=module','-e',NODE]
 r=subprocess.run(args,input=json.dumps(payload).encode(),capture_output=True,env=ENV,timeout=180)
 need(r.returncode==0 and len(r.stdout)<=1048576,'RELEASE_NODE_PREPARATION_FAILED')
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
 host._acceptance_module().validate_clean_whole_report_v3(report,manifest['candidateImages'],time.time())
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
 transitions=p.add_mutually_exclusive_group()
 transitions.add_argument('--preserve-public-v4',action='store_true',help='Explicit one-time V4 transition; never repeat after V4 preservation')
 transitions.add_argument('--preserve-public-v5',action='store_true',help='Preserve exact existing V5 public bundle; never adopt a reset plan')
 modes=p.add_mutually_exclusive_group();modes.add_argument('--apply-disabled-reset',action='store_true');modes.add_argument('--complete-release',action='store_true');a=p.parse_args()
 need(os.getuid()==0 and socket.gethostname().split('.')[0]=='docker' and sys.flags.isolated,'RELEASE_ROOT_CONTEXT')
 bootstrap_module=verified_bootstrap_code()
 bootstrap_module.context()
 raw=bootstrap_module.public_bytes(a.public_manifest,1048576);need(sha(raw)==a.manifest_sha256,'RELEASE_PUBLIC_MANIFEST_SHA');manifest=json.loads(raw)
 if a.prepare_peer_access:
  need(a.preserve_public_v5,'RELEASE_PEER_PREPARATION_SCOPE')
  verify_bootstrap(V5_MANIFEST_SHA)
  prepare_peer_access_interactive()
 if a.preserve_public_v4 or a.preserve_public_v5:
  need(sys.stdin.isatty() and sys.stdout.isatty(),'RELEASE_INTERACTIVE_OPERATOR_REQUIRED')
  bootstrap_module.check_transports()
  if a.preserve_public_v5:
   # Actual operational evidence inside this one command, before changing the
   # public bundle. No separate diagnostic round, acceptance claim or key setup.
   actual_retirement_preflight()
  confirmation='PRESERVE_PUBLIC_V5_AND_REBUILD'if a.preserve_public_v5 else'PRESERVE_PUBLIC_V4_AND_REBUILD'
  need(input('Type '+confirmation+' to preserve only the verified public operator bundle: ')==confirmation,'RELEASE_TRANSITION_NOT_CONFIRMED')
  print(json.dumps(preserve_public_v4(bootstrap_module,manifest,a.public_manifest,from_v5=a.preserve_public_v5)),flush=True)
 if not TARGET.exists():bootstrap_module.bootstrap_clean_release(a.public_manifest,a.manifest_sha256)
 else:bootstrap_module.check_transports()
 bootstrap=verify_bootstrap(a.manifest_sha256)
 cop=Path(bootstrap['sources']['cop']['root']);host=load(cop/'scripts/account-safety/clean-reset-root.py','release_early_root_gate')
 transitioning=a.preserve_public_v4 or a.preserve_public_v5
 ensure_control_directory(V4_REPORT_SHA if transitioning else None,require_existing=transitioning)
 publish_acceptance_report(bootstrap_module,host,manifest)
 # Blocks before asking PG password when exact whole-provider GO is missing.
 host._acceptance_module().verified_pre_stop_acceptance(manifest['candidateImages'])
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
   activation=load(Path(bootstrap['sources']['sim']['root'])/'scripts/complete-clean-release.py','sealed_complete_release')
   modules=activation.activation_modules(bootstrap)
   activation.capture_before_freeze(modules,prepared['plan'])
  common=load(Path(bootstrap['sources']['sim']['root'])/'scripts/coordinate-clean-release.py','sealed_actual_common_reset')
  receipt=common.run_common_reset(prepared['privateConfig']);print(json.dumps(receipt))
  if a.complete_release:print(json.dumps(activation.complete_release(modules,receipt,prepared['privateConfig'])))
  else:print(json.dumps({'disabledRuntimeRestartPending':True,'productionActivated':False}))
 # No private config serialization or secret file. Activation is a separate,
 # explicit interactive mode with concrete protected adapters and real probes.
if __name__=='__main__':
 try:run_with_transport_cleanup(main)
 except BaseException:
  print(json.dumps({'error':'ROOT_RELEASE_STOPPED_FAIL_CLOSED','productionActivated':False}));raise SystemExit(1)
