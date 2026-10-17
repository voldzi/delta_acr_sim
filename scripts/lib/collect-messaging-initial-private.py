"""Read-only production collector. Root/docker private RAM pipe ONLY.
Never invoke through a Mac tool or print its return value. No CLI or mutation.
"""
import base64,hashlib,hmac,importlib.util,json,os,socket,uuid
from pathlib import Path
from urllib.parse import urlsplit
COP_ROOT='/srv/x5-production/staging/cop/clean-operator-shared-v3/app'
KEYS=['DATABASE_URL','CSM_MESSAGING_SECRET_ENCRYPTION_KEY_BASE64','CSM_MATRIX_ADMIN_TOKEN',
      'CSM_MATRIX_SERVER_NAME','CSM_MATRIX_PUBLIC_BASE_URL','CSM_COP_OIDC_ISSUER',
      'CSM_COP_OIDC_CLIENT_IDS','CSM_JIZDA_OIDC_CLIENT_ID']
def need(v):
 if not v:raise RuntimeError('MESSAGING_PRIVATE_COLLECTION_UNPROVEN')
def digest(v):
 return hashlib.sha256(json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
REMOTE_PROGRAM=r"""
import json,subprocess,sys
keys=['DATABASE_URL','CSM_MESSAGING_SECRET_ENCRYPTION_KEY_BASE64','CSM_MATRIX_ADMIN_TOKEN','CSM_MATRIX_SERVER_NAME','CSM_MATRIX_PUBLIC_BASE_URL','CSM_COP_OIDC_ISSUER','CSM_COP_OIDC_CLIENT_IDS','CSM_JIZDA_OIDC_CLIENT_ID']
def need(v):
 if not v:raise RuntimeError('PRIVATE_COMM_COLLECTION_UNPROVEN')
def run(a,b=None):
 p=subprocess.run(a,input=b,capture_output=True,timeout=25);need(p.returncode==0);return p.stdout
expected=json.load(sys.stdin)
def inspect():
 out={}
 for n in ['csm-messaging-api','csm-matrix-synapse']:
  x=json.loads(run(['/usr/bin/docker','inspect',n]))[0];need(x['Id']==expected[n]['id'] and x['Image']==expected[n]['image']);out[n]=x
 return out
before=inspect();env={}
for x in before['csm-messaging-api']['Config']['Env']:
 if '=' not in x:continue
 k,v=x.split('=',1)
 if k in keys:need(k not in env);env[k]=v
need('DATABASE_URL' in env)
code=r'''import json,sys,yaml,psycopg2
from urllib.parse import urlsplit,urlunsplit
p=json.load(sys.stdin);cfg=yaml.safe_load(open('/data/homeserver.yaml'));out={'serverName':cfg['server_name'],'backends':{}}
for name in ['native','metadata']:
 if name=='native':
  a={k:v for k,v in cfg['database']['args'].items() if k in ['host','port','user','password','database','dbname','sslmode','sslrootcert','sslcert','sslkey']}
  c=psycopg2.connect(**a,connect_timeout=5)
 else:
  u=urlsplit(p['url'].replace('ecto://','postgresql://',1));assert u.scheme in ['postgresql','postgres'] and not u.fragment
  c=psycopg2.connect(urlunsplit((u.scheme,u.netloc,u.path,u.query,'')),connect_timeout=5)
 try:
  q=c.cursor();q.execute('BEGIN READ ONLY');q.execute("SET LOCAL statement_timeout='5s'")
  q.execute("SELECT current_database(),current_user,inet_server_addr()::text,inet_server_port(),current_setting('cluster_name'),pg_is_in_recovery()")
  x=q.fetchone();out['backends'][name]=dict(zip(['database','role','address','port','cluster','inRecovery'],x))
 finally:c.rollback();c.close()
print(json.dumps(out))'''
witness=json.loads(run(['/usr/bin/docker','exec','-i',before['csm-matrix-synapse']['Id'],'python','-I','-c',code],json.dumps({'url':env['DATABASE_URL']}).encode()))
after=inspect();again={}
for x in after['csm-messaging-api']['Config']['Env']:
 if '=' in x:
  k,v=x.split('=',1)
  if k in keys:need(k not in again);again[k]=v
need(env==again)
print(json.dumps({'privateEnvironment':env,'runtimeWitness':witness,'writerBindings':expected}))
"""
def validate_runtime_inputs(packet,cop_issuer):
 need(cop_issuer=='https://login.zeleznalady.cz/realms/cop')
 e=packet['privateEnvironment'];need(set(e)<=set(KEYS))
 root=e.get('CSM_MESSAGING_SECRET_ENCRYPTION_KEY_BASE64','')
 try:key=base64.b64decode(root,validate=True)
 except Exception:raise RuntimeError('MESSAGING_PRIVATE_COLLECTION_UNPROVEN') from None
 need(len(key)==32 and base64.b64encode(key).decode()==root)
 token=e.get('CSM_MATRIX_ADMIN_TOKEN','');need(isinstance(token,str) and 20<=len(token)<=16384 and not any(c in token for c in '\0\r\n'))
 issuer=e.get('CSM_COP_OIDC_ISSUER','').strip();need(not issuer or issuer==cop_issuer)
 value=e.get('CSM_MATRIX_PUBLIC_BASE_URL','');u=urlsplit(value)
 need(u.scheme=='https' and u.hostname and not u.username and not u.password and not u.query and not u.fragment and u.path in ['','/'])
 try:port=u.port
 except ValueError:raise RuntimeError('MESSAGING_PRIVATE_COLLECTION_UNPROVEN') from None
 need(port is None or 0<port<=65535)
 need(not any(c.isspace() for c in value) and '\0' not in value and '\\' not in value);origin=u.scheme+'://'+u.netloc
 server=e.get('CSM_MATRIX_SERVER_NAME','');need(server=='docker.home.cz' and packet['runtimeWitness']['serverName']==server)
 clients=[x.strip() for x in e.get('CSM_COP_OIDC_CLIENT_IDS','').split(',') if x.strip()]
 # Blank is preparation for a new disabled branch, never a foreign issuer.
 if not clients:clients=['cop-web','csm-mobile']
 need(len(clients)==len(set(clients)) and set(clients)=={'cop-web','csm-mobile'})
 jizda=e.get('CSM_JIZDA_OIDC_CLIENT_ID','').strip();need(not jizda or jizda in clients)
 for lane,db,role in [('metadata','csm_messaging','csm_messaging'),('native','csm_synapse','csm_synapse')]:
  observed=packet['runtimeWitness']['backends'][lane]
  need(observed['database']==db and observed['role']==role and observed['inRecovery'] is False)
 owner=hmac.digest(key,b'messaging-erasure-owner-mac-key-v1\0','sha256')
 return {'rootBase64':root,'nativeAdminToken':token,'providerOrigin':origin,'serverName':server,
         'issuer':cop_issuer,'clientIds':sorted(clients),
         'ownerKeyFingerprint':hashlib.sha256(b'messaging-erasure-owner-key-fingerprint-v1\0'+owner).hexdigest(),
         'previousIssuerBlank':not issuer}
def same_backend(runtime,admin):
 return all(runtime[k]==admin[k] for k in ['database','address','port','cluster','inRecovery']) and admin['inRecovery'] is False and admin['role']=='postgres'
def cop_issuer_from_file():
 fd=os.open('/srv/cop/.env',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);need(s.st_uid in [0,1000] and s.st_nlink==1 and s.st_mode&0o777==0o600 and s.st_size<=1048576)
  b=os.read(fd,1048577);t=os.fstat(fd);need(len(b)==s.st_size and (s.st_ino,s.st_mtime_ns,s.st_ctime_ns)==(t.st_ino,t.st_mtime_ns,t.st_ctime_ns))
  values=[]
  for line in b.decode().splitlines():
   if line.startswith('COP_OIDC_ISSUER='):values.append(line.split('=',1)[1].strip().strip('"').strip("'"))
  need(len(values)==1);return values[0]
 finally:os.close(fd)
def sealed_module(source,relative,name):
 p=Path(source['root'])/relative
 need(p.resolve()==p and p.stat().st_uid==0 and not p.stat().st_mode&0o222
      and hashlib.sha256(p.read_bytes()).hexdigest()==source['files'][relative])
 s=importlib.util.spec_from_file_location(name,p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def collect_messaging_initial_private(remote,postgres_password,root_plan):
 need(os.getuid()==0 and socket.gethostname().split('.')[0]=='docker')
 need(root_plan.get('contractVersion')=='cop-sim-clean-reset-root-plan-v1'
      and root_plan.get('scope')=='cop_sim_shared_identity_v1')
 need(type(remote).__name__=='CommunicationResetTransport'
      and Path(type(remote).run.__code__.co_filename).resolve()==Path(COP_ROOT+'/scripts/account-safety/clean-reset-root.py'))
 need(isinstance(postgres_password,str) and postgres_password and '\0' not in postgres_password)
 remote._custody()
 raw=remote.run(['/usr/bin/python3','-I','-c',REMOTE_PROGRAM],
                input=json.dumps(root_plan['remoteWriters']).encode(),timeout=75)
 need(len(raw)<=131072);packet=json.loads(raw);need(packet['writerBindings']==root_plan['remoteWriters'])
 remote._custody()
 selected=validate_runtime_inputs(packet,cop_issuer_from_file())
 installer=sealed_module(root_plan['sources']['cop'],'scripts/account-safety/clean-messaging-install.py','sealed_initial_collector')
 usage=sealed_module(root_plan['sources']['messaging'],'deploy/account-safety/communication_usage_enrollment.py','sealed_usage_collector')
 pins={name:root_plan['sources']['messaging']['files'][name] for name in installer.REQUIRED}
 binding={k:str(uuid.uuid4()) for k in ['guardStoreId','metadataStoreId','metadataIncarnationId','providerStoreId','providerIncarnationId']}
 binding.update(metadataRestoreGeneration=1,providerRestoreGeneration=1,providerOrigin=selected['providerOrigin'],serverName=selected['serverName'],issuer=selected['issuer'],clientIds=selected['clientIds'],ownerKeyFingerprint=selected['ownerKeyFingerprint'],identityBindingDigest=usage.digest([selected['issuer'],selected['clientIds']]),retentionPolicyDigest=installer.POLICY,providerScopeDigest=installer.SCOPE)
 writer=digest({k:root_plan[k] for k in ['localWriters','remoteWriters','producerInventorySha256']})
 config={'contractVersion':'cop-messaging-production-initial-v1','binding':binding,'baselineId':str(uuid.uuid4()),'guardRuntimeRole':'csm_messaging','sourcePins':pins,'writerInventorySha256':writer,'reviewedRetention':True}
 configs={lane:{'host':'haproxy.home.cz','port':5000,'dbname':db,'user':'postgres','password':postgres_password,'sslmode':'verify-full','sslrootcert':'/etc/vcode-cop-pgbouncer/postgres-ca.crt'} for lane,db in [('native','csm_synapse'),('metadata','csm_messaging'),('guard','cop_account_safety_guard')]}
 import psycopg2
 connections={}
 try:
  for lane,c in configs.items():
   connections[lane]=psycopg2.connect(**c,connect_timeout=8,application_name='messaging-readonly-initial-collector')
   q=connections[lane].cursor();q.execute('BEGIN READ ONLY');q.execute("SET LOCAL statement_timeout='5s'")
   q.execute("SELECT current_database(),current_user,inet_server_addr()::text,inet_server_port(),current_setting('cluster_name'),pg_is_in_recovery()")
   x=dict(zip(['database','role','address','port','cluster','inRecovery'],q.fetchone()));connections[lane].rollback()
   observed=packet['runtimeWitness']['backends']['native' if lane=='guard' else lane]
   if lane=='guard':observed={**observed,'database':'cop_account_safety_guard'}
   need(same_backend(observed,x))
  schema=installer.inspect_initial(connections,Path(root_plan['sources']['messaging']['root']),config)
  plan={'contractVersion':'cop-messaging-usage-enrollment-plan-v1','mode':'initial','baselineId':config['baselineId'],'binding':{k:binding[k] for k in usage.BINDING_FIELDS},'sourcePins':pins,'writerInventorySha256':writer,'lineage':[],'guardRuntimeRole':'csm_messaging'}
  usage.validate_plan(plan)
  envelope={'contractVersion':'cop-messaging-clean-install-plan-v1','configuration':config,'schemaPlan':schema,'usagePlan':plan}
  return {'envelope':envelope,'connections':configs,'rootBase64':selected['rootBase64'],
          'nativeAdminToken':selected['nativeAdminToken'],'runtimeBackendWitness':packet['runtimeWitness'],
          'remoteWriterBindings':packet['writerBindings'],'previousIssuerBlank':selected['previousIssuerBlank']}
 finally:
  for c in connections.values():c.close()
