"""Pure negative gates and JS syntax only; does NOT run the owned cutover."""
import copy,hashlib,importlib.util,json,pathlib,subprocess,unittest
path=pathlib.Path(__file__).parent/'fixtures/cutover-whole12-completed-replay.py'
spec=importlib.util.spec_from_file_location('cutover',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def old():return {'Id':m.OLD_ID,'Image':m.OLD_IMAGE,'State':{'Running':True},'HostConfig':{'NetworkMode':'container:'+m.HOLDER,'PortBindings':{}},'Config':{'Labels':{'cop.test.owner':m.OWNER},'User':'1000:1000'}}
class Cutover(unittest.TestCase):
 def test_pins_match_public_source_and_built_bundle_evidence(self):
  root=pathlib.Path(__file__).parent.parent
  for name,digest in m.PINS.items():self.assertEqual(hashlib.sha256((root/name).read_bytes()).hexdigest(),digest)
  evidence=json.loads((root/'docs/archive/2026-10-17_SIM_COMPLETED_REPLAY_IMAGE_PINS.json').read_text())
  self.assertEqual(m.IMAGE,evidence['offlineTestBundle'])
 def test_exact_owned_old(self):m.valid_old(old())
 def test_foreign_id(self):
  c=old();c['Id']='f'*64
  with self.assertRaisesRegex(RuntimeError,'OLD_IDENTITY'):m.valid_old(c)
 def test_foreign_image(self):
  c=old();c['Image']='sha256:'+'f'*64
  with self.assertRaisesRegex(RuntimeError,'OLD_IDENTITY'):m.valid_old(c)
 def test_live_port_or_foreign_network(self):
  for key,value in [('PortBindings',{'4311/tcp':[]} ),('NetworkMode','host')]:
   c=old();c['HostConfig'][key]=value
   with self.assertRaisesRegex(RuntimeError,'NETWORK'):m.valid_old(c)
 def test_foreign_user_or_owner(self):
  for field in ['user','label']:
   c=old()
   if field=='user':c['Config']['User']='0:0'
   else:c['Config']['Labels']['cop.test.owner']='foreign'
   with self.assertRaisesRegex(RuntimeError,'OWNER'):m.valid_old(c)
 def test_invalid_mode_before_any_command(self):
  with self.assertRaisesRegex(RuntimeError,'MODE'):m.main('--apply-production')
 def test_no_credential_or_guard_bypass(self):
  for forbidden in ['ALTER ROLE','DISABLE TRIGGER','session_replication_role','UPDATE sim_erasure_guard','DELETE FROM sim_clean.job']:self.assertNotIn(forbidden,m.SQL)
  self.assertIn('pg_stat_activity',m.SQL);self.assertIn('verifyCompletedReplayCatalog',m.SQL)
 def test_exact_js_process_match_and_syntax(self):
  self.assertIn(r'/^\d+$/',m.STOP);self.assertIn(r"split('\0')",m.STOP)
  node='/Users/voldzi/.local/share/mise/installs/node/24.21.0/bin/node'
  for code in [m.STOP,m.SQL,m.READBACK]:
   r=subprocess.run([node,'--input-type=module','--check'],input=code.encode(),capture_output=True);self.assertEqual(r.returncode,0)
if __name__=='__main__':unittest.main()
