"""Synthetic public-bundle transition, never contacts production/SSH/PG."""
import copy,importlib.util,json,os,pathlib,stat,tempfile,types,unittest
from unittest.mock import patch
p=pathlib.Path(__file__).with_name('prepare-and-seal-clean-release.py')
s=importlib.util.spec_from_file_location('transition',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def metadata(mode,ino):return types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=mode,st_dev=7,st_ino=ino,st_mtime_ns=1,st_ctime_ns=2)
class Transition(unittest.TestCase):
 def exercise(self,problem=None):
  item=lambda revision:{'revision':revision,'file':revision[:7]+'.tar','sha256':m.sha(b'synthetic-archive')}
  old={'archives':{'cop':item('f4f0474ec5c5697010b9bdfddb58fac3f1786610'),'sim':item('1'*40),'messaging':item('2'*40)},'candidateImages':{'cop_api':'unchanged'},'acceptanceReport':{'sha256':m.V4_REPORT_SHA}}
  new=copy.deepcopy(old);new['archives']['cop']=item(m.FIXED_COP_REVISION)
  if problem=='image':new['candidateImages']['cop_api']='other'
  if problem=='revision':new['archives']['cop']['revision']='3'*40
  if problem=='report':new['acceptanceReport']['sha256']='0'*64
  if problem=='sim':new['archives']['sim']['revision']='4'*40
  raw=json.dumps(old).encode();calls=[];renamed=False
  def read(path,size):
   if path==m.V4_MANIFEST:return raw
   if problem=='archive':return b'corrupt'
   return b'synthetic-archive'
  def control(*a,**k):
   self.assertEqual((a,k),((m.V4_REPORT_SHA,),{'require_existing':True}));calls.append('base')
   if problem in ['plan','enrollment','epoch','unknown','eacces']:raise PermissionError('synthetic')if problem=='eacces'else RuntimeError('RELEASE_CONTROL_DIRECTORY_CUSTODY')
  parent=metadata(0o40755,10);source=metadata(0o40555,11)
  def listing(fd):return [m.V4_ARCHIVE.name]if renamed or problem=='occupied'else[m.TARGET.name]
  def rename(fd,src,dst):
   nonlocal renamed
   self.assertEqual((fd,src,dst),(55,m.TARGET.name,m.V4_ARCHIVE.name));calls.append('rename');renamed=True
  gate=types.SimpleNamespace(validate_clean_whole_report_v3=lambda *a:calls.append('gate'))
  boot=types.SimpleNamespace(context=lambda:calls.append('context'),public_bytes=read)
  receipt={'plansPrepared':0,'resetExecuted':False,'productionActivated':False,'sources':{k:{'revision':v['revision'],'root':'/synthetic/'+k}for k,v in old['archives'].items()}}
  def verification(digest):self.assertEqual(digest,m.V4_MANIFEST_SHA);calls.append('old-verify');return receipt
  def getstat(name,**kw):
   if problem=='drift'and calls.count('base')>=2:return metadata(0o40555,12)
   return source
  with patch.object(m,'V4_MANIFEST_SHA',m.sha(raw)),patch.object(m,'verify_bootstrap',side_effect=verification),patch.object(m,'ensure_control_directory',side_effect=control),patch.object(m,'load',return_value=types.SimpleNamespace(_acceptance_module=lambda:gate)),patch.object(m,'root_read',return_value=b'{}'),patch.object(pathlib.Path,'resolve',lambda p:p),patch.object(m.os,'open',return_value=55),patch.object(m.os,'fstat',return_value=parent),patch.object(m.os,'stat',side_effect=getstat),patch.object(pathlib.Path,'lstat',return_value=parent),patch.object(m.os,'listdir',side_effect=listing),patch.object(m,'rename_public_bundle_noreplace',side_effect=rename),patch.object(m.os,'fsync'),patch.object(m.os,'close'):
   if problem:
    with self.assertRaises((RuntimeError,PermissionError)):m.preserve_public_v4(boot,new,pathlib.Path('/synthetic/manifest'))
   else:self.assertTrue(m.preserve_public_v4(boot,new,pathlib.Path('/synthetic/manifest'))['publicV4Preserved'])
  self.assertEqual(calls.count('rename'),0 if problem else 1)
  return calls
 def test_only_public_cop_source_changes_and_proof_precedes_rename(self):
  self.assertEqual(self.exercise(),['context','old-verify','base','gate','base','rename'])
 def test_plan_enrollment_epoch_unknown_and_denied_inventory_stop_before_mutation(self):
  for problem in ['plan','enrollment','epoch','unknown','eacces']:self.exercise(problem)
 def test_image_report_sim_revision_corrupt_archive_occupied_and_drift_rejected(self):
  for problem in ['image','report','sim','revision','archive','occupied','drift']:self.exercise(problem)
 def test_native_atomic_rename_preserves_bytes_and_never_overwrites(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp')as d:
   root=pathlib.Path(d);(root/'old').mkdir();(root/'old'/'proof').write_bytes(b'synthetic-public')
   fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
   try:
    m.rename_public_bundle_noreplace(fd,'old','saved');self.assertEqual((root/'saved'/'proof').read_bytes(),b'synthetic-public');self.assertFalse((root/'old').exists())
    (root/'old').mkdir()
    with self.assertRaises(OSError):m.rename_public_bundle_noreplace(fd,'old','saved')
    self.assertTrue((root/'old').is_dir());self.assertEqual((root/'saved'/'proof').read_bytes(),b'synthetic-public')
   finally:os.close(fd)
if __name__=='__main__':unittest.main()
