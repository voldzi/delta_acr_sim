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

class MaintainTests(unittest.TestCase):
 def critical_fixture(self):
  cfg={'Env':['FIXED=value'],'Cmd':['node','entry.js'],'Entrypoint':['docker-entrypoint.sh'],'User':'','WorkingDir':'/app','Hostname':'b'*12}
  h={'ShmSize':67108864,'IpcMode':'private','Runtime':'runc','CgroupnsMode':'private','ConsoleSize':[0,0],
   'MaskedPaths':['/proc/acpi','/proc/asound','/proc/interrupts','/proc/kcore','/proc/keys','/proc/latency_stats','/proc/timer_list','/proc/timer_stats','/proc/sched_debug','/proc/scsi','/sys/firmware','/sys/devices/virtual/powercap'],
   'ReadonlyPaths':['/proc/bus','/proc/fs','/proc/irq','/proc/sys','/proc/sysrq-trigger'],
   'LogConfig':{'Type':'json-file','Config':{}},'RestartPolicy':{'Name':'no','MaximumRetryCount':0},'NetworkMode':'sim_default',
   'Binds':['/srv/x5-production/data/sim:/data:rw']}
  c={'Id':'b'*64,'Image':m.BASE,'Config':cfg,'HostConfig':h,'Mounts':[{'Source':'/srv/x5-production/data/sim','Destination':'/data','RW':True,'Type':'bind'}],
   'NetworkSettings':{'Networks':{'sim_default':{'Aliases':[m.NAME,'sim-api']}}}}
  compose={'services':{'sim-api':{'container_name':m.NAME,'image':m.BASE,'environment':{},'volumes':[{'type':'bind','source':'/srv/x5-production/data/sim','target':'/data'}],'networks':{'default':{}}}},'networks':{'default':{'name':'sim_default'}}}
  return compose,c,{'Config':{k:v for k,v in cfg.items() if k!='Hostname'}}
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
  with patch.object(m,'inspect',return_value={}),patch.object(m,'filesystem_gate',side_effect=lambda *a:events.append('fs')),patch.object(m,'no_known_active_builds',side_effect=lambda:events.append('build')),patch.object(m,'profile_and_go',side_effect=m.Stop('GO_EXPIRED')),self.assertRaises(m.Stop):m.fresh_mutation_gate('activate',{}, {})
  self.assertEqual(events,['fs','build'])
  profile,go,files=self.approval();clock=[120]
  def slow_fsync(*args):clock[0]=161 # Root capacity/build-owner review was at 100.
  with patch.object(m,'protected',side_effect=lambda path:files[path]),patch.object(m.time,'time',side_effect=lambda:clock[0]),patch.object(m,'inspect',return_value={}),patch.object(m,'filesystem_gate'),patch.object(m,'no_known_active_builds'),patch.object(m,'receipt',side_effect=slow_fsync) as receipt,patch.object(m,'replace_pin') as pin,self.assertRaises(m.Stop):
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
    with patch.object(m,'PIN',pin),patch.object(m,'pin_read',side_effect=pin_read),patch.object(m.os,'fsync',side_effect=slow_fsync),patch.object(m.os,'replace') as rename,patch.object(m,'protected',side_effect=lambda path:files[path]),patch.object(m.time,'time',side_effect=lambda:clock[0]),patch.object(m,'inspect',return_value={}),patch.object(m,'filesystem_gate'),patch.object(m,'no_known_active_builds'),self.assertRaisesRegex(m.Stop,'OWNER_ACTIVITY_REVIEW_EXPIRED'):
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
 def test_runtime_security_mount_and_network_drift_remain_in_hash(self):
  a={'Config':{'Env':['AUTH=on'],'Labels':{},'Cmd':['node']},'HostConfig':{'Privileged':False},'Mounts':[{'Source':'fixed','RW':False}],
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
  c={'Config':{'Env':['FIXED=value'],'Labels':{'com.docker.compose.image':'ignored'},'Image':'old'},'HostConfig':{},'Mounts':[],
     'NetworkSettings':{'Networks':{'sim':{'NetworkID':'network','Aliases':['sim-api']}}}}
  self.assertEqual(m.normalized_runtime(c),b.maintenance_runtime(c))
  source=Path(m.__file__).read_text()
  self.assertIn("DC+['up','-d','--no-deps','--no-build','--pull','never','sim-api']",source)
  self.assertNotIn("DC+['down'",source)
  self.assertNotIn('systemctl',source)
  self.assertNotIn('pg_terminate_backend',source)

if __name__=='__main__':unittest.main()
