import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('build',Path(__file__).with_name('build-sim-pg-maintenance-oci.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class BuildOnlyTests(unittest.TestCase):
 def test_nonroot_operation_cannot_issue_commands(self):
  with patch.object(m.os,'geteuid',return_value=1000),patch.object(m,'run') as run,self.assertRaises(m.Stop):m.main()
  run.assert_not_called()
 def test_exact_direct_argv_has_no_create_bootstrap_remote_cache_or_credentials(self):
  args=m.build_argv('a'*64,'/var/lib/buildkit/sim-pg-maintenance-'+'b'*32,'sha256:'+'c'*64,'csm-sim-pg-observer:root-'+'b'*32)
  self.assertEqual(args[:3],m.DOCKER);self.assertIn('exec',args);self.assertIn('/usr/bin/buildctl',args)
  self.assertIn('/usr/bin/timeout',args);self.assertEqual(args[args.index('/usr/bin/timeout')+1:args.index('/usr/bin/buildctl')],['-k','15','-s','TERM','300'])
  self.assertIn('simbase=/var/lib/buildkit/sim-pg-maintenance-'+'b'*32+'/base-oci',args)
  self.assertIn('context:sim_reviewed_base=oci-layout://simbase@sha256:'+'c'*64,args)
  self.assertIn('--source-policy-file',args)
  for forbidden in ['buildx','--bootstrap','create','start','--secret','--ssh','--import-cache','--export-cache','--allow','--frontend-opt']:
   self.assertNotIn(forbidden,args)
  self.assertTrue(any(x.startswith('DOCKER_CONFIG=/var/lib/buildkit/') and x.endswith('/empty-config') for x in args))
  for inside in ['/tmp/other','/var/lib/buildkit/sim-pg-maintenance-../escape']:
   with self.assertRaises(m.Stop):m.build_argv('a'*64,inside,'sha256:'+'c'*64,'csm-sim-pg-observer:root-'+'b'*32)
 def test_per_solve_policy_denies_all_remote_source_schemes(self):
  policy=m.source_policy();self.assertEqual(policy['version'],1)
  self.assertEqual({r['selector']['identifier'] for r in policy['rules']},{'docker-image://*','http://*','https://*','git://*'})
  self.assertTrue(all(r['action']==1 and r['selector']['match_type']==0 for r in policy['rules']))
 def test_primary_history_shape_is_fail_closed_for_missing_completion(self):
  finished={'record':{'Ref':'synthetic','CreatedAt':{'seconds':99,'nanos':0},'CompletedAt':{'seconds':100,'nanos':0}},'type':1}
  self.assertTrue(m.histories_idle((json.dumps(finished)+'\n').encode()))
  self.assertTrue(m.histories_idle(b''))
  for row in [{'Record':finished['record']},{'record':{}},{'record':{'CompletedAt':None}},{'record':{'CompletedAt':{'seconds':0}}},{'record':{'CompletedAt':{'seconds':'100'}}}]:
   with self.subTest(row=row),self.assertRaises(m.Stop):m.histories_idle(json.dumps(row).encode())
 def test_expired_owner_and_build_go_are_rejected(self):
  go={'createdAt':100,'expiresAt':200,'capacityReviewedAt':100,'buildIdleReviewedAt':100}
  with patch.object(m.time,'time',return_value=120):m.age(go)
  for now in [99,161,200]:
   with self.subTest(now=now),patch.object(m.time,'time',return_value=now),self.assertRaises(m.Stop):m.age(go)
 def test_missing_worker_never_bootstraps_or_creates_it(self):
  with patch.object(m,'inspect',side_effect=m.Stop('missing')),patch.object(m,'run') as run,self.assertRaises(m.Stop):m.worker({'workerCid':'a'*64})
  run.assert_not_called()
 def test_actual_context_bytes_and_extra_mutation_rejected(self):
  spec=importlib.util.spec_from_file_location('bundle',Path(__file__).with_name('prepare-sim-pg-maintenance-bundle.py'));b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
  # Do not make execution receipts depend on validating themselves. Test the
  # actual four context bytes independently of host-source/evidence packaging.
  entries={target:(b.REPO/relative).read_bytes() for target,(relative,_) in b.PINNED.items() if target.startswith('build/')}
  entries['build/Dockerfile']=(b.REPO/b.OCI_DOCKERFILE[0]).read_bytes()
  raw=b.build_context(entries);files=m.context_files(raw);self.assertEqual(set(files),set(m.FILES))
  with self.assertRaises(m.Stop):m.context_files(raw+b'extra')
  changed=bytearray(raw);changed[1024]^=1
  with self.assertRaises(m.Stop):m.context_files(bytes(changed))
 def test_app_generation_ignores_only_transient_health_log_not_config(self):
  state={'Id':'a','Image':m.BASE,'RestartCount':1,'Config':{},'HostConfig':{},'Mounts':[],'State':{'Running':True,'StartedAt':'fixed','Pid':10,'Health':{'Status':'healthy','Log':['first']}}}
  with patch.object(m,'inspect',return_value=state):first=m.app_identity()
  changed=copy.deepcopy(state);changed['State']['Health']['Log']=['later']
  with patch.object(m,'inspect',return_value=changed):self.assertEqual(first,m.app_identity())
  changed['RestartCount']=2
  with patch.object(m,'inspect',return_value=changed):self.assertNotEqual(first,m.app_identity())
 def test_local_pipeline_streams_and_never_claims_remote_cancel(self):
  fake_docker=[sys.executable,'-c','import sys; sys.stdin.buffer.read()']
  with patch.object(m,'DOCKER',fake_docker),patch.object(m,'capacity'):
   count=m.pipeline([sys.executable,'-c','import sys; sys.stdout.buffer.write(b"x"*200000)'])
  self.assertEqual(count,200000);self.assertFalse(m.REMOTE_UNKNOWN)
  with patch.object(m,'DOCKER',fake_docker),patch.object(m,'capacity'),patch.object(m,'PIPELINE_TIMEOUT',.1),self.assertRaisesRegex(m.Stop,'REMOTE_UNKNOWN'):
   m.pipeline([sys.executable,'-c','import time; time.sleep(30)'])
  self.assertTrue(m.REMOTE_UNKNOWN)
 def test_oversized_command_stdout_is_bounded(self):
  with self.assertRaisesRegex(m.Stop,'BYTE_LIMIT'):m.run([sys.executable,'-c','print("x"*100000)'],limit=1000)
 def test_build_source_contains_no_application_or_builder_mutation_operations(self):
  source=Path(m.__file__).read_text()
  for forbidden in ["'--bootstrap'","'prune'","'update'","'restart'","'volume','create'","'compose','up'","'pull'","'start'"]:
   self.assertNotIn(forbidden,source)
if __name__=='__main__':unittest.main()
