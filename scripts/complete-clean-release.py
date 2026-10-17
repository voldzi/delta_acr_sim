"""Concrete Root activation chain. All adapters come from the sealed plan.
No direct Compose COP bypass, secret persistence, old-writer fallback or reset.
"""
import importlib.util,json,os,socket
from pathlib import Path
def need(v,code='CLEAN_RELEASE_ACTIVATION_UNPROVEN'):
 if not v:raise RuntimeError(code)
def load(path,name):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def activation_modules(bootstrap):
 cop=Path(bootstrap['sources']['cop']['root']);sim=Path(bootstrap['sources']['sim']['root'])
 host=load(cop/'scripts/account-safety/clean-reset-root.py','complete_release_host')
 modules={'host':host,
  'cop':load(cop/'scripts/account-safety/activate-clean-cop.py','complete_cop_runtime'),
  'disabled':load(cop/'scripts/account-safety/start-messaging-disabled.py','complete_message_disabled'),
  'sim':load(sim/'scripts/activate-clean-sim.py','complete_sim_activation'),
  'message':load(sim/'scripts/lib/enable-clean-messaging.py','complete_message_enable')}
 for key,names in {'cop':['capture_cop_pre_stop_health','prepare_cop_guarded_runtime','enable_cop_guarded_runtime'],'disabled':['start_messaging_disabled'],'sim':['begin_sim_activation'],'message':['enable_messaging','pause_enabled_messaging']}.items():
  need(all(callable(getattr(modules[key],n,None))for n in names),'CLEAN_RELEASE_ADAPTER_MISSING')
 return modules
def capture_before_freeze(modules,plan):
 need(os.getuid()==0 and socket.gethostname().split('.')[0]=='docker')
 return modules['cop'].capture_cop_pre_stop_health(modules['host'],plan)
def complete_release(modules,reset_result,private_config):
 need(os.getuid()==0 and socket.gethostname().split('.')[0]=='docker')
 host=modules['host'];plan=json.loads(host.protected(host.PLAN))
 need(reset_result.get('resetEpoch')==plan['resetEpoch']and reset_result.get('runtimeFlagsEnabled')is False)
 host._acceptance_module().validate_for_plan(plan)
 remote=host.CommunicationResetTransport();enabled=None
 try:
  remote.open()
  disabled=modules['disabled'].start_messaging_disabled(host,remote,reset_result,private_config)
  with modules['sim'].begin_sim_activation(reset_result,private_config)as activation:
   activation.offline_guard_readback();activation.stage_composition();activation.up_services();activation.verify_capabilities()
   sim=activation.receipt()
   enabled=modules['message'].enable_messaging(host,remote,disabled,plan['candidateImages'])
  evidence={'messagingDisabled':disabled,'sim':sim,'messaging':enabled}
  prepared=modules['cop'].prepare_cop_guarded_runtime(host,reset_result,private_config,evidence)
  result=modules['cop'].enable_cop_guarded_runtime(host,reset_result,private_config,{**evidence,'copPrepared':prepared})
  # The concrete COP bridge owns protected Store/public health final acceptance.
  # Preserve its actual receipt; do not infer deployment from an arbitrary bool.
  return {'contractVersion':'cop-sim-complete-release-result-v1','resetEpoch':plan['resetEpoch'],'sim':sim,'messaging':enabled,'cop':result,'wholeAccountComplete':False,'oldImageFallback':False}
 except BaseException:
  if enabled is not None:modules['message'].pause_enabled_messaging(host,remote,enabled)
  raise
 finally:remote.close()
