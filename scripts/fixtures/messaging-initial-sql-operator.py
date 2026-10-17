"""Real isolated SQL/provider acceptance; no production Root impersonation."""
import base64,hashlib,hmac,importlib.util,json,os,secrets,subprocess,sys,time,uuid
from pathlib import Path
import psycopg2,yaml,urllib.request
D=Path('/dev/shm/initial-sql-private');COP=Path('/cop-source');MESSAGE=Path('/message-source')
def load(path,name):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def db(name,user='postgres'):
 return psycopg2.connect(host='127.0.0.1',port=5432,dbname=name,user=user,connect_timeout=5)
def save(v):
 p=D/'private.json';p.write_text(json.dumps(v));p.chmod(0o600)
def request(path,body=None):
 r=urllib.request.Request('http://127.0.0.1:8008'+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(r,timeout=5) as x:return json.load(x)
def prepare():
 os.umask(0o077);D.mkdir(mode=0o700)
 c=db('postgres');c.autocommit=True;q=c.cursor()
 q.execute("SELECT current_setting('cluster_name')");assert q.fetchone()==('sim_messaging_initial_acceptance_20261017',)
 for role in ['csm_synapse','csm_messaging']:q.execute('CREATE ROLE '+role+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
 for name,owner in [('csm_synapse','csm_synapse'),('csm_messaging','csm_messaging'),('cop_account_safety_guard','postgres')]:q.execute('CREATE DATABASE '+name+' OWNER '+owner+" ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0")
 c.close()
 config=D/'native-config';config.mkdir(mode=0o700)
 subprocess.run([sys.executable,'-m','synapse.app.homeserver','--generate-config','--server-name','docker.home.cz','--config-path',str(config/'homeserver.yaml'),'--data-directory',str(config),'--report-stats','no'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
 y=yaml.safe_load((config/'homeserver.yaml').read_text());reg=secrets.token_urlsafe(48)
 y.update(server_name='docker.home.cz',pid_file='/data/homeserver.pid',public_baseurl='http://127.0.0.1:8008',report_stats=False,
  signing_key_path='/data/docker.home.cz.signing.key',log_config='/data/log.config',registration_shared_secret=reg,
  enable_registration=True,enable_registration_without_verification=True,federation_domain_whitelist=[],
  listeners=[{'port':8008,'type':'http','tls':False,'bind_addresses':['127.0.0.1'],'resources':[{'names':['client','federation'],'compress':False}]}],
  database={'name':'psycopg2','args':{'host':'127.0.0.1','port':5432,'user':'csm_synapse','password':'synthetic-local-trust-only','database':'csm_synapse','cp_min':1,'cp_max':3}})
 (config/'homeserver.yaml').write_text(yaml.safe_dump(y))
 log={'version':1,'handlers':{'console':{'class':'logging.StreamHandler','stream':'ext://sys.stdout'}},'root':{'level':'WARN','handlers':['console']}}
 (config/'log.config').write_text(yaml.safe_dump(log))
 save({'registrationSecret':reg,'rootBase64':base64.b64encode(secrets.token_bytes(32)).decode()})
 print(json.dumps({'stage':'fresh_synthetic_pg_and_config_prepared'}),flush=True)
def register():
 v=json.loads((D/'private.json').read_bytes())
 for i in range(90):
  try:request('/_synapse/admin/v1/register');break
  except Exception:
   if i==89:raise
   time.sleep(1)
 actors={}
 for username,admin in [('synthetic_admin',True),('cop_cop.ai.agent_a83479e9281a',False)]:
  nonce=request('/_synapse/admin/v1/register')['nonce'];password=secrets.token_urlsafe(32)
  mac=hmac.new(v['registrationSecret'].encode(),(nonce+'\0'+username+'\0'+password+'\0'+('admin' if admin else 'notadmin')).encode(),hashlib.sha1).hexdigest()
  x=request('/_synapse/admin/v1/register',{'nonce':nonce,'username':username,'password':password,'admin':admin,'mac':mac})
  assert x['user_id']=='@'+username+':docker.home.cz';actors[username]=x
 v['actors']=actors;save(v)
 c=db('csm_messaging','csm_messaging');q=c.cursor();q.execute('CREATE TABLE public.csm_messaging_stores(store_name text PRIMARY KEY,payload jsonb NOT NULL)')
 bot={'csmUserId':'cop.ai.agent','matrixUserId':actors['cop_cop.ai.agent_a83479e9281a']['user_id'],'serverName':'docker.home.cz'}
 q.execute('INSERT INTO csm_messaging_stores VALUES(%s,%s::jsonb)',('matrix_identities',json.dumps({'version':1,'identities':{'cop.ai.agent':bot}})));c.commit();c.close()
 # Reproduce ONLY the actually inventoried legacy starting schema.
 c=db('csm_synapse');c.autocommit=True;q=c.cursor();q.execute('SET ROLE csm_synapse');q.execute("SELECT set_config('cop_private_erasure.local_server','docker.home.cz',false)")
 q.execute((MESSAGE/'deploy/synapse/001_private_metadata_fences.sql').read_text());c.close()
 print(json.dumps({'stage':'actual_http_admin_and_fixed_bot_registered','metadataContainsOnlyActualFixedBot':True}),flush=True)
class IsolatedPausedCustody:
 def __init__(self,writer):self.writer=writer;self.checks=0
 def assert_current(self):
  nonce=secrets.token_hex(16);self.checks+=1
  print(json.dumps({'kind':'verify-isolated-paused-writer','nonce':nonce}),flush=True)
  x=json.loads(sys.stdin.readline());assert x=={'nonce':nonce,'verifiedWriterDigest':self.writer}
def install():
 packet=json.loads(sys.stdin.readline());writer=packet['writerInventorySha256']
 custody=IsolatedPausedCustody(writer);custody.assert_current()
 v=json.loads((D/'private.json').read_bytes())
 installer=load(COP/'scripts/account-safety/clean-messaging-install.py','actual_initial_schema')
 usage=load(MESSAGE/'deploy/account-safety/communication_usage_enrollment.py','actual_initial_usage')
 pins={name:hashlib.sha256((MESSAGE/name).read_bytes()).hexdigest() for name in installer.REQUIRED}
 issuer='https://login.zeleznalady.cz/realms/cop';clients=['cop-web','csm-mobile'];key=base64.b64decode(v['rootBase64'])
 owner=hmac.digest(key,b'messaging-erasure-owner-mac-key-v1\0','sha256')
 binding={k:str(uuid.uuid4()) for k in ['guardStoreId','metadataStoreId','metadataIncarnationId','providerStoreId','providerIncarnationId']}
 binding.update(metadataRestoreGeneration=1,providerRestoreGeneration=1,providerOrigin='https://synthetic-provider.invalid',serverName='docker.home.cz',issuer=issuer,clientIds=clients,
  ownerKeyFingerprint=hashlib.sha256(b'messaging-erasure-owner-key-fingerprint-v1\0'+owner).hexdigest(),
  identityBindingDigest=hashlib.sha256(json.dumps([issuer,clients],separators=(',',':')).encode()).hexdigest(),retentionPolicyDigest=installer.POLICY,providerScopeDigest=installer.SCOPE)
 config={'contractVersion':'cop-messaging-production-initial-v1','binding':binding,'baselineId':str(uuid.uuid4()),'guardRuntimeRole':'csm_messaging','sourcePins':pins,'writerInventorySha256':writer,'reviewedRetention':True}
 cs={lane:db(name) for lane,name in [('guard','cop_account_safety_guard'),('metadata','csm_messaging'),('native','csm_synapse')]}
 p=None
 try:
  reviewed=installer.inspect_initial(cs,MESSAGE,config)
  result=installer.install_initial_schema_and_bindings(cs,MESSAGE,config,reviewed,v['rootBase64'],custody)
  assert result['schemaAndBindingInstalled'] and 'baselineDigest' not in result
  plan={'contractVersion':'cop-messaging-usage-enrollment-plan-v1','mode':'initial','baselineId':config['baselineId'],'binding':{k:binding[k] for k in usage.BINDING_FIELDS},'sourcePins':pins,'writerInventorySha256':writer,'lineage':[],'guardRuntimeRole':'csm_messaging'}
  p=usage.PreparedEnrollment([cs[k] for k in ['guard','metadata','native']],MESSAGE,plan,v['rootBase64'])
  assert p.summary['knownOwners']==0 and p.summary['unresolved']==0;custody.assert_current()
  baseline=p.commit({'contractVersion':'cop-messaging-usage-commit-v1','nonce':p.nonce,'planSha256':p.summary['planSha256'],'writerInventorySha256':writer})
  custody.assert_current();assert baseline['committed'] and baseline['knownOwners']==0
  p.close();p=None
  c=db('cop_account_safety_guard','csm_messaging');q=c.cursor()
  q.execute("SELECT current_user,(SELECT count(*) FROM messaging_usage_v1.baselines),(SELECT count(*) FROM messaging_usage_v1.owners),(SELECT count(*) FROM messaging_usage_v1.service_admissions)")
  assert q.fetchone()==('csm_messaging',1,0,1);c.rollback()
  denied=0
  for sql in ['CREATE TABLE messaging_usage_v1.synthetic_forbidden(x int)','DELETE FROM messaging_safety_v2.journal','UPDATE messaging_safety_v2.configuration SET initial_digest=initial_digest']:
   try:q.execute(sql);raise AssertionError('RUNTIME_OVERPRIVILEGED')
   except psycopg2.Error as e:assert e.pgcode=='42501';denied+=1;c.rollback()
  c.close()
  print(json.dumps({'contractVersion':'actual-messaging-initial-sql-acceptance-v1','schemaAndBindingsInstalled':True,'actualPreparedEnrollmentCommitted':True,'knownOwners':0,'fixedServiceAdmissions':1,'restrictedRoleActualReads':True,'deniedRuntimeMutations':denied,'actualIsolatedCustodyChecks':custody.checks,'productionRootAdmissionClaimed':False,'productionTouched':False,'wholeAccountReady':False}),flush=True)
 finally:
  if p:p.close()
  for c in cs.values():c.close()
if __name__=='__main__':
 try:{'--prepare':prepare,'--register':register,'--install':install}[sys.argv[1]]()
 except Exception as e:
  import traceback
  loc=[{'file':Path(x.filename).name,'line':x.lineno} for x in traceback.extract_tb(e.__traceback__)]
  print(json.dumps({'error':'ISOLATED_INITIAL_SQL_FAILED','type':type(e).__name__,'sqlstate':getattr(e,'pgcode',None),'locations':loc}),flush=True);sys.exit(1)
