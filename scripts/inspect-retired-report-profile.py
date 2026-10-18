#!/usr/bin/python3 -I
"""Root READ ONLY retirement lineage and current producer inventory.
No identity setup/cleanup, SQL, cron edits, reset, deployment or acceptance.
Output is a fixed safe projection, never raw receipts/cron/report names.
"""
import hashlib,json,os,re,socket,stat,subprocess,sys,types
from pathlib import Path
PUBLIC=Path('/srv/x5-production/staging/cop/clean-release-public-20261017-v4/resume-2')
CLI_SHA='6be5cda2b332f83b82ca4376554c6f7b685f266bb3b2c252b152d258b8349a3e'
MANIFEST_SHA='3ef1c647ca905e59b30e0215d7560091d360203f7702c015a747a05e557ad8ad'
SOURCE='ca1fd6b6046745e91cca6648e1e5bd3f93fc8422'
CRON_SHA='c46a03b13ee8d39860fb7bd72df740006f8762fd421ded44e1b2cac990d15d78'
ORIGINAL='12e5f824e2aa9f8f740cc4fded7589743902243c0ba641c943b14ab4054ec705'
RECEIPTS=Path('/srv/sim/.sim-erasure-cutover')
ENV={'PATH':'/usr/bin:/bin','HOME':'/root','LANG':'C'}
def need(value,code):
 if not value:raise RuntimeError(code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def read_regular(path,root=False,maximum=1048576):
 need(path.resolve()==path,'RETIREMENT_PATH_SYMLINK')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and s.st_nlink==1 and s.st_size<=maximum,'RETIREMENT_FILE_CUSTODY')
  if root:need((s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(0,0,0o600),'RETIREMENT_ROOT_FILE_CUSTODY')
  raw=os.read(fd,maximum+1);t=os.fstat(fd);p=path.lstat()
  fields=lambda v:(v.st_dev,v.st_ino,v.st_size,v.st_mtime_ns,v.st_ctime_ns)
  need(len(raw)==s.st_size and fields(s)==fields(t)==fields(p),'RETIREMENT_FILE_CHANGED');return raw
 finally:os.close(fd)
def verified_launcher():
 path=PUBLIC/'prepare-and-seal-clean-release.py';raw=read_regular(path)
 need(sha(raw)==CLI_SHA,'RETIREMENT_LAUNCHER_SHA')
 module=types.ModuleType('readonly_retirement_verified_launcher');module.__file__=str(path)
 exec(compile(raw,str(path),'exec'),module.__dict__);return module
def counts(value):
 need(isinstance(value,dict)and value.get('contractVersion')=='sim-driver-report-inventory-v1','RETIREMENT_INVENTORY_CONTRACT')
 out={k:value.get(k)for k in ['fileCount','bytes','activeProducerCount','lockPresent','inventoryDigest']}
 need(all(type(out[k])is int and out[k]>=0 for k in ['fileCount','bytes','activeProducerCount'])and type(out['lockPresent'])is bool and isinstance(out['inventoryDigest'],str)and re.fullmatch('[a-f0-9]{64}',out['inventoryDigest'])and isinstance(value.get('producerMatches'),list),'RETIREMENT_INVENTORY_SCHEMA')
 out['producerMatchCount']=len(value['producerMatches']);return out
def safe_projection(post,transition,current,plan_sha,receipt_shas):
 need(post.get('sourceRevision')==transition.get('sourceRevision')==SOURCE,'RETIREMENT_SOURCE_REVISION')
 need(post.get('retiredCronSha256')==transition.get('expectedRetiredCronSha256')==CRON_SHA,'RETIREMENT_CRON_BINDING')
 need(post.get('originalInventoryDigest')==ORIGINAL==transition.get('original',{}).get('inventoryDigest'),'RETIREMENT_ORIGINAL_BINDING')
 need(post.get('legacyCleanupRetired')is True and post.get('otherProducerSourcesUnchanged')is True and transition.get('otherProducerSourcesUnchanged')is True and post.get('databaseContacted')is False and post.get('erasureEnabled')is False,'RETIREMENT_RECEIPT_SCOPE')
 previous=counts(post.get('reportInventory'));resulting=counts(transition.get('resulting'))
 need(previous==resulting and previous['fileCount']==previous['bytes']==previous['activeProducerCount']==previous['producerMatchCount']==0 and previous['lockPresent']is False,'RETIREMENT_POSTSTOP_BINDING')
 now=counts(current)
 return {'contractVersion':'cop-sim-retired-report-profile-readonly-v1','sourceRevision':SOURCE,'retiredCronSha256':CRON_SHA,'originalInventoryDigest':ORIGINAL,'postStopInventoryDigest':previous['inventoryDigest'],'otherProducerSourcesUnchangedAtRetirement':True,'rootReceiptCustodyVerified':True,'runtimePlanSha256':plan_sha,'receiptSha256':receipt_shas,'current':now,'currentSelectedProducersClear':now['activeProducerCount']==now['producerMatchCount']==0 and now['lockPresent']is False,'readOnly':True,'productionAcceptance':False,'productionChanged':False}
NODE="""import {reportInventory} from '/srv/x5-production/staging/cop/clean-operator-shared-v3/sim/scripts/driver-report-inventory.mjs';
try { const v=reportInventory(); process.stdout.write(JSON.stringify(v)); }
catch { process.stderr.write('RETIREMENT_CURRENT_INVENTORY_UNAVAILABLE');process.exitCode=1; }
"""
def main():
 need(os.getuid()==0 and socket.gethostname().split('.')[0]=='docker'and sys.flags.isolated and len(sys.argv)==1,'RETIREMENT_ROOT_CONTEXT')
 sys.dont_write_bytecode=True
 launcher=verified_launcher();launcher.verified_bootstrap_code().context()
 manifest=read_regular(PUBLIC/'public-manifest-v5.json');need(sha(manifest)==MANIFEST_SHA,'RETIREMENT_MANIFEST_SHA')
 receipt=launcher.verify_bootstrap(MANIFEST_SHA)
 need(receipt['sources']['sim']['revision']=='15d8a75f1a260f1946e35774e727a2636decc841'and receipt['sources']['cop']['revision']=='4ed81c5a5ea0772a8d83636473925f07fe92b389','RETIREMENT_BUNDLE_REVISION')
 # This is an actual Root read; EACCES or any plan/enrollment/unknown is fatal.
 launcher.ensure_control_directory(launcher.V4_REPORT_SHA,require_existing=True)
 need(RECEIPTS.resolve()==RECEIPTS,'RETIREMENT_RECEIPT_DIRECTORY_PATH')
 d=RECEIPTS.lstat();need(stat.S_ISDIR(d.st_mode)and(d.st_uid,d.st_gid,stat.S_IMODE(d.st_mode))==(0,0,0o700),'RETIREMENT_RECEIPT_DIRECTORY_CUSTODY')
 raw={name:read_regular(RECEIPTS/name,root=True,maximum=16*1024*1024)for name in ['post-stop-inventory.json','inventory-transition.json','runtime-plan.json']}
 root=launcher.TARGET
 command=[str(root/'runtime/lib/ld-musl-x86_64.so.1'),'--library-path',str(root/'runtime/lib')+':'+str(root/'runtime/usr/lib'),str(root/'runtime/usr/local/bin/node'),'--input-type=module','-e',NODE]
 value=subprocess.run(command,stdin=subprocess.DEVNULL,capture_output=True,env=ENV,timeout=45)
 need(value.returncode==0 and len(value.stdout)<=1048576,'RETIREMENT_CURRENT_INVENTORY_FAILED')
 current=json.loads(value.stdout)
 # Re-read proof and BASE after inventory. No persistent receipt or marker.
 need(all(read_regular(RECEIPTS/name,root=True,maximum=16*1024*1024)==b for name,b in raw.items()),'RETIREMENT_RECEIPT_CHANGED')
 launcher.ensure_control_directory(launcher.V4_REPORT_SHA,require_existing=True)
 out=safe_projection(json.loads(raw['post-stop-inventory.json']),json.loads(raw['inventory-transition.json']),current,sha(raw['runtime-plan.json']),{name:sha(b)for name,b in raw.items()if name!='runtime-plan.json'})
 out['rootControlOnlyExpectedProofVerified']=True
 print(json.dumps(out))
if __name__=='__main__':
 try:main()
 except BaseException as error:
  code=str(error)if isinstance(error,RuntimeError)and re.fullmatch('(?:RETIREMENT|RELEASE)_[A-Z0-9_]+',str(error))else'RETIREMENT_READONLY_UNAVAILABLE'
  print(json.dumps({'error':code,'readOnly':True,'productionChanged':False}));raise SystemExit(1)
