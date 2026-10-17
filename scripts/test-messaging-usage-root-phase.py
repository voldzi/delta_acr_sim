"""Synthetic adapter checks, NOT production enrollment or writer custody."""
import importlib.util,pathlib,unittest
p=pathlib.Path(__file__).parent/'lib/messaging-usage-root-phase.py'
s=importlib.util.spec_from_file_location('phase',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Admission:
 def __init__(self,fail=0):self.calls=0;self.fail=fail
 def assert_current(self):
  self.calls+=1
  if self.calls==self.fail:raise RuntimeError('synthetic-custody-lost')
class Prepared:
 def __init__(self):
  self.nonce='synthetic-nonce';self.commits=[]
  self.summary={'mode':'initial','knownOwners':0,'unresolved':0,'writerInventorySha256':'w','planSha256':'p'}
 def commit(self,packet):
  self.commits.append(packet)
  return {'committed':True,'knownOwners':0,'unresolved':0,'writerClosureVerified':False,'baselineDigest':'b'}
class Phase(unittest.TestCase):
 def test_actual_packet_shape(self):
  a=Admission();p=Prepared();r=m.commit_with_current_custody(a,p,'w')
  self.assertEqual(a.calls,3);self.assertEqual(p.commits,[{'contractVersion':'cop-messaging-usage-commit-v1','nonce':'synthetic-nonce','planSha256':'p','writerInventorySha256':'w'}]);self.assertFalse(r['wholeAccountReady'])
 def test_custody_lost_before_commit(self):
  for n in [1,2]:
   p=Prepared()
   with self.assertRaisesRegex(RuntimeError,'custody-lost'):m.commit_with_current_custody(Admission(n),p,'w')
   self.assertEqual(p.commits,[])
 def test_nonempty_baseline_rejected(self):
  p=Prepared();p.summary['knownOwners']=1
  self.assertRaises(RuntimeError,m.commit_with_current_custody,Admission(),p,'w');self.assertEqual(p.commits,[])
 def test_writer_binding(self):
  p=Prepared();self.assertRaises(RuntimeError,m.commit_with_current_custody,Admission(),p,'different');self.assertEqual(p.commits,[])
 def test_unresolved_rejected(self):
  p=Prepared();p.summary['unresolved']=1;self.assertRaises(RuntimeError,m.commit_with_current_custody,Admission(),p,'w')
 def test_restore_not_initial(self):
  p=Prepared();p.summary['mode']='restore';self.assertRaises(RuntimeError,m.commit_with_current_custody,Admission(),p,'w')
 def test_inventory_digest_binding(self):
  p={'localWriters':{},'remoteWriters':{},'producerInventorySha256':'a'};a=m.writer_inventory_digest(p);p['producerInventorySha256']='b';self.assertNotEqual(a,m.writer_inventory_digest(p))
if __name__=='__main__':unittest.main()
