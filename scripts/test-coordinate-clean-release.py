"""Pure orchestration and owned-file tests, NOT actual whole12/Root proof."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
import uuid
spec = importlib.util.spec_from_file_location('common', Path(__file__).with_name('coordinate-clean-release.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

def inputs():
    issuer='https://login.zeleznalady.cz/realms/cop';epoch=str(uuid.uuid4())
    existing={k:'x'*64 for k in ['AI_ROUTER_COP_TOKEN','AI_ROUTER_COP_ACTOR_SECRET','AI_ROUTER_USER_HASH_SECRET','AI_ROUTER_SIM_TOKEN','DRIVER_MEASUREMENTS_COP_TOKEN','DRIVER_MEASUREMENTS_HASH_SECRET','DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET']}
    existing.update({k:issuer for k in ['AI_ROUTER_ACCOUNT_ERASURE_ISSUER','DRIVER_ACCOUNT_ERASURE_ISSUER','SIM_OIDC_ISSUER']})
    existing.update(SIM_API_AUTH_MODE='hybrid',SIM_PUBLISHER_MODE='DRY_RUN')
    raw=('PROVIDER_UNCHANGED=public-fixture\n'+'\n'.join(k+'='+v for k,v in existing.items())+'\n').encode()
    e=lambda:{'resetEpoch':epoch,'tokensNotBefore':123,'environmentId':str(uuid.uuid4()),'userDatasetId':str(uuid.uuid4()),'enrollmentId':str(uuid.uuid4())}
    b={'environment_id':str(uuid.uuid4()),'reset_epoch':epoch}
    config={'enrollments':{'ai':e(),'driver':e()},'simUserInstall':{'resetEpoch':epoch,'tokensNotBefore':123,'serviceToken':'s'*64,
      'identities':{'sim_user_data':{'issuer':issuer,'ownerSecret':'o'*64,'actorSecret':'a'*64,'routerActorSecret':'r'*64},'sim_user_history':{'issuer':issuer,'hashSecret':'x'*64}},
      'bindings':{'sim_user_data':b,'sim_user_history':b},'credentials':{k:'p'*64 for k in ['sim_user_data_runtime','sim_user_data_guard_runtime','sim_user_history_guard_runtime']}}}
    return config,raw

class Configuration(unittest.TestCase):
    def test_completed_replay_default_off_and_exact_opt_in(self):
        config,raw=inputs();env,services=m.disabled_runtime(config,raw)
        keys=['SIM_CLEAN_COMPLETED_REPLAY_MODE','SIM_USER_DATA_COMPLETED_REPLAY_MODE','SIM_USER_HISTORY_COMPLETED_REPLAY_MODE']
        self.assertTrue(all(env[k]=='disabled' for k in keys))
        config['simUserInstall']['completedReplayMode']='same-epoch-completed-content-replay-v1'
        env,services=m.disabled_runtime(config,raw)
        self.assertTrue(all(env[k]=='same-epoch-completed-content-replay-v1' for k in keys))
        self.assertIn('SIM_USER_DATA_COMPLETED_REPLAY_MODE',services['sim-api'])
        self.assertIn('SIM_USER_HISTORY_COMPLETED_REPLAY_MODE',services['ai-router-api'])
        self.assertIn('SIM_CLEAN_COMPLETED_REPLAY_MODE',services['ai-router-api'])
        self.assertIn('SIM_CLEAN_COMPLETED_REPLAY_MODE',services['situation-data-api'])
        self.assertEqual(env['SIM_USER_DATA_ENABLED'],'false')
        config['simUserInstall']['completedReplayMode']='true'
        with self.assertRaisesRegex(RuntimeError,'COMPLETED_REPLAY_MODE'):m.disabled_runtime(config,raw)
    def test_separate_lane_ids_and_false_flags(self):
        config,raw=inputs();env,services=m.disabled_runtime(config,raw)
        self.assertNotEqual(env['SIM_CLEAN_AI_USER_DATASET_ID'],env['SIM_CLEAN_DRIVER_USER_DATASET_ID'])
        self.assertEqual(env['SIM_CLEAN_AI_ENABLED'],'false')
        self.assertEqual(env['SIM_CLEAN_DRIVER_ENABLED'],'false')
        self.assertEqual(env['SIM_USER_DATA_ENABLED'],'false')
        self.assertEqual(services['ai-router-api']['SIM_CLEAN_LIFECYCLE_USER_DATASET_ID'],'SIM_CLEAN_AI_USER_DATASET_ID')
        self.assertNotIn('AI_ROUTER_COP_TOKEN',env)

    def test_preserved_lines_and_no_injection(self):
        config,raw=inputs();env,_=m.disabled_runtime(config,raw);after=m.render_environment(raw,env)
        self.assertTrue(after.startswith(raw))
        self.assertIn(b'SIM_USER_DATA_ENABLED=\'false\'',after)
        with self.assertRaisesRegex(RuntimeError,'ENV_VALUE'):m.render_environment(raw,{'BAD':'value\nOTHER=bad'})

    def test_changed_hash_refused(self):
        config,raw=inputs();config['simUserInstall']['identities']['sim_user_history']['hashSecret']='y'*64
        with self.assertRaisesRegex(RuntimeError,'HASH_CHANGED'):m.disabled_runtime(config,raw)

    def test_duplicate_existing_auth_refused(self):
        config,raw=inputs()
        with self.assertRaisesRegex(RuntimeError,'DUPLICATE'):m.disabled_runtime(config,raw+b'AI_ROUTER_COP_TOKEN=synthetic\n')

    def test_live_publisher_refused(self):
        config,raw=inputs()
        with self.assertRaisesRegex(RuntimeError,'RUNTIME_MODE'):m.disabled_runtime(config,raw.replace(b'DRY_RUN',b'LIVE'))

    def test_owned_file_atomic_and_custody(self):
        with tempfile.TemporaryDirectory(prefix='sim-common-test-', dir='/private/tmp') as root:
            p=Path(root)/'.env';p.write_bytes(b'old');p.chmod(0o600)
            a=types.SimpleNamespace(assert_current=lambda:None)
            m.replace_file(p,b'new',os.getuid(),os.getgid(),0o600,a,b'old')
            self.assertEqual(p.read_bytes(),b'new');self.assertEqual(p.stat().st_mode&0o777,0o600)
            with self.assertRaisesRegex(RuntimeError,'OUTPUT_CHANGED'):m.replace_file(p,b'bad',os.getuid(),os.getgid(),0o600,a,b'old')
            self.assertEqual(p.read_bytes(),b'new')

    def test_lost_admission_before_rename(self):
        with tempfile.TemporaryDirectory(prefix='sim-common-test-', dir='/private/tmp') as root:
            p=Path(root)/'.env';p.write_bytes(b'old');p.chmod(0o600);calls=[]
            def current():
                calls.append(1)
                if len(calls)>1:raise RuntimeError('TEST_LEASE_LOST')
            with self.assertRaisesRegex(RuntimeError,'LEASE_LOST'):m.replace_file(p,b'bad',os.getuid(),os.getgid(),0o600,types.SimpleNamespace(assert_current=current),b'old')
            self.assertEqual(p.read_bytes(),b'old');self.assertEqual(list(Path(root).iterdir()),[p])

class Orchestration(unittest.TestCase):
    def exercise(self,deny,preflight_deny=False):
        calls=[];epoch=str(uuid.uuid4());proof={'reportSha256':'a'*64}
        plan={'resetEpoch':epoch,'tokensNotBefore':123,'sources':{'cop':{'root':str(m.COP_ROOT),'files':{}},'sim':{'root':'/synthetic/sim','files':{}}},'candidateImages':{}}
        raw=json.dumps(plan).encode()
        class Remote:
            def open(self):calls.append('remote-open')
            def close(self):calls.append('remote-close')
        class Admission:
            pre_stop_acceptance=proof
            def assert_current(self):pass
        class Root:
            @classmethod
            @contextlib.contextmanager
            def freeze_reviewed(cls,*args):
                calls.append('freeze');yield Admission();calls.append('lease-end')
        def gate(images):
            calls.append('whole12-gate')
            if deny:raise RuntimeError('CLEAN_WHOLE_ACCEPTANCE_UNPROVEN')
            return proof
        host=types.SimpleNamespace(validate_plan=lambda p:p,_acceptance_module=lambda:types.SimpleNamespace(verified_pre_stop_acceptance=gate),
             CommunicationResetTransport=Remote,DriverReportProducerCustody=lambda:object(),RootResetAdmission=Root,protected=lambda p:raw)
        controller=types.SimpleNamespace(host=host,run_private_worker=lambda a,c:calls.append(c['phase']) or {'phase':c['phase']})
        @contextlib.contextmanager
        def prepare(plan,config,remote):
            calls.append('remaining-preflight')
            if preflight_deny:raise RuntimeError('CLOSURE_PREFLIGHT_DENIED')
            try:yield
            finally:calls.append('remaining-preflight-close')
        remaining=types.SimpleNamespace(run_remaining_reset=lambda a,c:calls.append('remaining') or {},prepare_remaining_reset=prepare)
        cfg={'resetEpoch':epoch,'tokensNotBefore':123,'simUserInstall':{}}
        with patch.object(m.os,'getuid',return_value=0),patch.object(m.socket,'gethostname',return_value='docker'),patch.object(m,'protected',return_value=raw),\
             patch.object(m,'load_sealed',side_effect=[controller,remaining]),patch.object(m,'load_sealed_sim',return_value=types.SimpleNamespace(run_messaging_install_phase=lambda h,a,c:calls.append('messaging_install') or {})),patch.object(m,'read_environment',return_value=(b'',None)),\
             patch.object(m,'disabled_runtime'),patch.object(m,'deploy_guard_input'),patch.object(m,'stage_sim_configuration',return_value={'enabled':False}):
            if deny:
                with self.assertRaisesRegex(RuntimeError,'UNPROVEN'):m.run_common_reset(cfg)
            elif preflight_deny:
                with self.assertRaisesRegex(RuntimeError,'PREFLIGHT_DENIED'):m.run_common_reset(cfg)
            else:
                result=m.run_common_reset(cfg);self.assertFalse(result['servicesRestarted']);self.assertFalse(result['wholeAccountComplete'])
        return calls

    def test_actual_gate_call_precedes_any_freeze_or_remote_auth(self):
        self.assertEqual(self.exercise(True),['whole12-gate'])

    def test_finite_sequence_and_no_automatic_start(self):
        calls=self.exercise(False)
        self.assertEqual(calls[:4],['whole12-gate','remote-open','remaining-preflight','freeze'])
        self.assertEqual(calls[4:12],list(m.COMMON_PHASES))
        self.assertEqual(calls[12:],['remaining','messaging_install','readback','lease-end','remaining-preflight-close','remote-close'])

    def test_closure_preflight_failure_never_freezes(self):
        self.assertEqual(self.exercise(False,True),['whole12-gate','remote-open','remaining-preflight','remote-close'])

if __name__=='__main__':unittest.main()
