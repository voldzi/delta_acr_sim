"""Synthetic fd/CAS transition. Never changes actual ownership or permissions."""
import contextlib,importlib.util,os,pathlib,types,unittest
from unittest.mock import patch
p=pathlib.Path(__file__).parent/'bootstrap-clean-release-root.py'
s=importlib.util.spec_from_file_location('parent_bootstrap',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Parent(unittest.TestCase):
 def exercise(self,problem=None,already_root=False):
  state={'uid':0 if already_root else 1000,'gid':0 if already_root else 1000,'mode':0o40755 if already_root else 0o40700};calls=[];lists=[0]
  def info(ino=12,dev=2):return types.SimpleNamespace(st_dev=dev,st_ino=ino,st_mode=state['mode'],st_uid=state['uid'],st_gid=state['gid'],st_ctime_ns=7,st_mtime_ns=6,st_nlink=2,st_size=4096)
  def open_fd(path,flags):
   self.assertEqual(path,m.TARGET.parent);self.assertTrue(flags&os.O_NOFOLLOW);self.assertTrue(flags&os.O_DIRECTORY);calls.append('open');return 42
  def listing(fd):
   self.assertEqual(fd,42);lists[0]+=1
   if problem=='occupied':return [m.TARGET.name]
   if problem=='children'and lists[0]>1:return ['changed']
   return ['public-staging']
  def child(name,**kw):
   self.assertEqual(kw,{'dir_fd':42,'follow_symlinks':False});v=info(ino=20);v.st_uid=v.st_gid=1000;v.st_mode=0o100600;return v
  def chown(fd,uid,gid):self.assertEqual((fd,uid,gid),(42,0,0));calls.append('chown');state.update(uid=uid,gid=gid)
  def chmod(fd,mode):self.assertEqual((fd,mode),(42,0o755));calls.append('chmod');state.update(mode=0o40000|mode)
  def pathstat(path):return info(dev=1 if str(path)=='/'else 2)
  if problem=='uid':state['uid']=1001
  if problem=='mode':state['mode']=0o40777
  with contextlib.ExitStack()as stack:
   for obj,key,value in [(m,'command',lambda *a:(b'wrong'if problem=='uuid'else m.UUID.encode())),(pathlib.Path,'resolve',lambda path:(pathlib.Path('/wrong')if problem=='symlink'else path)),(pathlib.Path,'stat',pathstat),(pathlib.Path,'lstat',lambda path:info(ino=99 if problem=='cas'else 12)),(m.os,'open',open_fd),(m.os,'fstat',lambda fd:info()),(m.os,'listdir',listing),(m.os,'stat',child),(m.os,'fchown',chown),(m.os,'fchmod',chmod),(m.os,'fsync',lambda fd:calls.append('sync')),(m.os,'close',lambda fd:calls.append('close'))]:stack.enter_context(patch.object(obj,key,new=value))
   if problem:
    with self.assertRaises(RuntimeError):m.prepare_staging_parent()
   else:self.assertEqual(m.prepare_staging_parent(),{'rootParentPrepared':True,'childrenUnchanged':True,'recursiveOwnershipChange':False})
  return calls
 def test_exact_nonrecursive_held_fd_transition(self):self.assertEqual(self.exercise(),['open','chown','chmod','sync','close'])
 def test_existing_exact_root_parent_is_noop(self):self.assertEqual(self.exercise(already_root=True),['open','close'])
 def test_preconditions_refuse_without_chown(self):
  for problem in ['uuid','symlink','uid','mode','occupied','cas','children']:
   calls=self.exercise(problem);self.assertNotIn('chown',calls);self.assertNotIn('chmod',calls)
if __name__=='__main__':unittest.main()
