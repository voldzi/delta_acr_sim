"""Synthetic composition tests; no production path, subprocess or providers."""
import copy, hashlib, importlib.util, json, pathlib, unittest
p=pathlib.Path(__file__).parent/'lib/prepare-common-remaining.py'
s=importlib.util.spec_from_file_location('prepare',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Prepare(unittest.TestCase):
 def setUp(self):
  self.config={'phase':'inspect','resetEpoch':'synthetic-epoch','tokensNotBefore':123,'reviewedPlans':{k:{'inventoryDigest' if k=='keycloak' else 'planDigest':'a'*64} for k in ['cop','ai','driver','files','keycloak','sim_app_files','sim_user_install']}}
  self.remaining={'contractVersion':'cop-clean-remaining-private-v1','nativeAdminToken':'synthetic-private','reviewedPlans':{'messaging':{'metadata':{},'native':{}},'media':{'nativeMedia':{},'s3':{}},'edge':{}}}
  manifest={'contractVersion':'cop-database-safety-provision-clean-v1','resetEpoch':'synthetic-epoch','tokensNotBefore':123}
  self.raw=(json.dumps(manifest,separators=(',',':'))+'\n').encode()
  self.safety={'manifest':manifest,'plan':{'planDigest':hashlib.sha256(self.raw).hexdigest(),'factsInspected':False,'readinessClaimed':False}}
 def run_join(self):return m.finalize_private_preparation(self.config,self.remaining,self.safety,self.raw,'synthetic-password')
 def test_complete_eleven_not_go(self):
  x=self.run_join();self.assertEqual(len(x['publicSummary']['reviewedPlanDigests']),11);self.assertFalse(x['publicSummary']['freezeAuthorized']);self.assertFalse(x['publicSummary']['productionActivated'])
 def test_private_not_public(self):
  x=self.run_join();self.assertNotIn('synthetic-password',json.dumps(x['publicSummary']));self.assertNotIn('synthetic-private',json.dumps(x['publicSummary']));self.assertEqual(x['privateConfig']['copSafetyInstall']['mode'],'apply')
 def test_preserves_remaining(self):self.assertIs(self.run_join()['privateConfig']['remaining'],self.remaining)
 def test_manifest_bytes_exact(self):
  self.raw+=b' ';self.assertRaises(RuntimeError,self.run_join)
 def test_wrong_epoch(self):
  self.config['resetEpoch']='different';self.assertRaises(RuntimeError,self.run_join)
 def test_wrong_cutoff(self):
  self.config['tokensNotBefore']=124;self.assertRaises(RuntimeError,self.run_join)
 def test_no_unreviewed_phase(self):
  self.config['phase']='apply';self.assertRaises(RuntimeError,self.run_join)
 def test_missing_plan(self):
  del self.config['reviewedPlans']['ai'];self.assertRaises(RuntimeError,self.run_join)
 def test_bad_digest(self):
  self.config['reviewedPlans']['driver']['planDigest']='placeholder';self.assertRaises(RuntimeError,self.run_join)
 def test_no_claimed_db_facts(self):
  self.safety['plan']['factsInspected']=True;self.assertRaises(RuntimeError,self.run_join)
 def test_no_claimed_ready(self):
  self.safety['plan']['readinessClaimed']=True;self.assertRaises(RuntimeError,self.run_join)
 def test_remaining_missing(self):
  del self.remaining['reviewedPlans']['edge'];self.assertRaises(RuntimeError,self.run_join)
 def test_actual_inspector_calls(self):
  calls=[]
  def adapter(n):return lambda:(calls.append(n) or {'actualSyntheticCall':n})
  r=m.collect_remaining_plans(*(adapter(n) for n in ['metadata','native','native_media','s3','edge']))
  self.assertEqual(calls,['metadata','native','native_media','s3','edge']);self.assertEqual(r['edge']['actualSyntheticCall'],'edge')
 def test_failure_propagates_no_result(self):
  def fail():raise RuntimeError('synthetic-provider-down')
  with self.assertRaisesRegex(RuntimeError,'synthetic-provider-down'):m.collect_remaining_plans(fail,fail,fail,fail,fail)
 def test_no_mutation_calls(self):
  text=p.read_text()
  for bad in ['.apply(','.freeze_reviewed(','.open(','.stop(','.rotate(','subprocess.run(','write_bytes(']:self.assertNotIn(bad,text)
 def envelope(self):
  binding={'issuer':'https://login.zeleznalady.cz/realms/cop'}
  config={'baselineId':'synthetic-baseline','binding':binding,'sourcePins':{},'writerInventorySha256':'w','guardRuntimeRole':'csm_messaging'}
  schema={'contractVersion':'cop-messaging-production-initial-plan-v1','configurationDigest':m.digest(config),'facts':{}}
  schema['planDigest']=m.digest(schema)
  return {'contractVersion':'cop-messaging-clean-install-plan-v1','configuration':config,'schemaPlan':schema,'usagePlan':{'contractVersion':'cop-messaging-usage-enrollment-plan-v1','mode':'initial','lineage':[],**config}}
 def test_twelve_join(self):
  x=m.attach_messaging_install_preparation(self.run_join(),self.envelope(),{'guard':{},'metadata':{},'native':{}},'synthetic-private-root')
  self.assertEqual(x['publicSummary']['planCount'],12);self.assertEqual(len(x['publicSummary']['reviewedPlanDigests']),12);self.assertFalse(x['publicSummary']['messagingSchemaOrBaselineApplied']);self.assertNotIn('synthetic-private-root',json.dumps(x['publicSummary']))
 def test_twelve_rejects_schema_digest_tampering(self):
  e=self.envelope();e['schemaPlan']['facts']={'changed':True}
  self.assertRaises(RuntimeError,m.attach_messaging_install_preparation,self.run_join(),e,{'guard':{},'metadata':{},'native':{}},'synthetic-private-root')
 def test_twelve_rejects_config_drift(self):
  e=self.envelope();e['configuration']['baselineId']='different'
  self.assertRaises(RuntimeError,m.attach_messaging_install_preparation,self.run_join(),e,{'guard':{},'metadata':{},'native':{}},'synthetic-private-root')
if __name__=='__main__':unittest.main()
