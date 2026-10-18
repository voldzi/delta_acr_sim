"""Synthetic control-dir fd/CAS and public pointer tests; no production changes."""
import importlib.util,json,os,pathlib,stat,tempfile,types,unittest
from unittest.mock import patch
p=pathlib.Path(__file__).with_name('prepare-and-seal-clean-release.py');s=importlib.util.spec_from_file_location('prep',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def meta(uid=0,gid=0,mode=0o40700,ino=43):return types.SimpleNamespace(st_dev=1,st_ino=ino,st_uid=uid,st_gid=gid,st_mode=mode,st_nlink=2,st_size=4096,st_mtime_ns=5,st_ctime_ns=6)
class Control(unittest.TestCase):
 def test_ancestry_walk_uses_nofollow_dirfds_and_preserves_parent(self):
  fds=iter([10,11,12,13]);closed=[]
  def opened(name,flags,**kw):self.assertTrue(flags&os.O_NOFOLLOW);self.assertTrue(flags&os.O_DIRECTORY);return next(fds)
  def fstat(fd):return meta(1000 if fd>=12 else 0,1000 if fd>=12 else 0,0o40700 if fd==13 else 0o40755,fd)
  with patch.object(m.os,'geteuid',return_value=0),patch.object(m.socket,'gethostname',return_value='docker'),patch.object(m.os,'open',side_effect=opened),patch.object(m.os,'fstat',side_effect=fstat),patch.object(m.os,'close',side_effect=closed.append):
   parent,chain=m.open_control_parent()
  self.assertEqual(parent,13);self.assertEqual(closed,[12,11,10]);self.assertEqual([str(p)for p,_ in chain],['/','/srv','/srv/cop','/srv/cop/runtime'])
 def test_parent_path_cas_drift_refused(self):
  with patch.object(pathlib.Path,'lstat',return_value=meta(1000,1000,0o40700,99)):
   with self.assertRaisesRegex(RuntimeError,'PARENT_CAS'):m.check_control_parent([(pathlib.Path('/srv/cop/runtime'),m.directory_identity(meta(1000,1000,0o40700,13)))])
 def exercise(self,problem=None,existing=False,report=False):
  names=['api']+(['clean-reset']if existing else[]);calls=[];child=meta(uid=1000 if problem=='owner'else 0);child.st_mode=0o120777 if problem=='symlink'else 0o40700
  def listing(fd):return (['unknown']if problem=='nonempty'else ['whole12-acceptance.json']if report else[])if fd==43 else list(names)
  def mk(name,mode,**kw):self.assertEqual((name,mode,kw),('clean-reset',0o700,{'dir_fd':42}));calls.append('mkdir');names.append(name)
  def opened(name,flags,**kw):self.assertTrue(flags&os.O_NOFOLLOW);self.assertEqual(kw,{'dir_fd':42});return 43
  def st(name,**kw):return child if name=='clean-reset'else meta(1000,1000,0o40700,7)
  proof=meta(mode=0o100600);proof.st_nlink=1
  with patch.object(m,'open_control_parent',return_value=(42,[])),patch.object(m,'check_control_parent'),patch.object(m.os,'listdir',side_effect=listing),patch.object(m.os,'mkdir',side_effect=mk),patch.object(m.os,'open',side_effect=opened),patch.object(m.os,'fstat',return_value=child),patch.object(m.os,'stat',side_effect=st),patch.object(m.os,'fchown',side_effect=lambda fd,u,g:(self.assertEqual((fd,u,g),(43,0,0)),calls.append('chown'))),patch.object(m.os,'fchmod',side_effect=lambda fd,v:(self.assertEqual((fd,v),(43,0o700)),calls.append('chmod'))),patch.object(m.os,'fsync'),patch.object(m.os,'close'),patch.object(pathlib.Path,'lstat',return_value=proof),patch.object(m,'root_read',return_value=b'synthetic-public-proof'),patch.object(m,'V4_REPORT_SHA',m.sha(b'synthetic-public-proof')):
   if problem:
    with self.assertRaisesRegex(RuntimeError,'DIRECTORY_CUSTODY'):m.ensure_control_directory()
   else:self.assertEqual(m.ensure_control_directory(m.V4_REPORT_SHA if report else None,require_existing=report)['created'],not existing)
  return calls
 def test_missing_base_created_only_child_fd_mutated(self):self.assertEqual(self.exercise(),['mkdir','chown','chmod'])
 def test_existing_empty_root_is_noop(self):self.assertEqual(self.exercise(existing=True),[])
 def test_exact_existing_public_report_is_preserved_without_mutation(self):self.assertEqual(self.exercise(existing=True,report=True),[])
 def test_unknown_existing_owner_symlink_or_content_not_adopted(self):
  for problem in ['owner','symlink','nonempty']:self.assertEqual(self.exercise(problem,existing=True),[])
class RuntimePointer(unittest.TestCase):
 def test_actual_uid1000_pointer_and_schema_binding(self):
  v={'contractVersion':'cop-api-runtime-active-v1','generation':'a'*32,'releaseId':'release-'+'b'*32,'profileId':'00000000-0000-4000-8000-000000000001','profileGeneration':'00000000-0000-4000-8000-000000000001','imageId':'sha256:'+'c'*64,'containerId':'d'*64}
  with tempfile.TemporaryDirectory(dir='/private/tmp')as d:
   path=pathlib.Path(d)/'active.json';path.write_text(json.dumps(v));realstat=os.stat(path);original=os.fstat
   def fake(fd):
    q=original(fd);return types.SimpleNamespace(**{k:getattr(q,k)for k in ['st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns']},st_uid=1000,st_gid=1000,st_mode=0o100600,st_nlink=1)
   def lst(p):return meta(1000,1000,0o40700)if p==path.parent else types.SimpleNamespace(st_dev=realstat.st_dev,st_ino=realstat.st_ino,st_mtime_ns=realstat.st_mtime_ns,st_ctime_ns=realstat.st_ctime_ns)
   with patch.object(m,'RUNTIME_BINDING',path),patch.object(pathlib.Path,'resolve',new=lambda p:p),patch.object(pathlib.Path,'lstat',new=lst),patch.object(m.os,'fstat',side_effect=fake):
    self.assertEqual(m.read_current_runtime_binding({'id':v['containerId'],'image':v['imageId']}),v)
    with self.assertRaisesRegex(RuntimeError,'ACTUAL_MISMATCH'):m.read_current_runtime_binding({'id':'e'*64,'image':v['imageId']})
    with patch.object(m.os,'fstat',return_value=meta(uid=0,mode=0o100600)):
     with self.assertRaisesRegex(RuntimeError,'POINTER_CUSTODY'):m.read_current_runtime_binding({'id':v['containerId'],'image':v['imageId']})
if __name__=='__main__':unittest.main()
