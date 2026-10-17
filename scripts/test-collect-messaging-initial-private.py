"""Synthetic private-input validation; production collector is NEVER invoked."""
import base64,copy,importlib.util,pathlib,unittest
p=pathlib.Path(__file__).parent/'lib/collect-messaging-initial-private.py'
s=importlib.util.spec_from_file_location('collector',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Collector(unittest.TestCase):
 def setUp(self):
  self.e={'DATABASE_URL':'ecto://synthetic-only','CSM_MESSAGING_SECRET_ENCRYPTION_KEY_BASE64':base64.b64encode(b'x'*32).decode(),'CSM_MATRIX_ADMIN_TOKEN':'synthetic-private-token-32-characters','CSM_MATRIX_SERVER_NAME':'docker.home.cz','CSM_MATRIX_PUBLIC_BASE_URL':'https://matrix.example.invalid/','CSM_COP_OIDC_ISSUER':'','CSM_COP_OIDC_CLIENT_IDS':''}
  self.p={'privateEnvironment':self.e,'runtimeWitness':{'serverName':'docker.home.cz','backends':{n:{'database':db,'role':role,'address':'192.0.2.1','port':5432,'cluster':'synthetic','inRecovery':False} for n,db,role in [('native','csm_synapse','csm_synapse'),('metadata','csm_messaging','csm_messaging')]}}}
 def run_validate(self):return m.validate_runtime_inputs(self.p,'https://login.zeleznalady.cz/realms/cop')
 def test_valid_blank_preparation(self):
  x=self.run_validate();self.assertTrue(x['previousIssuerBlank']);self.assertEqual(x['providerOrigin'],'https://matrix.example.invalid');self.assertEqual(x['clientIds'],['cop-web','csm-mobile']);self.assertEqual(len(x['ownerKeyFingerprint']),64)
 def test_existing_issuer_preserved(self):
  self.e['CSM_COP_OIDC_ISSUER']='https://login.zeleznalady.cz/realms/cop';self.assertFalse(self.run_validate()['previousIssuerBlank'])
 def test_foreign_issuer_rejected(self):
  self.e['CSM_COP_OIDC_ISSUER']='https://other.invalid';self.assertRaises(RuntimeError,self.run_validate)
 def test_extra_environment_rejected(self):
  self.e['UNRELATED_SECRET']='do-not-collect';self.assertRaises(RuntimeError,self.run_validate)
 def test_invalid_base64(self):
  for v in ['!!',base64.b64encode(b'x'*31).decode(),base64.b64encode(b'x'*33).decode()]:
   self.e['CSM_MESSAGING_SECRET_ENCRYPTION_KEY_BASE64']=v;self.assertRaises(RuntimeError,self.run_validate)
 def test_invalid_origins(self):
  for v in ['http://matrix.invalid','https://a:b@matrix.invalid','https://matrix.invalid/path','https://matrix.invalid?secret=x','https://matrix.invalid#fragment','https://matrix.invalid:bad','https://matrix.invalid\0']:
   self.e['CSM_MATRIX_PUBLIC_BASE_URL']=v;self.assertRaises(RuntimeError,self.run_validate)
 def test_unknown_optional_client_rejected(self):
  self.e['CSM_JIZDA_OIDC_CLIENT_ID']='different-client';self.assertRaises(RuntimeError,self.run_validate)
 def test_duplicate_clients_rejected(self):
  self.e['CSM_COP_OIDC_CLIENT_IDS']='cop-web,csm-mobile,cop-web';self.assertRaises(RuntimeError,self.run_validate)
 def test_server_mismatch_rejected(self):
  self.p['runtimeWitness']['serverName']='foreign';self.assertRaises(RuntimeError,self.run_validate)
 def test_runtime_role_mismatch_rejected(self):
  self.p['runtimeWitness']['backends']['native']['role']='postgres';self.assertRaises(RuntimeError,self.run_validate)
 def test_backend_identity_requires_same_server(self):
  r=self.p['runtimeWitness']['backends']['native'];a={**r,'role':'postgres'};self.assertTrue(m.same_backend(r,a))
  for key,v in [('database','different'),('address','192.0.2.2'),('port',5000),('cluster','other'),('inRecovery',True)]:
   self.assertFalse(m.same_backend(r,{**a,key:v}))
 def test_source_no_mutation_or_print_private(self):
  t=p.read_text()
  for bad in ['ALTER ROLE','CREATE ROLE','DROP TABLE','write_text(','write_bytes(','remote.open(']:self.assertNotIn(bad,t)
  self.assertNotIn('print(json.dumps(selected',t)
if __name__=='__main__':unittest.main()
