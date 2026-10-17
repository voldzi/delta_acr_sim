"""Isolated sequencing/failure tests. No Root, Docker, reset or real accounts."""
import contextlib,importlib.util,json,pathlib,types,unittest
from unittest.mock import patch
p=pathlib.Path(__file__).parent/'complete-clean-release.py'
s=importlib.util.spec_from_file_location('complete',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Chain(unittest.TestCase):
 def exercise(self,fail=None):
  calls=[]
  def step(name,result=None):
   def f(*a):
    calls.append(name)
    if fail==name:raise RuntimeError('TEST_'+name)
    return result
   return f
  class Remote:
   open=step('open');close=step('close')
  plan={'resetEpoch':'test','candidateImages':{'cop_api':'sha256:'+'a'*64}}
  def cop_receipt(enabled):return {'contractVersion':'cop-clean-guarded-runtime-v1','resetEpoch':'test','imageId':plan['candidateImages']['cop_api'],'sourceRevision':'b'*40,'active':{'imageId':plan['candidateImages']['cop_api'],'containerId':'c'*64},'erasureEnabled':enabled,'guardRequired':True,'healthAndPublicDemoPreserved':True,'oldImageFallback':False}
  host=types.SimpleNamespace(PLAN=pathlib.Path('/synthetic/plan'),protected=lambda p:json.dumps(plan),CommunicationResetTransport=Remote,_acceptance_module=lambda:types.SimpleNamespace(validate_for_plan=step('gate')))
  class Activation:
   offline_guard_readback=step('sql');stage_composition=step('stage');up_services=step('up');verify_capabilities=step('capabilities');receipt=step('sim-receipt',{'test':'sim'})
  @contextlib.contextmanager
  def begin(*a):
   calls.append('sim-acquire')
   try:yield Activation()
   except BaseException:calls.append('sim-failure-cleanup');raise
   finally:calls.append('sim-release')
  modules={'host':host,'cop':types.SimpleNamespace(capture_cop_pre_stop_health=step('capture'),prepare_cop_guarded_runtime=step('cop-prepare',cop_receipt(False)),enable_cop_guarded_runtime=step('cop-enable',cop_receipt(True))),'sim':types.SimpleNamespace(begin_sim_activation=begin),'message':types.SimpleNamespace(enable_messaging=step('message-enable',{'test':'enabled'}),pause_enabled_messaging=step('message-pause')),'disabled':types.SimpleNamespace(start_messaging_disabled=step('message-disabled',{'test':'disabled'}))}
  with patch.object(m.os,'getuid',return_value=0),patch.object(m.socket,'gethostname',return_value='docker'):
   m.capture_before_freeze(modules,{'resetEpoch':'test'})
   if fail:
    with self.assertRaisesRegex(RuntimeError,'TEST_'):m.complete_release(modules,{'resetEpoch':'test','runtimeFlagsEnabled':False},{'secret':'synthetic'})
   else:
    result=m.complete_release(modules,{'resetEpoch':'test','runtimeFlagsEnabled':False},{'secret':'synthetic'})
    self.assertEqual(result['cop'],cop_receipt(True));self.assertFalse(result['oldImageFallback'])
  return calls
 def test_order_and_no_cop_before_sim_and_message(self):
  self.assertEqual(self.exercise(),['capture','gate','open','message-disabled','sim-acquire','sql','stage','up','capabilities','sim-receipt','message-enable','sim-release','cop-prepare','cop-enable','close'])
 def test_sim_failure_cleans_and_never_enables_cop(self):
  for failure in ['sql','stage','up','capabilities','sim-receipt','message-enable']:
   calls=self.exercise(failure);self.assertIn('sim-failure-cleanup',calls);self.assertNotIn('cop-prepare',calls);self.assertNotIn('message-pause',calls);self.assertEqual(calls[-1],'close')
 def test_late_failure_pauses_exact_enabled_message(self):
  for failure in ['cop-prepare','cop-enable']:
   calls=self.exercise(failure);self.assertEqual(calls[-2:],['message-pause','close'])
 def test_disabled_start_failure_no_later_phase(self):
  self.assertEqual(self.exercise('message-disabled'),['capture','gate','open','message-disabled','close'])
 def test_no_direct_cop_compose_or_unprotected_deploy(self):
  text=p.read_text();self.assertNotIn('deploy-production.sh',text);self.assertNotIn("'docker','compose'",text)
 def test_bad_final_receipt_never_claims_acceptance(self):
  plan={'resetEpoch':'test','candidateImages':{'cop_api':'sha256:'+'a'*64}}
  with self.assertRaisesRegex(RuntimeError,'RECEIPT_BINDING'):m.validate_cop_receipt({'erasureEnabled':True},plan,True)
if __name__=='__main__':unittest.main()
