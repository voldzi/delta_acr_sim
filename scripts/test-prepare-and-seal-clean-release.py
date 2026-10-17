"""Synthetic Root orchestration only, no real credentials/SSH/PG/publication."""
import hashlib,importlib.util,json,pathlib,types,unittest
from unittest.mock import patch
p=pathlib.Path(__file__).parent/'prepare-and-seal-clean-release.py'
s=importlib.util.spec_from_file_location('release',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Release(unittest.TestCase):
 def test_outer_cleanup_after_success(self):
  calls=[]
  with patch.object(m,'cleanup_temporary_transport',side_effect=lambda:calls.append('cleanup')):
   self.assertEqual(m.run_with_transport_cleanup(lambda:(calls.append('action'),'ok')[1]),'ok')
  self.assertEqual(calls,['action','cleanup'])
 def test_outer_cleanup_after_failure(self):
  calls=[]
  def fail():calls.append('failure');raise RuntimeError('TEST_ORIGINAL_FAILURE')
  with patch.object(m,'cleanup_temporary_transport',side_effect=lambda:calls.append('cleanup')):
   with self.assertRaisesRegex(RuntimeError,'ORIGINAL_FAILURE'):m.run_with_transport_cleanup(fail)
  self.assertEqual(calls,['failure','cleanup'])
 def test_cleanup_failure_never_success(self):
  with patch.object(m,'cleanup_temporary_transport',side_effect=RuntimeError('TEST_CLEANUP_FAILED')),patch('builtins.print') as output:
   with self.assertRaisesRegex(RuntimeError,'CLEANUP_FAILED'):m.run_with_transport_cleanup(lambda:None)
   self.assertIn('RELEASE_TEMPORARY_TRANSPORT_CLEANUP_FAILED',output.call_args.args[0])
 def test_bootstrap_bytes_pin(self):
  raw=(p.parent/'bootstrap-clean-release-root.py').read_bytes()
  self.assertEqual(hashlib.sha256(raw).hexdigest(),m.BOOTSTRAP_SHA)
  self.assertTrue(callable(m.verified_bootstrap_code().bootstrap_clean_release))
 def test_no_cli_automatic_activation(self):
  text=p.read_text()
  self.assertIn("if a.apply_disabled_reset:",text)
  self.assertIn("'productionActivated':False",text)
  self.assertNotIn('pickle',text)
 def exercise(self,deny=False):
  calls=[];published=[];secret='synthetic-private-password-never-publish'
  class Remote:
   def open(self):calls.append('comm-open')
   def close(self):calls.append('comm-close')
   def run(self,*a,**kw):raise AssertionError('NO_REAL_SSH')
  class Storage:
   def __init__(self,p):pass
   def open(self,p):calls.append('storage-open')
   def close(self):calls.append('storage-close')
  local={k:{'id':'a'*64,'image':'sha256:'+'b'*64} for k in ['csm-sim-api','csm-sim-ai-router-api','csm-sim-situation-data-api']}
  def gate(images):
   calls.append('gate')
   if deny:raise RuntimeError('SYNTHETIC_GATE_DENIED')
  host=types.SimpleNamespace(CommunicationResetTransport=Remote,LOCAL_WRITERS=tuple(local),REMOTE_WRITERS=(),command=object(),inspect_writers=lambda run,names:local if names else {},DriverReportProducerCustody=lambda:types.SimpleNamespace(_inventory=lambda:(b'',None,{'paused':False,'activeProducerCount':0,'originalCronSha256':'c'})),_acceptance_module=lambda:types.SimpleNamespace(verified_pre_stop_acceptance=gate),validate_plan=lambda p:calls.append('validate12'))
  def node(options,decision):
   calls.append('node7')
   self.assertEqual(options['postgresPassword'],secret)
   return {'privateConfig':{'resetEpoch':options['resetEpoch'],'tokensNotBefore':options['tokensNotBefore']},'copSafetyPrepared':{},'copManifestBytes':b'{"public":true}\n'}
  def collect(*a):
   calls.append('message-inspect')
   return {'nativeAdminToken':'synthetic-admin','envelope':{},'connections':{},'rootBase64':'synthetic-root'}
  def inspect(*a):calls.append('remaining3');return {}
  def finalize(private,*a):return {'privateConfig':private,'publicSummary':{}}
  def attach(joined,*a):calls.append('join12');return {**joined,'publicSummary':{'reviewedPlanDigests':{str(i):'a'*64 for i in range(12)}}}
  modules={'sealed_release_controller':types.SimpleNamespace(host=host),'sealed_release_collector':types.SimpleNamespace(collect_messaging_initial_private=collect),'sealed_release_remaining':types.SimpleNamespace(inspect_remaining_private=inspect,finalize_private_preparation=finalize,attach_messaging_install_preparation=attach),'sealed_release_s3':types.SimpleNamespace(ProductionStorage=Storage)}
  bootstrap={'sources':{k:{'root':'/synthetic/'+k,'files':{}} for k in ['cop','sim','messaging']},'dependencyImage':'synthetic-dependency'}
  manifest={'candidateImages':{},'storageProvider':{}}
  fake_stat=types.SimpleNamespace(st_mode=0o100600,st_nlink=1,st_dev=1,st_ino=2,st_uid=0,st_gid=0)
  with patch.object(m,'load',side_effect=lambda path,name:modules[name]),patch.object(m,'node_prepare',side_effect=node),patch.object(m,'root_read',return_value=b'{}'),patch.object(pathlib.Path,'lstat',return_value=fake_stat),patch.object(pathlib.Path,'exists',return_value=False),patch.object(m,'publish_new',side_effect=lambda path,raw:published.append(raw)):
   if deny:
    with self.assertRaisesRegex(RuntimeError,'SYNTHETIC_GATE_DENIED'):m.prepare_and_seal_clean_release(bootstrap,manifest,secret,{})
   else:
    r=m.prepare_and_seal_clean_release(bootstrap,manifest,secret,{})
    self.assertEqual(len(r['plan']['reviewedPlanDigests']),12)
    self.assertIn('expectedImages',r['privateConfig'])
  self.assertNotIn(secret,b''.join(published).decode())
  return calls,published
 def test_actual_plan_flow_not_private_publication(self):
  calls,p=self.exercise()
  self.assertEqual(calls,['comm-open','gate','node7','message-inspect','storage-open','remaining3','join12','validate12','storage-close','comm-close'])
  self.assertEqual(len(p),2)
 def test_gate_failure_no_inspection_or_publication(self):
  calls,p=self.exercise(True);self.assertEqual(calls,['comm-open','gate','comm-close']);self.assertEqual(p,[])
if __name__=='__main__':unittest.main()
