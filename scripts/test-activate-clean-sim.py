"""Isolated CAS/orchestration only. No actual Root/deployment success claim."""
import copy,importlib.util,json,os,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('activation',Path(__file__).with_name('activate-clean-sim.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def container(service,new=False):
    index=list(m.SERVICES).index(service)+1
    c={'Id':('new-' if new else 'old-')+service,'Image':'sha256:'+str(index if new else index+4)*64,
       'Config':{'Labels':{'com.docker.compose.project':'sim','com.docker.compose.service':service,'com.docker.compose.project.working_dir':'/srv/sim','com.docker.compose.project.config_files':'/srv/sim/docker-compose.yml,/srv/sim/docker-compose.x5.yml'},'Env':['DRIVER_MEASUREMENTS_ENABLED=true']},
       'HostConfig':{},'Mounts':[],'NetworkSettings':{'Networks':{'sim_default':{}}},'State':{'Running':new,'Restarting':False}}
    if new and service in {'sim-api','ai-router-api'}:c['Mounts'].append({'Destination':'/etc/csm-sim/postgresql-ca.pem','Source':'/etc/vcode-cop-pgbouncer/postgres-ca.crt','Type':'bind','RW':False})
    return c
def value():
    v=m.SimActivation.__new__(m.SimActivation);v.fd=None;v.new={};v.started=False;v.staged=True;v.ready=None
    v.before={s:container(s) for s in m.SERVICES};v.plan={'resetEpoch':'synthetic','candidateImages':{key:container(s,True)['Image']for s,(_,key)in m.SERVICES.items()}}
    v.assert_current=lambda:None;v.compose_args=lambda service:['/usr/bin/docker','compose'];return v
class Boundaries(unittest.TestCase):
    def test_twelve_phase_receipt_requires_message_install_and_exact_order(self):
        phases=list(m.common.COMMON_PHASES)+['remaining','messaging_install','readback','sim_config']
        cfg={'contractVersion':'sim-clean-runtime-config-staged-v1','intakeEnabled':False,'baseCleanEnabled':False,'servicesStarted':False}
        r={'contractVersion':'cop-sim-common-reset-fenced-v1','resetEpoch':'synthetic','servicesRestarted':False,'runtimeFlagsEnabled':False,'wholeAccountComplete':False,'completedPhases':phases,'simConfiguration':cfg}
        self.assertEqual(m.receipt_config(r,{'resetEpoch':'synthetic'}),cfg)
        for bad in [phases[:-1], [p for p in phases if p!='messaging_install'], phases+['readback'],list(reversed(phases))]:
            with self.assertRaisesRegex(RuntimeError,'RESET_INCOMPLETE'):m.receipt_config({**r,'completedPhases':bad},{'resetEpoch':'synthetic'})
    def test_preserve_full_actual_compose_chain(self):
        files=m.chain_from({s:container(s)for s in m.SERVICES})
        self.assertEqual(files['sim-api'],[Path('/srv/sim/docker-compose.yml'),Path('/srv/sim/docker-compose.x5.yml'),m.common.OVERLAY])
    def test_separate_actual_service_chains_are_preserved(self):
        c={s:container(s)for s in m.SERVICES};c['sim-api']['Config']['Labels']['com.docker.compose.project.config_files']='/srv/sim/other.yml'
        files=m.chain_from(c);self.assertEqual(files['sim-api'],[Path('/srv/sim/other.yml'),m.common.OVERLAY]);self.assertEqual(files['ai-router-api'][0],Path('/srv/sim/docker-compose.yml'))
    def test_other_project_or_extra_env_file_refused(self):
        for key,val in [('com.docker.compose.project','foreign'),('com.docker.compose.project.environment_file','/tmp/other.env')]:
            c={s:container(s)for s in m.SERVICES};c['sim-api']['Config']['Labels'][key]=val
            with self.assertRaises(RuntimeError):m.chain_from(c)
    def test_arbitrary_external_compose_path_refused(self):
        with self.assertRaisesRegex(RuntimeError,'COMPOSE_PATH'):m.owned_file(Path('/private/tmp/unreviewed.yml'))
    def test_no_old_fenced_receipt_without_config_hashes(self):
        with self.assertRaises(RuntimeError):m.receipt_config({'contractVersion':'old'},{'resetEpoch':'x'})
    def test_owned_stage_only_five_flags(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp',prefix='sim-activate-test-')as d:
            path=Path(d)/'.env';raw=('\n'.join(k+'=false'for k in sorted(m.FLAGS))+'\nAI_ROUTER_ACCOUNT_ERASURE_ENABLED=false\nDRIVER_ACCOUNT_ERASURE_ENABLED=false\nDRIVER_MEASUREMENTS_ENABLED=true\n').encode();path.write_bytes(raw);path.chmod(0o600)
            v=value();v.env_raw=raw;v.offline=True
            def current():self.assertEqual(path.read_bytes(),v.env_raw)
            v.assert_current=current
            with patch.object(m.common,'SIM_ENV',path),patch.object(m.common,'read_environment',side_effect=lambda:(path.read_bytes(),path.stat())):v.stage_composition()
            after=m.common.selected_values(path.read_bytes(),m.FLAGS|{'DRIVER_MEASUREMENTS_ENABLED'})
            self.assertTrue(all(after[k]=='true'for k in m.FLAGS));self.assertEqual(after['DRIVER_MEASUREMENTS_ENABLED'],'true');self.assertEqual(path.stat().st_mode&0o777,0o600)
    def test_stage_refuses_missing_sql_readback(self):
        v=value();v.offline=False
        with self.assertRaisesRegex(RuntimeError,'SQL_NOT_CHECKED'):v.stage_composition()
    def test_stage_custody_loss_prevents_write(self):
        v=value();v.offline=True;v.assert_current=lambda:(_ for _ in ()).throw(RuntimeError('TEST_CAS_CHANGED'))
        with patch.object(m.common,'replace_file')as replace:
            with self.assertRaisesRegex(RuntimeError,'CAS_CHANGED'):v.stage_composition()
            replace.assert_not_called()
    def test_partial_up_claims_only_matching_new_images(self):
        v=value();current={s:container(s,True)if i<2 else container(s)for i,s in enumerate(m.SERVICES)}
        effective={s:{'image':container(s,True)['Image'],'environment':{'DRIVER_MEASUREMENTS_ENABLED':'true'}}for s in m.SERVICES}
        def lookup(name):return next(c for s,c in current.items()if name==m.SERVICES[s][0])
        with patch.object(m,'run',return_value=json.dumps({'services':effective}).encode()),patch.object(m,'inspect',side_effect=lookup),patch.object(m.subprocess,'run',return_value=types.SimpleNamespace(returncode=1))as up:
            with self.assertRaisesRegex(RuntimeError,'UP_FAILED'):v.up_services()
            self.assertEqual(set(v.new),{'ai-router-api'});self.assertEqual(up.call_count,1);self.assertIn('--no-deps',up.call_args.args[0]);self.assertIn('--no-build',up.call_args.args[0])
    def test_feature_change_blocks_before_up(self):
        v=value();effective={s:{'image':container(s,True)['Image'],'environment':{'DRIVER_MEASUREMENTS_ENABLED':'false'}}for s in m.SERVICES}
        with patch.object(m,'run',return_value=json.dumps({'services':effective}).encode()),patch.object(m.subprocess,'run')as up:
            with self.assertRaisesRegex(RuntimeError,'FEATURE_CHANGED'):v.up_services()
            up.assert_not_called()
    def test_timeout_still_records_only_exact_new_candidates_for_cleanup(self):
        v=value();current={s:container(s,True)for s in m.SERVICES}
        effective={s:{'image':container(s,True)['Image'],'environment':{'DRIVER_MEASUREMENTS_ENABLED':'true'}}for s in m.SERVICES}
        def lookup(name):return next(c for s,c in current.items()if name==m.SERVICES[s][0])
        with patch.object(m,'run',return_value=json.dumps({'services':effective}).encode()),patch.object(m,'inspect',side_effect=lookup),patch.object(m.subprocess,'run',side_effect=m.subprocess.TimeoutExpired('synthetic',1)):
            with self.assertRaisesRegex(RuntimeError,'UP_FAILED'):v.up_services()
            self.assertEqual(set(v.new),{'ai-router-api'})
    def test_omitted_existing_feature_blocks_before_any_up(self):
        v=value();effective={s:{'image':container(s,True)['Image'],'environment':{}}for s in m.SERVICES}
        with patch.object(m,'run',return_value=json.dumps({'services':effective}).encode()),patch.object(m.subprocess,'run')as up:
            with self.assertRaisesRegex(RuntimeError,'FEATURE_CHANGED'):v.up_services()
            up.assert_not_called()
    def test_cas_loss_after_first_up_prevents_remaining_up_and_keeps_owned_cid(self):
        v=value();changed=[False];calls=[]
        effective={s:{'image':container(s,True)['Image'],'environment':{'DRIVER_MEASUREMENTS_ENABLED':'true'}}for s in m.SERVICES}
        def custody():
            if changed[0]:raise RuntimeError('SYNTHETIC_CAS_LOST')
        def start(*args,**kwargs):calls.append(args[0]);changed[0]=True;return types.SimpleNamespace(returncode=0)
        v.assert_current=custody
        with patch.object(m,'run',return_value=json.dumps({'services':effective}).encode()),patch.object(m,'inspect',return_value=container('ai-router-api',True)),patch.object(m.subprocess,'run',side_effect=start):
            with self.assertRaisesRegex(RuntimeError,'CAS_LOST'):v.up_services()
            self.assertEqual(len(calls),1);self.assertEqual(set(v.new),{'ai-router-api'})
    def test_every_next_up_observes_previously_claimed_cids(self):
        v=value();called=[];checked=[]
        effective={s:{'image':container(s,True)['Image'],'environment':{'DRIVER_MEASUREMENTS_ENABLED':'true'}}for s in m.SERVICES}
        def custody():checked.append(set(v.new));self.assertEqual(set(v.new),set(called))
        def start(args,**kwargs):
            self.assertEqual(checked[-1],set(called));called.append(args[-1]);return types.SimpleNamespace(returncode=0)
        def lookup(name):return next(container(s,True)for s,(n,_)in m.SERVICES.items()if n==name)
        v.assert_current=custody
        with patch.object(m,'run',return_value=json.dumps({'services':effective}).encode()),patch.object(m,'inspect',side_effect=lookup),patch.object(m.subprocess,'run',side_effect=start):v.up_services()
        self.assertEqual(called,['ai-router-api','situation-data-api','sim-api','sim-web']);self.assertEqual(set(v.new),set(m.SERVICES))
    def test_cleanup_does_not_stop_replaced_cid_and_continues_own(self):
        v=value();v.new={s:container(s,True)for s in list(m.SERVICES)[:2]};changed=copy.deepcopy(next(iter(v.new.values())));changed['Image']='foreign';owned=list(v.new.values())[1]
        with patch.object(m,'inspect',side_effect=[changed,owned]),patch.object(m,'run')as stop:
            with self.assertRaisesRegex(RuntimeError,'CLEANUP_CID_CHANGED'):v.close(failed=True)
            self.assertEqual(stop.call_count,1);self.assertEqual(stop.call_args.args[0][-1],owned['Id'])
    def test_network_change_changes_cas_spec(self):
        a=container('sim-api',True);b=copy.deepcopy(a);b['NetworkSettings']['Networks']['foreign']={}
        self.assertNotEqual(m.spec(a),m.spec(b))
    def test_no_global_enable_or_canary_success_receipt(self):
        v=value();v.env_raw=b'private-synthetic';v.proof={'reportSha256':'a'*64};v.file_raw={str(m.common.OVERLAY):b'{}'};v.ready={'ready':True};v.new={s:container(s,True)for s in m.SERVICES}
        result=v.receipt();self.assertFalse(result['globalCopFlagsChanged']);self.assertFalse(result['wholeAccountComplete']);self.assertEqual(result['stage'],'guard-ready-awaiting-cop-canary')
if __name__=='__main__':unittest.main()
