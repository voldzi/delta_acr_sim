import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest
import os
import subprocess
import sys
import time
from types import SimpleNamespace
from contextlib import redirect_stdout
from tempfile import TemporaryDirectory
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('maintain',Path(__file__).with_name('sim-pg-disconnect-maintain.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
LABELS={'com.docker.compose.project.environment_file':'/srv/sim/.env','com.docker.compose.replace':m.NAME,'com.docker.compose.version':'5.6.0'}

class MaintainTests(unittest.TestCase):
 def critical_fixture(self):
  cfg={'Env':['FIXED=value'],'Cmd':['node','entry.js'],'Entrypoint':['docker-entrypoint.sh'],'User':'','WorkingDir':'/app','Hostname':'b'*12,'Labels':copy.deepcopy(LABELS)}
  h={'ShmSize':67108864,'IpcMode':'private','Runtime':'runc','CgroupnsMode':'private','ConsoleSize':[0,0],
   'MaskedPaths':['/proc/acpi','/proc/asound','/proc/interrupts','/proc/kcore','/proc/keys','/proc/latency_stats','/proc/timer_list','/proc/timer_stats','/proc/sched_debug','/proc/scsi','/sys/firmware','/sys/devices/virtual/powercap'],
   'ReadonlyPaths':['/proc/bus','/proc/fs','/proc/irq','/proc/sys','/proc/sysrq-trigger'],
   'LogConfig':{'Type':'json-file','Config':{}},'RestartPolicy':{'Name':'no','MaximumRetryCount':0},'NetworkMode':'sim_default',
   'Binds':['/srv/x5-production/data/sim:/data:rw']}
  c={'Id':'b'*64,'Image':m.BASE,'Config':cfg,'HostConfig':h,'Mounts':[{'Source':'/srv/x5-production/data/sim','Destination':'/data','RW':True,'Type':'bind'}],
   'NetworkSettings':{'Networks':{'sim_default':{'Aliases':[m.NAME,'sim-api']}}}}
  compose={'services':{'sim-api':{'container_name':m.NAME,'image':m.BASE,'environment':{},'volumes':[{'type':'bind','source':'/srv/x5-production/data/sim','target':'/data'}],'networks':{'default':{}}}},'networks':{'default':{'name':'sim_default'}}}
  return compose,c,{'Config':{k:v for k,v in cfg.items() if k not in {'Hostname','Labels'}}}
 def test_full_critical_parity_rejects_latent_privilege_mount_network_resource_and_unknown_fields(self):
  compose,c,image=self.critical_fixture();m.critical_service_gate(compose,c,image)
  for key,value in [('privileged',True),('read_only',True),('mem_limit',123),('cap_add',['SYS_ADMIN']),('ports',['4000:4000']),('sysctls',{}),('unknown',False),('healthcheck',{'test':['NONE']})]:
   bad=copy.deepcopy(compose);bad['services']['sim-api'][key]=value
   with self.subTest(key=key),self.assertRaises(m.Stop):m.critical_service_gate(bad,c,image)
  for mutate in [lambda s:s['volumes'][0].update(source='/other'),lambda s:s['volumes'][0].update(read_only=True),lambda s:s.update(networks={'default':{'aliases':['extra']}})]:
   bad=copy.deepcopy(compose);mutate(bad['services']['sim-api'])
   with self.assertRaises(m.Stop):m.critical_service_gate(bad,c,image)
  for key,value in [('UnknownFutureEscape',False),('Privileged',True),('NetworkMode','host'),('LogConfig',{'Type':'none','Config':{}})]:
   bad=copy.deepcopy(c);bad['HostConfig'][key]=value
   with self.subTest(host=key),self.assertRaises(m.Stop):m.critical_service_gate(compose,bad,image)
 def test_filesystem_identity_and_both_capacity_floors_are_mandatory(self):
  identity={'uuid':m.X5_UUID,'mountId':'20','sourceInode':100}
  p={'dataFilesystem':{**identity,'minimumFreeBytesX5':2147483648}};g={'minimumFreeBytes':2147483648}
  with patch.object(m,'filesystem_identity',return_value=identity),patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=3*2147483648)):
   m.filesystem_gate(p,g,{})
   for key,value in [('uuid','other'),('mountId','21'),('sourceInode',101)]:
    changed={**identity,key:value}
    with self.subTest(key=key),patch.object(m,'filesystem_identity',return_value=changed),self.assertRaises(m.Stop):m.filesystem_gate(p,g,{})
  for path in [m.X5,'/srv/sim']:
   with patch.object(m,'filesystem_identity',return_value=identity),patch.object(m.shutil,'disk_usage',side_effect=lambda x:SimpleNamespace(free=1 if x==path else 3*2147483648)),self.assertRaises(m.Stop):m.filesystem_gate(p,g,{})
 def test_real_mount_identity_rejects_root_fallback_wrong_uuid_missing_mount_and_symlink(self):
  current={'Mounts':[{'Destination':'/data','Type':'bind','Source':m.X5+'/data/sim'}]}
  row='20 1 8:1 / '+m.X5+' rw - ext4 /dev/sdb1 rw\n'
  def stat_result(path):return SimpleNamespace(st_dev=1 if str(path)=='/' else 2,st_mode=0o40700,st_ino=10,st_uid=0,st_gid=0)
  with patch.object(m.Path,'is_symlink',return_value=False),patch.object(m.Path,'read_text',return_value=row),patch.object(m,'command',return_value=(m.X5_UUID+'\n').encode()),patch.object(m.os,'stat',side_effect=stat_result):
   self.assertEqual(m.filesystem_identity(current)['mountId'],'20')
   with patch.object(m,'command',return_value=b'wrong'),self.assertRaises(m.Stop):m.filesystem_identity(current)
   with patch.object(m.Path,'read_text',return_value=''),self.assertRaises(m.Stop):m.filesystem_identity(current)
   with patch.object(m.Path,'is_symlink',return_value=True),self.assertRaises(m.Stop):m.filesystem_identity(current)
   with patch.object(m.os,'stat',return_value=stat_result('/')),self.assertRaises(m.Stop):m.filesystem_identity(current)
 def test_freshness_is_rechecked_after_slow_checks_and_durable_intent(self):
  events=[]
  with patch.object(m,'inspect',return_value={'Config':{'Labels':LABELS}}),patch.object(m,'compose_cli_gate'),patch.object(m,'filesystem_gate',side_effect=lambda *a:events.append('fs')),patch.object(m,'no_known_active_builds',side_effect=lambda:events.append('build')),patch.object(m,'profile_and_go',side_effect=m.Stop('GO_EXPIRED')),self.assertRaises(m.Stop):m.fresh_mutation_gate('activate',{}, {})
  self.assertEqual(events,['fs','build'])
  profile,go,files=self.approval();clock=[120]
  def slow_fsync(*args):clock[0]=161 # Root capacity/build-owner review was at 100.
  with patch.object(m,'protected',side_effect=lambda path:files[path]),patch.object(m.time,'time',side_effect=lambda:clock[0]),patch.object(m,'inspect',return_value={'Config':{'Labels':LABELS}}),patch.object(m,'compose_cli_gate'),patch.object(m,'filesystem_gate'),patch.object(m,'no_known_active_builds'),patch.object(m,'receipt',side_effect=slow_fsync) as receipt,patch.object(m,'replace_pin') as pin,self.assertRaises(m.Stop):
   m.intent_then_pin('activate',profile,go,m.ROOT/'test-intent',{},b'old',b'new')
  receipt.assert_called_once();pin.assert_not_called()
 def test_export_rejects_extensions_before_reading_payload_and_budget_truncation(self):
  for kind in [tarfile.XHDTYPE,tarfile.XGLTYPE,tarfile.GNUTYPE_LONGNAME,tarfile.GNUTYPE_SPARSE]:
   item=tarfile.TarInfo('extension');item.type=kind;item.size=2**30
   class HeaderOnly:
    def __init__(self):self.calls=0
    def read(self,n):
     self.calls+=1
     if self.calls>1:raise AssertionError('extension payload was read')
     return item.tobuf(format=tarfile.USTAR_FORMAT)
   reader=HeaderOnly()
   with self.subTest(kind=kind),self.assertRaises(m.Stop):list(m.exported_layers(reader,4096))
   self.assertEqual(reader.calls,1)
  for raw,budget in [(b'\0'*1024,512),(b'\0'*512,2048),(b'\0'*1024+b'x',2048)]:
   with self.assertRaises(m.Stop):list(m.exported_layers(io.BytesIO(raw),budget))
 def test_nested_layer_pax_and_xattr_metadata_denied(self):
  for metadata in [{'SCHILY.xattr.user.test':'x'},{'comment':'unapproved'}]:
   out=io.BytesIO()
   with tarfile.open(fileobj=out,mode='w',format=tarfile.PAX_FORMAT) as archive:
    item=tarfile.TarInfo('app');item.type=tarfile.DIRTYPE;item.mode=0o755;item.pax_headers=metadata;archive.addfile(item)
   raw=out.getvalue()
   with self.assertRaises(m.Stop):m.validate_tar(raw,'sha256:'+m.sha(raw),{})
 def test_export_reader_has_wall_deadline_even_with_hung_writer(self):
  p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],stdout=subprocess.PIPE)
  start=time.monotonic()
  try:
   with self.assertRaisesRegex(m.Stop,'IMAGE_EXPORT_DEADLINE'):m.DeadlineReader(p.stdout,start+0.1).read(512)
   self.assertLess(time.monotonic()-start,2)
  finally:p.kill();p.wait(timeout=5);p.stdout.close()
 def test_whole_image_gate_kills_hung_export_without_mutation(self):
  old={'Os':'linux','Architecture':'amd64','Config':{},'RootFS':{'Layers':['base']}}
  new={**old,'RootFS':{'Layers':['base','one','two','three']},'Size':1}
  p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],stdout=subprocess.PIPE,start_new_session=True,bufsize=0)
  try:
   with patch.object(m,'command',side_effect=[json.dumps([old]).encode(),json.dumps([new]).encode()]) as command,patch.object(m.subprocess,'Popen',return_value=p),patch.object(m,'EXPORT_TIMEOUT',0.1),self.assertRaisesRegex(m.Stop,'IMAGE_EXPORT_DEADLINE'):m.image_gate('candidate')
   self.assertIsNotNone(p.poll());self.assertLess(p.returncode,0);self.assertTrue(p.stdout.closed)
   self.assertEqual(command.call_count,2)
  finally:
   if p.poll() is None:p.kill();p.wait(timeout=5)
   p.stdout.close()
 def test_preflight_critical_gate_precedes_any_pin_or_recreate(self):
  source=Path(m.__file__).read_text();main=source[source.index('def main():'):]
  self.assertLess(main.index('critical_service_gate(before,'),main.index('intent_then_pin(action,'))
  self.assertLess(main.index('critical_service_gate(check,'),main.index("PHASE='recreate';command("))
 def test_slow_temp_pin_fsync_and_final_cas_expiry_never_rename(self):
  for slow_stage in ['temp_fsync','final_cas']:
   with self.subTest(stage=slow_stage),TemporaryDirectory(prefix='sim-pin-unit-') as directory:
    parent=Path(directory);pin=parent/'pin.json';pin.write_bytes(b'old')
    profile,go,files=self.approval();clock=[120];reads=[0];real_fsync=os.fsync
    def pin_read(_go):
     reads[0]+=1
     if slow_stage=='final_cas' and reads[0]==3:clock[0]=161
     return os.open(parent,os.O_RDONLY|os.O_DIRECTORY),pin.read_bytes(),pin.stat()
    def slow_fsync(fd):
     real_fsync(fd)
     if slow_stage=='temp_fsync':clock[0]=161
    with patch.object(m,'PIN',pin),patch.object(m,'pin_read',side_effect=pin_read),patch.object(m.os,'fsync',side_effect=slow_fsync),patch.object(m.os,'replace') as rename,patch.object(m,'protected',side_effect=lambda path:files[path]),patch.object(m.time,'time',side_effect=lambda:clock[0]),patch.object(m,'inspect',return_value={'Config':{'Labels':LABELS}}),patch.object(m,'compose_cli_gate'),patch.object(m,'filesystem_gate'),patch.object(m,'no_known_active_builds'),self.assertRaisesRegex(m.Stop,'OWNER_ACTIVITY_REVIEW_EXPIRED'):
     m.replace_pin(profile,go,b'old',b'new')
    rename.assert_not_called();self.assertEqual(pin.read_bytes(),b'old');self.assertEqual(list(parent.iterdir()),[pin])
 def test_cli_tar_and_unicode_parser_failures_emit_only_bounded_code(self):
  for error in [tarfile.ReadError('private tar path secret'),tarfile.HeaderError('private header secret'),UnicodeDecodeError('utf8',b'\xff',0,1,'private secret')]:
   out=io.StringIO()
   with self.subTest(error=type(error).__name__),patch.object(m,'main',side_effect=error),redirect_stdout(out),self.assertRaises(SystemExit) as stopped:m.run_cli()
   self.assertEqual(stopped.exception.code,2)
   self.assertEqual(json.loads(out.getvalue()),{'status':'stopped_requires_review','automaticRetry':False,'code':'SIM_MAINTAIN_FAILED_DETAILS_WITHHELD','phase':'preflight'})
   self.assertNotIn('secret',out.getvalue())
 def test_compose_null_inherits_exec_but_changed_live_exec_is_rejected(self):
  compose,current,image=self.critical_fixture()
  compose['services']['sim-api'].update(command=None,entrypoint=None)
  m.before_service_gate(compose,current,image)
  for field in ['Cmd','Entrypoint']:
   bad=copy.deepcopy(current);bad['Config'][field]=['different']
   with self.subTest(field=field),self.assertRaises(m.Stop):m.before_service_gate(compose,bad,image)
 def test_explicit_empty_overrides_and_entrypoint_cmd_cross_rule(self):
  for field,ik in [('command','Cmd'),('entrypoint','Entrypoint')]:
   for empty in ['',[]]:
    compose,current,image=self.critical_fixture();compose['services']['sim-api'][field]=empty
    with self.subTest(field=field,empty=empty),self.assertRaises(m.Stop):m.before_service_gate(compose,current,image)
    current['Config'][ik]=[]
    if field=='entrypoint':
     with self.assertRaises(m.Stop):m.before_service_gate(compose,current,image) # image CMD must not survive.
     current['Config']['Cmd']=[]
    m.before_service_gate(compose,current,image)
  compose,current,image=self.critical_fixture();compose['services']['sim-api']['entrypoint']=['new-entrypoint'];current['Config']['Entrypoint']=['new-entrypoint']
  with self.assertRaises(m.Stop):m.before_service_gate(compose,current,image)
  current['Config']['Cmd']=[];m.before_service_gate(compose,current,image)
  compose['services']['sim-api']['command']=['explicit-command'];current['Config']['Cmd']=['explicit-command'];m.before_service_gate(compose,current,image)
 def test_only_doubly_absent_user_canonicalizes_to_engine_empty_string(self):
  compose,current,image=self.critical_fixture();image['Config'].pop('User')
  m.before_service_gate(compose,current,image)
  for mutate in [lambda s,c,i:s.update(user=None),lambda s,c,i:i.update(User=None),lambda s,c,i:c.update(User='root'),lambda s,c,i:c.update(User=None)]:
   s,c,i=copy.deepcopy(compose),copy.deepcopy(current),copy.deepcopy(image);mutate(s['services']['sim-api'],c['Config'],i['Config'])
   with self.assertRaises(m.Stop):m.before_service_gate(s,c,i)
  compose['services']['sim-api']['working_dir']=None
  with self.assertRaises(m.Stop):m.before_service_gate(compose,current,image)
 def test_finite_compose_version_transition_never_waives_other_labels(self):
  compose,current,image=self.critical_fixture();m.critical_service_gate(compose,current,image)
  new=copy.deepcopy(current);new['Config']['Labels'][m.COMPOSE_VERSION_LABEL]='5.6.1'
  self.assertEqual(m.normalized_runtime(current),m.normalized_runtime(new))
  m.compose_metadata_gate(new,('5.6.1',))
  with self.assertRaises(m.Stop):m.compose_metadata_gate(current,('5.6.1',))
  for key,value in [(m.COMPOSE_VERSION_LABEL,'5.6.2'),(m.COMPOSE_VERSION_LABEL,'5.5.0'),(m.COMPOSE_VERSION_LABEL,None),('com.docker.compose.project.environment_file','/other/.env'),('com.docker.compose.replace','other-name')]:
   bad=copy.deepcopy(current);bad['Config']['Labels'][key]=value
   with self.subTest(key=key,value=value),self.assertRaises(m.Stop):m.normalized_runtime(bad)
   with self.assertRaises(m.Stop):m.critical_service_gate(compose,bad,image)
  for unknown in ['com.docker.compose.future','private.extra']:
   bad=copy.deepcopy(current);bad['Config']['Labels'][unknown]='value'
   self.assertNotEqual(m.normalized_runtime(current),m.normalized_runtime(bad))
   with self.assertRaises(m.Stop):m.critical_service_gate(compose,bad,image)
  normalized=m.normalized_runtime(new)['Config']['Labels']
  self.assertEqual(normalized['com.docker.compose.project.environment_file'],'/srv/sim/.env')
  self.assertEqual(normalized['com.docker.compose.replace'],m.NAME)
 def test_exact_cli_version_and_old_forward_version_are_checked_before_mutation(self):
  for value in [b'5.6.1\n',b'v5.6.1\n']:
   with patch.object(m,'command',return_value=value):m.compose_cli_gate()
  for value in [b'5.6.0',b'5.6.2',b'5.6.1-extra',b'unknown',b'']:
   with self.subTest(value=value),patch.object(m,'command',return_value=value),self.assertRaises(m.Stop):m.compose_cli_gate()
  profile,go,_=self.approval()
  with patch.object(m,'inspect',return_value={'Config':{'Labels':LABELS}}),patch.object(m,'filesystem_gate'),patch.object(m,'no_known_active_builds'),patch.object(m,'command',return_value=b'5.6.2'),patch.object(m,'profile_and_go') as admission,self.assertRaisesRegex(m.Stop,'COMPOSE_CLI_VERSION_DRIFT'):m.fresh_mutation_gate('activate',profile,go)
  admission.assert_not_called()
  already_new={**LABELS,m.COMPOSE_VERSION_LABEL:'5.6.1'}
  with patch.object(m,'inspect',return_value={'Config':{'Labels':already_new}}),patch.object(m,'command') as command,self.assertRaisesRegex(m.Stop,'COMPOSE_VERSION_LABEL_DRIFT'):m.fresh_mutation_gate('activate',profile,go)
  command.assert_not_called()
 def approval(self):
  profile={'contract':'sim-image-only-root-profile-v1','handlerSha256':m.sha(b'handler'),'probeSha256':m.sha(b'probe'),'candidateImage':'sha256:'+'a'*64,'baseImage':m.BASE,'dataFilesystem':{'minimumFreeBytesX5':2147483648}}
  files={m.ROOT/'profile.json':m.encoded(profile),m.SOURCE/'sim-pg-disconnect-maintain.py':b'handler',m.SOURCE/'sim-maintenance-lineage-probe.mjs':b'probe'}
  go={'contract':'sim-image-only-root-go-v1','action':'activate','releaseId':'a'*32,'profileSha256':m.sha(files[m.ROOT/'profile.json']),
   'createdAt':100,'expiresAt':200,'expectedCid':'b'*64,'expectedImage':m.BASE,'expectedStartedAt':'synthetic-start','expectedRestartCount':1,'runtimeSha256':'c'*64,'composeSha256':'d'*64,
   'layerFileSha256':{str(p):'e'*64 for p in m.LAYERS},'lineage':{'contract':'sim-maintenance-readonly-lineage-v1','verified':True,'binding':'f'*64,'config':'1'*64,'journal':'2'*64},
   'pinParentMetadata':{'/':[0,0,493],'/srv':[0,0,493],'/srv/sim':[1000,1000,493]},'minimumFreeBytes':2147483648,'capacityReviewedAt':100,'buildIdleReviewedAt':100}
  files[m.ROOT/'go.json']=m.encoded(go)
  return profile,go,files
 def test_exact_approval_and_negative_freshness_scope(self):
  p,g,f=self.approval()
  with patch.object(m,'protected',side_effect=lambda path:f[path]),patch.object(m.time,'time',return_value=120):self.assertEqual(m.profile_and_go('activate'),(p,g))
  for field,value in [('expiresAt',119),('createdAt',121),('action','reset'),('profileSha256','wrong'),('buildIdleReviewedAt',0),('capacityReviewedAt',0),('unknown','extra')]:
   _,go,files=self.approval();go[field]=value;files[m.ROOT/'go.json']=m.encoded(go)
   with self.subTest(field=field),patch.object(m,'protected',side_effect=lambda path:files[path]),patch.object(m.time,'time',return_value=120),self.assertRaises(m.Stop):m.profile_and_go('activate')
 def test_pin_change_only_and_exact_reversible_bytes(self):
  raw=m.encoded({'services':{'sim-api':{'image':m.BASE,'environment':{'PRIVATE':'synthetic-secret'}},'other':{'image':'untouched'}}})
  new='sha256:'+'a'*64;changed=m.changed_pin(raw,m.BASE,new)
  self.assertEqual(m.changed_pin(changed,new,m.BASE),raw)
  self.assertEqual(json.loads(changed)['services']['other'],{'image':'untouched'})
  for data in [raw.replace(m.BASE.encode(),b'wrong'),m.encoded({'services':{'sim-api':{'image':m.BASE},'other':{'image':m.BASE}}})]:
   with self.assertRaises(m.Stop):m.changed_pin(data,m.BASE,new)
 def make_tar(self,extra=None,corrupt=False):
  out=io.BytesIO()
  with tarfile.open(fileobj=out,mode='w') as a:
   for name,expected in m.FILES.items():
    raw=(Path(__file__).resolve().parents[1]/name.removeprefix('app/')).read_bytes()
    self.assertEqual(hashlib.sha256(raw).hexdigest(),expected)
    item=tarfile.TarInfo(name);item.mode=0o644;item.size=len(raw);a.addfile(item,io.BytesIO(raw if not corrupt else b'x'*len(raw)))
   if extra:
    item=tarfile.TarInfo(extra);item.mode=0o644;item.size=1;a.addfile(item,io.BytesIO(b'x'))
  return out.getvalue()
 def test_exact_layer_contents_and_reject_extra_whiteout_or_changed_bytes(self):
  raw=self.make_tar();m.validate_tar(raw,'sha256:'+m.sha(raw))
  for extra in ['app/extra','app/.wh.user-data.js','../escape']:
   raw=self.make_tar(extra)
   with self.subTest(extra=extra),self.assertRaises(m.Stop):m.validate_tar(raw,'sha256:'+m.sha(raw))
  raw=self.make_tar(corrupt=True)
  with self.assertRaises(m.Stop):m.validate_tar(raw,'sha256:'+m.sha(raw))
 def test_only_two_single_file_layers_inherit_exact_base_directory_775(self):
  def layer(path,directory,mode,gid=0):
   out=io.BytesIO();payload=(Path(__file__).resolve().parents[1]/path.removeprefix('app/')).read_bytes()
   with tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT) as archive:
    item=tarfile.TarInfo(directory);item.type=tarfile.DIRTYPE;item.mode=mode;item.gid=gid;archive.addfile(item)
    item=tarfile.TarInfo(path);item.mode=0o644;item.size=len(payload);archive.addfile(item,io.BytesIO(payload))
   return out.getvalue()
  for path in ['app/packages/sim-user-data/bootstrap.mjs','app/packages/sim-user-data/pg-errors.mjs']:
   expected={path:m.FILES[path]};raw=layer(path,'app/packages/sim-user-data',0o775);m.validate_tar(raw,'sha256:'+m.sha(raw),expected)
   for mode in [0o755,0o770,0o777,0o2775]:
    bad=layer(path,'app/packages/sim-user-data',mode)
    with self.subTest(path=path,mode=mode),self.assertRaises(m.Stop):m.validate_tar(bad,'sha256:'+m.sha(bad),expected)
   for directory,mode,gid in [('app/packages',0o775,0),('app/unknown',0o775,0),('app/packages/sim-user-data',0o775,1)]:
    bad=layer(path,directory,mode,gid)
    with self.subTest(directory=directory,gid=gid),self.assertRaises(m.Stop):m.validate_tar(bad,'sha256:'+m.sha(bad),expected)
   normal=layer(path,'app/packages',0o755);m.validate_tar(normal,'sha256:'+m.sha(normal),expected)
  path='app/apps/simulator-api/dist/user-data.js';bad=layer(path,'app/packages/sim-user-data',0o775)
  with self.assertRaises(m.Stop):m.validate_tar(bad,'sha256:'+m.sha(bad),{path:m.FILES[path]})
 def test_preexisting_env_or_exec_render_drift_refused(self):
  current={'Config':{'Env':['FIXED=value'],'Cmd':['node','entry.js'],'Entrypoint':['docker-entrypoint.sh'],'User':'','WorkingDir':'/app'}}
  image={'Config':copy.deepcopy(current['Config'])};compose={'services':{'sim-api':{'environment':{}}}}
  m.before_service_gate(compose,current,image)
  for k,v in [('environment',{'FIXED':'changed'}),('command',['sh'])]:
   bad=copy.deepcopy(compose);bad['services']['sim-api'][k]=v
   with self.subTest(k=k),self.assertRaises(m.Stop):m.before_service_gate(bad,current,image)
 def test_nonroot_cannot_run_any_command(self):
  with patch.object(m.os,'geteuid',return_value=1000),patch.object(m,'command') as run,self.assertRaises(m.Stop):m.main()
  run.assert_not_called()
 def test_dns_normalization_is_only_three_explicit_null_or_list_fields(self):
  _,c,_=self.critical_fixture()
  for key in m.DNS_FIELDS:c['HostConfig'][key]=None
  old=copy.deepcopy(c)
  for key in m.DNS_FIELDS:old['HostConfig'][key]=[]
  self.assertEqual(m.normalized_runtime(c),m.raw_normalized_runtime(old))
  self.assertNotEqual(m.raw_normalized_runtime(c),m.raw_normalized_runtime(old))
  for key in m.DNS_FIELDS:
   for bad in ['',{},0,False,['ok',None]]:
    changed=copy.deepcopy(c);changed['HostConfig'][key]=bad
    with self.subTest(key=key,bad=bad),self.assertRaisesRegex(m.Stop,'DNS_SERIALIZATION_TYPE'):m.normalized_runtime(changed)
   changed=copy.deepcopy(c);changed['HostConfig'][key]=['1.2.3.4']
   self.assertEqual(m.normalized_runtime(changed)['HostConfig'][key],['1.2.3.4'])
   self.assertNotEqual(m.normalized_runtime(c),m.normalized_runtime(changed))
  for key,value in [('ExtraHosts',[]),('Binds',[]),('Privileged',True)]:
   changed=copy.deepcopy(c);changed['HostConfig'][key]=value
   self.assertNotEqual(m.normalized_runtime(c),m.normalized_runtime(changed))
  missing=copy.deepcopy(c);del missing['HostConfig']['Dns']
  self.assertNotEqual(m.normalized_runtime(c),m.normalized_runtime(missing))
 def test_dns_lane_has_separate_go_paths_and_disallows_forward_replay(self):
  self.assertEqual(m.approval_paths('accept-existing-dns'),(m.ROOT/'profile-dns-v1.json',m.ROOT/'go-dns-v1.json'))
  self.assertEqual(m.approval_paths('rollback'),(m.ROOT/'profile-dns-v1.json',m.ROOT/'go-dns-rollback-v1.json'))
  with patch.object(m.os,'geteuid',return_value=0),patch.object(m.socket,'gethostname',return_value='docker'),patch.object(m,'SOURCE',Path(m.__file__).parent),patch.object(m.sys,'argv',['script','--activate']),patch.object(m,'command') as run,self.assertRaisesRegex(m.Stop,'ACTION'):m.main()
  run.assert_not_called()
 def dns_fixture(self):
  release='78a7cc8faa074cb284d6c3523f03ee38';runtime='ac363097ca5a677189897d62560e534854e1f068ba1c5d9c7b2713eff6fa03cd'
  _,c,_=self.critical_fixture();c.update(Image='sha256:0e6b989a135cf618cd02903a54b76a272f4ed574b73005a2c502c7ce304f15cd',State={'StartedAt':'synthetic-new'},RestartCount=0)
  for key in m.DNS_FIELDS:c['HostConfig'][key]=None
  original={'contract':'sim-image-only-root-profile-v1','handlerSha256':'46af72cd310c509d64a1d68ab8a422caf43629c1bee4b88a98f65738840d1598','probeSha256':'unchanged','baseImage':m.BASE,'candidateImage':c['Image'],'dataFilesystem':{'synthetic':'unchanged'}}
  profile={**original,'handlerSha256':'synthetic-new-handler'}
  lineage={'synthetic':'unchanged'};layers={str(p):'unchanged' for p in m.LAYERS}
  og={'action':'activate','releaseId':release,'expectedImage':m.BASE,'expectedCid':'a'*64,'profileSha256':m.sha(m.encoded(original)),'runtimeSha256':runtime,'lineage':lineage,'composeSha256':'original-compose','layerFileSha256':layers}
  intent={'phase':'intent_not_completion','oldImage':m.BASE,'newImage':c['Image'],'baselineCid':og['expectedCid'],'profileSha256':og['profileSha256'],'lineage':lineage,'runtimeSha256':runtime,'composeSha256':og['composeSha256'],'layerFileSha256':layers}
  failed={'exitCode':2,'automaticRetry':False,'stdout':json.dumps({'status':'stopped_requires_review','code':'POST_RUNTIME','phase':'recreate'})}
  files={m.ROOT/'profile.json':m.encoded(original),m.ROOT/'go.json':m.encoded(og),m.ROOT/(release+'-activate.json'):m.encoded(intent),m.ROOT/'operator-invocation-result.json':m.encoded(failed),m.ROOT/'profile-dns-v1.json':m.encoded(profile),m.SOURCE/'sim-pg-disconnect-maintain.46af.py':b'synthetic-original-controller'}
  a={'contract':'sim-empty-dns-profile-amendment-v1','originalProfileSha256':m.sha(files[m.ROOT/'profile.json']),'originalGoSha256':m.sha(files[m.ROOT/'go.json']),'originalIntentSha256':m.sha(files[m.ROOT/(release+'-activate.json')]),'originalFailedResultSha256':m.sha(files[m.ROOT/'operator-invocation-result.json']),'newProfileSha256':m.sha(files[m.ROOT/'profile-dns-v1.json']),'releaseId':release,'candidateImage':c['Image'],'runtimeSha256':runtime,'observedRawRuntimeSha256':m.digest(m.raw_normalized_runtime(c)),'acceptedCid':c['Id'],'acceptedStartedAt':c['State']['StartedAt'],'acceptedRestartCount':0,'changedFields':['HostConfig.'+k for k in m.DNS_FIELDS]}
  go={'releaseId':release,'lineage':lineage,'runtimeSha256':runtime,'expectedImage':c['Image'],'profileSha256':a['newProfileSha256']}
  files[m.ROOT/'dns-serialization-amendment.json']=m.encoded(a)
  return profile,go,c,files,a
 def test_dns_amendment_exact_artifact_chain_and_negative_scope(self):
  p,g,c,f,a=self.dns_fixture();real_sha=m.sha;real_digest=m.digest;canonical=m.normalized_runtime(c)
  def sha(raw):return '46af72cd310c509d64a1d68ab8a422caf43629c1bee4b88a98f65738840d1598' if raw==b'synthetic-original-controller' else real_sha(raw)
  def digest(value):return g['runtimeSha256'] if value==canonical else real_digest(value)
  # Synthetic unit chain only: the actual ac3630 preimage is Root evidence.
  with patch.object(m,'sha',side_effect=sha),patch.object(m,'digest',side_effect=digest),patch.object(m,'protected',side_effect=lambda path:f[path]):
   self.assertEqual(m.dns_amendment(p,g,c)[0],a['originalProfileSha256'])
   for key,value in [('lineage',{'changed':True}),('runtimeSha256','wrong'),('releaseId','other')]:
    with self.subTest(go=key),self.assertRaises(m.Stop):m.dns_amendment(p,{**g,key:value},c)
   for key,value in [('acceptedCid','c'*64),('originalProfileSha256','wrong'),('originalGoSha256','wrong'),('originalIntentSha256','wrong'),('originalFailedResultSha256','wrong'),('newProfileSha256','wrong'),('changedFields',['HostConfig.ExtraHosts']),('unknown',True)]:
    f[m.ROOT/'dns-serialization-amendment.json']=m.encoded({**a,key:value})
    with self.subTest(amendment=key),self.assertRaises(m.Stop):m.dns_amendment(p,g,c)
   f[m.ROOT/'dns-serialization-amendment.json']=m.encoded(a)
   for mutate in [lambda x:x.update(RestartCount=1),lambda x:x['HostConfig'].update(Dns=[]),lambda x:x['HostConfig'].update(ExtraHosts=['changed']),lambda x:x.update(Image=m.BASE)]:
    changed=copy.deepcopy(c);mutate(changed)
    with self.assertRaises(m.Stop):m.dns_amendment(p,g,changed)
   altered=copy.deepcopy(p);altered['dataFilesystem']={'changed':True}
   with self.assertRaises(m.Stop):m.dns_amendment(altered,g,c)
 def test_dns_acceptance_is_separate_read_only_receipt_and_late_failure_stops(self):
  p,g,c,_,_=self.dns_fixture();g['layerFileSha256']={str(x):'same' for x in m.LAYERS}
  rendered={'services':{'sim-api':{'image':p['candidateImage']}}};inverse=copy.deepcopy(rendered);inverse['services']['sim-api']['image']=m.BASE
  raw=m.encoded({'services':{'sim-api':{'image':p['candidateImage']}}})
  prev={'composeSha256':m.digest(inverse),'pinSha256':m.sha(m.changed_pin(raw,p['candidateImage'],m.BASE)),'layerFileSha256':g['layerFileSha256']}
  def protected(path):return m.encoded(prev) if path.name.endswith('-activate.json') else b'profile' if path.name=='profile-dns-v1.json' else b'go'
  for expired in [False,True]:
   with patch.object(m,'facts',return_value=c),patch.object(m,'dns_amendment',return_value=('old-profile','amendment')),patch.object(m,'image_gate'),patch.object(m,'critical_service_gate'),patch.object(m,'command',side_effect=lambda args:m.encoded(rendered) if 'config' in args else b'[{}]') as run,patch.object(m,'protected',side_effect=protected),patch.object(m,'pin_read',return_value=(123,raw,None)),patch.object(m.os,'close'),patch.object(m,'profile_and_go',side_effect=m.Stop('GO_EXPIRED') if expired else lambda action:(p,g)),patch.object(m,'receipt') as receipt,redirect_stdout(io.StringIO()):
    if expired:
     with self.assertRaisesRegex(m.Stop,'GO_EXPIRED'):m.accept_existing_dns(p,g,b'profile',b'go')
     receipt.assert_not_called()
    else:
     m.accept_existing_dns(p,g,b'profile',b'go');self.assertTrue(receipt.call_args.args[0].name.endswith('-dns-post-acceptance.json'));self.assertFalse(receipt.call_args.args[1]['appUpExecuted'])
    self.assertTrue(all('up' not in x.args[0] for x in run.call_args_list))
 def test_dns_reverse_requires_exact_distinct_acceptance_receipt(self):
  p,g,c,_,a=self.dns_fixture()
  accepted={'contract':'sim-empty-dns-post-acceptance-v1','completed':True,'cid':c['Id'],'startedAt':c['State']['StartedAt'],'restartCount':0,'image':c['Image'],'lineage':g['lineage'],'runtimeSha256':g['runtimeSha256'],'profileSha256':g['profileSha256'],'originalProfileSha256':'bridge','amendmentSha256':'amendment','appUpExecuted':False,'dataRestored':False}
  with patch.object(m,'dns_amendment',return_value=('bridge','amendment')):
   with patch.object(m,'protected',return_value=m.encoded(accepted)):self.assertEqual(m.dns_reverse_acceptance(p,g,c),'bridge')
   for key,value in [('completed',False),('lineage',{}),('profileSha256','wrong'),('cid','wrong'),('amendmentSha256','wrong'),('appUpExecuted',True),('unknown',True)]:
    with self.subTest(key=key),patch.object(m,'protected',return_value=m.encoded({**accepted,key:value})),self.assertRaisesRegex(m.Stop,'ROLLBACK_DNS_ACCEPTANCE'):m.dns_reverse_acceptance(p,g,c)
 def test_runtime_security_mount_and_network_drift_remain_in_hash(self):
  a={'Config':{'Env':['AUTH=on'],'Labels':copy.deepcopy(LABELS),'Cmd':['node']},'HostConfig':{'Privileged':False},'Mounts':[{'Source':'fixed','RW':False}],
     'NetworkSettings':{'Networks':{'sim_default':{'NetworkID':'fixed-network','Aliases':['sim-api']}}}}
  h=m.digest(m.normalized_runtime(a))
  for field in ['env','privilege','mount','network']:
   b=copy.deepcopy(a)
   if field=='env':b['Config']['Env']=['AUTH=off']
   if field=='privilege':b['HostConfig']['Privileged']=True
   if field=='mount':b['Mounts'][0]['RW']=True
   if field=='network':b['NetworkSettings']['Networks']['sim_default']['NetworkID']='other'
   self.assertNotEqual(m.digest(m.normalized_runtime(b)),h)
 def test_recreate_scope_is_single_fixed_service(self):
  spec=importlib.util.spec_from_file_location('baseline_peer',Path(__file__).with_name('sim-pg-disconnect-baseline.py'))
  b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
  c={'Config':{'Env':['FIXED=value'],'Labels':{**LABELS,'com.docker.compose.image':'ignored'},'Image':'old'},'HostConfig':{},'Mounts':[],
     'NetworkSettings':{'Networks':{'sim':{'NetworkID':'network','Aliases':['sim-api']}}}}
  for version in ['5.6.0','5.6.1']:
   c['Config']['Labels'][m.COMPOSE_VERSION_LABEL]=version
   self.assertEqual(m.normalized_runtime(c),b.maintenance_runtime(c))
  source=Path(m.__file__).read_text()
  self.assertIn("DC+['up','-d','--no-deps','--no-build','--pull','never','sim-api']",source)
  self.assertNotIn("DC+['down'",source)
  self.assertNotIn('systemctl',source)
  self.assertNotIn('pg_terminate_backend',source)

if __name__=='__main__':unittest.main()
