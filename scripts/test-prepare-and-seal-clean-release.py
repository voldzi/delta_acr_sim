"""Synthetic Root orchestration only, no real credentials/SSH/PG/publication."""
import hashlib,importlib.util,json,pathlib,types,unittest
from unittest.mock import patch
p=pathlib.Path(__file__).parent/'prepare-and-seal-clean-release.py'
s=importlib.util.spec_from_file_location('release',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Release(unittest.TestCase):
 def test_peer_cleanup_requires_confirmed_control_shutdown(self):
  result={'peers':{'comm.home.cz':True,'storage.home.cz':True},'controlPeers':{'comm.home.cz':True,'storage.home.cz':False},'controlSessionsClosed':False,'temporaryPrivateIdentityRemoved':True,'exactAuthorizationsAbsent':True}
  with patch.object(m.os.path,'lexists',return_value=True),patch.object(m,'pinned_public_module',return_value=types.SimpleNamespace(cleanup_release_identity=lambda:result)),patch('builtins.print'):
   with self.assertRaisesRegex(RuntimeError,'PEER_CLEANUP_NOT_VERIFIED'):m.cleanup_temporary_transport()
 def test_shared_peer_helper_pin_matches_bootstrap(self):
  self.assertEqual(m.TEMP_PEER_HELPER_SHA,m.verified_bootstrap_code().PEER_HELPER_SHA)
 def test_peer_cleanup_independent_of_failed_bootstrap_and_no_legacy_fallback(self):
  for failed in [None,'comm.home.cz','storage.home.cz']:
   result={'peers':{host:host!=failed for host in ['comm.home.cz','storage.home.cz']},'controlPeers':{host:True for host in ['comm.home.cz','storage.home.cz']},'controlSessionsClosed':True,'temporaryPrivateIdentityRemoved':True,'exactAuthorizationsAbsent':failed is None}
   helper=types.SimpleNamespace(cleanup_release_identity=lambda:result)
   with patch.object(m.os.path,'lexists',return_value=True),patch.object(m,'pinned_public_module',return_value=helper)as load,patch.object(m,'verified_bootstrap_code',side_effect=AssertionError('NO_BOOTSTRAP_DEPENDENCY')),patch('builtins.print'):
    if failed:
     with self.assertRaisesRegex(RuntimeError,'PEER_CLEANUP_NOT_VERIFIED'):m.cleanup_temporary_transport()
    else:m.cleanup_temporary_transport()
    load.assert_called_once_with(m.TEMP_PEER_HELPER,m.TEMP_PEER_HELPER_SHA,'release_peer_key_cleanup')
 def test_original_error_survives_cleanup_error_without_secret_text(self):
  def action():raise RuntimeError('ROOT_TEMP_COMM_KEY_PAIR')
  with patch.object(m,'cleanup_temporary_transport',side_effect=RuntimeError('RELEASE_TEMP_AUTHORIZATION_REMOVE_FAILED')),patch('builtins.print')as output:
   with self.assertRaisesRegex(RuntimeError,'ROOT_TEMP_COMM_KEY_PAIR'):m.run_with_transport_cleanup(action)
   lines=[json.loads(c.args[0])for c in output.call_args_list]
  self.assertEqual(lines[0]['code'],'ROOT_TEMP_COMM_KEY_PAIR');self.assertEqual(lines[1]['code'],'RELEASE_TEMP_AUTHORIZATION_REMOVE_FAILED')
  self.assertNotIn('synthetic-secret',m.safe_failure_code(RuntimeError('synthetic-secret')))
 def test_cleanup_remote_command_preserves_exact_host_and_quoted_program(self):
  import shlex
  captured=[];program='synthetic program with spaces and "quotes"'
  def cleanup(host):
   t=host.CommunicationResetTransport();t.open();t.run(['/usr/bin/python3','-I','-c',program,'remove'],input=b'{}');t.close()
   return {'temporaryPrivateIdentityRemoved':True,'exactAuthorizationAbsent':True}
  bootstrap=types.SimpleNamespace(temporary_comm_identity=lambda:'/run/cop-clean-reset-comm/id_ed25519',transport_args=lambda host:['/usr/bin/ssh','-i','/run/cop-clean-reset-comm/id_ed25519','voldzi@comm.home.cz','/usr/bin/sudo','-n','/usr/bin/id','-u'])
  with patch.object(m.os.path,'lexists',side_effect=lambda path:str(path)!='/run/cop-clean-reset-peers'),patch.object(m,'verified_bootstrap_code',return_value=bootstrap),patch.object(m,'pinned_public_module',side_effect=[types.SimpleNamespace(cleanup_temporary_comm_key=cleanup),types.SimpleNamespace(REMOTE_PROGRAM=program)]),patch.object(m.subprocess,'run',side_effect=lambda args,**kw:(captured.append((args,kw)),types.SimpleNamespace(returncode=0,stdout=b'{}'))[1]),patch('builtins.print'):
   m.cleanup_temporary_transport()
  args,kw=captured[0];self.assertEqual(args[-2],'voldzi@comm.home.cz');self.assertEqual(shlex.split(args[-1]),['/usr/bin/sudo','-n','/usr/bin/python3','-I','-c',program,'remove']);self.assertEqual(kw['input'],b'{}')
 def test_acceptance_published_only_after_sha_and_strict_gate(self):
  raw=b'{"contractVersion":"cop-sim-whole-clean-acceptance-v3"}'
  manifest={'acceptanceReport':{'path':'/srv/x5-production/staging/cop/reviewed/report.json','sha256':hashlib.sha256(raw).hexdigest()},'candidateImages':{}}
  calls=[];gate=types.SimpleNamespace(REPORT=m.BASE/'whole12-acceptance.json',validate_clean_whole_report_v3=lambda *a:calls.append('validate'))
  host=types.SimpleNamespace(_acceptance_module=lambda:gate);boot=types.SimpleNamespace(public_bytes=lambda *a:raw)
  with patch.object(pathlib.Path,'resolve',lambda p:p),patch.object(m.os.path,'lexists',return_value=False),patch.object(m,'publish_new',side_effect=lambda *a:calls.append('publish')):
   m.publish_acceptance_report(boot,host,manifest)
  self.assertEqual(calls,['validate','publish'])
  bad={**manifest,'acceptanceReport':{**manifest['acceptanceReport'],'sha256':'0'*64}}
  with patch.object(pathlib.Path,'resolve',lambda p:p),patch.object(m,'publish_new')as publish:
   with self.assertRaisesRegex(RuntimeError,'ACCEPTANCE_SHA'):m.publish_acceptance_report(boot,host,bad)
   publish.assert_not_called()
 def test_acceptance_existing_conflict_not_overwritten(self):
  raw=b'{"contractVersion":"cop-sim-whole-clean-acceptance-v3"}'
  manifest={'acceptanceReport':{'path':'/srv/x5-production/staging/cop/reviewed/report.json','sha256':hashlib.sha256(raw).hexdigest()},'candidateImages':{}}
  gate=types.SimpleNamespace(REPORT=m.BASE/'whole12-acceptance.json',validate_clean_whole_report_v3=lambda *a:None)
  with patch.object(pathlib.Path,'resolve',lambda p:p),patch.object(m.os.path,'lexists',return_value=True),patch.object(m,'root_read',return_value=b'other'),patch.object(m,'publish_new')as publish:
   with self.assertRaisesRegex(RuntimeError,'EXISTING_CONFLICT'):m.publish_acceptance_report(types.SimpleNamespace(public_bytes=lambda *a:raw),types.SimpleNamespace(_acceptance_module=lambda:gate),manifest)
   publish.assert_not_called()
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
  self.assertIn("if a.apply_disabled_reset or a.complete_release:",text)
  self.assertIn("activation.capture_before_freeze(modules,prepared['plan'])",text)
  self.assertIn("'productionActivated':False",text)
  self.assertNotIn('pickle',text)
 def exercise(self,deny=False,close_failure=False):
  calls=[];published=[];secret='synthetic-private-password-never-publish'
  class Remote:
   def open(self):calls.append('comm-open')
   def close(self):calls.append('comm-close')
   def run(self,*a,**kw):raise AssertionError('NO_REAL_SSH')
  class Storage:
   def __init__(self,p):pass
   def open(self,p):calls.append('storage-open')
   def close(self):
    calls.append('storage-close')
    if close_failure:raise RuntimeError('SYNTHETIC_STORAGE_CLOSE_FAILED')
  local={k:{'id':'a'*64,'image':'sha256:'+'b'*64} for k in ['cop-cop-api-1','csm-sim-api','csm-sim-ai-router-api','csm-sim-situation-data-api']}
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
  with patch.object(m,'load',side_effect=lambda path,name:modules[name]),patch.object(m,'node_prepare',side_effect=node),patch.object(m,'read_current_runtime_binding',return_value={}),patch.object(m,'root_read',return_value=b'{}'),patch.object(pathlib.Path,'lstat',return_value=fake_stat),patch.object(pathlib.Path,'exists',return_value=False),patch.object(m,'publish_new',side_effect=lambda path,raw:published.append(raw)):
   if deny or close_failure:
    with self.assertRaisesRegex(RuntimeError,'SYNTHETIC_GATE_DENIED'if deny else'SYNTHETIC_STORAGE_CLOSE_FAILED'):m.prepare_and_seal_clean_release(bootstrap,manifest,secret,{})
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
 def test_storage_close_failure_still_closes_comm(self):
  calls,_=self.exercise(close_failure=True);self.assertEqual(calls[-2:],['storage-close','comm-close'])
if __name__=='__main__':unittest.main()
