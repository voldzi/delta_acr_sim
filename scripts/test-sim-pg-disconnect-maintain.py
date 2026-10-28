import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('maintain',Path(__file__).with_name('sim-pg-disconnect-maintain.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class MaintainTests(unittest.TestCase):
 def approval(self):
  profile={'contract':'sim-image-only-root-profile-v1','handlerSha256':m.sha(b'handler'),'probeSha256':m.sha(b'probe'),'candidateImage':'sha256:'+'a'*64,'baseImage':m.BASE}
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
