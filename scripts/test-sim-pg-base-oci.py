import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('oci',Path(__file__).with_name('sim-pg-base-oci.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ConversionTests(unittest.TestCase):
 def fixture(self,root,compressed=False,extra=None,hybrid=False):
  raw_layers=[('synthetic-layer-'+str(i)).encode() for i in range(14)]
  config=m.encoded({'architecture':'amd64','os':'linux','config':{'Env':['SYNTHETIC=yes']},'rootfs':{'type':'layers','diff_ids':['sha256:'+m.sha(x) for x in raw_layers]}})
  image='sha256:'+m.sha(config);size=sum(map(len,raw_layers))+len(config)
  base={'Id':image,'Size':size,'Os':'linux','Architecture':'amd64','Config':{'Env':['SYNTHETIC=yes']},'RootFS':{'Layers':['sha256:'+m.sha(x) for x in raw_layers]}}
  values={image[7:]+'.json':config,**{f'layers/{i}.tar':gzip.compress(x,mtime=0) if compressed else x for i,x in enumerate(raw_layers)}}
  config_name=image[7:]+'.json';layer_names=[f'layers/{i}.tar' for i in range(14)]
  if hybrid:
   mapped={};new_names=[]
   for name,raw in values.items():
    target='blobs/sha256/'+m.sha(raw);mapped[target]=raw
    if name==config_name:config_name=target
    else:new_names.append(target)
   values=mapped;layer_names=new_names
   for i in range(14):
    metadata=m.encoded({'syntheticLayerMetadata':i});values['blobs/sha256/'+m.sha(metadata)]=metadata
   metadata=m.encoded({'schemaVersion':2,'syntheticManifest':True});values['blobs/sha256/'+m.sha(metadata)]=metadata
   values['oci-layout']=m.encoded({'imageLayoutVersion':'1.0.0'});values['index.json']=m.encoded({'schemaVersion':2,'manifests':[]})
  values['manifest.json']=m.encoded([{'Config':config_name,'RepoTags':[],'Layers':layer_names}])
  out=io.BytesIO()
  with tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT) as archive:
   if hybrid:
    for name in ['blobs','blobs/sha256']:
     item=tarfile.TarInfo(name);item.type=tarfile.DIRTYPE;item.mode=0o755;archive.addfile(item)
   for name,raw in values.items():
    item=tarfile.TarInfo(name);item.size=len(raw);item.mode=0o644;archive.addfile(item,io.BytesIO(raw))
   if extra:archive.addfile(extra)
  source=Path(root)/'save.tar';source.write_bytes(out.getvalue());source.chmod(0o600)
  return source,Path(root)/'oci',base
 def test_uncompressed_and_gzip_layers_verified_against_actual_config_bytes(self):
  for compressed in [False,True]:
   with self.subTest(compressed=compressed),TemporaryDirectory(prefix='sim-oci-fixture-',dir='/private/tmp') as root:
    source,out,base=self.fixture(root,compressed)
    with patch.object(m,'BASE',base['Id']),patch.object(m,'BASE_SIZE',base['Size']):result=m.convert(source,out,base)
    self.assertEqual(result['layersVerified'],14);self.assertFalse(result['buildPerformed'])
    self.assertEqual(result['configDigest'],base['Id']);self.assertEqual(stat.S_IMODE(out.stat().st_mode),0o700)
    index=json.loads((out/'index.json').read_bytes());manifest=json.loads((out/'blobs/sha256'/index['manifests'][0]['digest'][7:]).read_bytes())
    self.assertEqual(len(index['manifests']),1);self.assertEqual(len(manifest['layers']),14)
    for blob in (out/'blobs/sha256').iterdir():self.assertEqual(m.sha(blob.read_bytes()),blob.name);self.assertEqual(stat.S_IMODE(blob.stat().st_mode),0o600)
    self.assertTrue(all(x['mediaType'].endswith('+gzip')==compressed for x in manifest['layers']))
 def test_any_archive_link_is_rejected_even_if_unreferenced(self):
  for kind in [tarfile.SYMTYPE,tarfile.LNKTYPE,tarfile.CHRTYPE]:
   with TemporaryDirectory(prefix='sim-oci-fixture-',dir='/private/tmp') as root:
    item=tarfile.TarInfo('unreferenced');item.type=kind;item.linkname='escape';source,out,base=self.fixture(root,extra=item)
    with patch.object(m,'BASE',base['Id']),patch.object(m,'BASE_SIZE',base['Size']),self.assertRaises(m.Rejected):m.convert(source,out,base)
    self.assertFalse((out/'index.json').exists())
 def test_extensions_are_denied_before_their_payload_is_read(self):
  for kind in [tarfile.XHDTYPE,tarfile.XGLTYPE,tarfile.GNUTYPE_LONGNAME,tarfile.GNUTYPE_SPARSE]:
   item=tarfile.TarInfo('extension');item.type=kind;item.size=2**30
   with TemporaryDirectory(prefix='sim-oci-fixture-',dir='/private/tmp') as root:
    source,out,base=self.fixture(root);stream=io.BytesIO(item.tobuf(format=tarfile.USTAR_FORMAT))
    with self.subTest(kind=kind),patch.object(m,'BASE',base['Id']),patch.object(m,'BASE_SIZE',base['Size']),self.assertRaises(m.Rejected):m.convert_stream(stream,out,base)
    self.assertEqual(stream.tell(),512)
 def test_wrong_config_platform_and_layer_order_fail_closed(self):
  for field in ['Config','Layers','Id','Architecture']:
   with TemporaryDirectory(prefix='sim-oci-fixture-',dir='/private/tmp') as root:
    source,out,base=self.fixture(root);original=base['Id']
    if field=='Config':base[field]={'Env':['WRONG=yes']}
    if field=='Layers':base['RootFS']['Layers'].reverse()
    if field=='Id':base[field]='sha256:'+'a'*64
    if field=='Architecture':base[field]='arm64'
    with patch.object(m,'BASE',original),patch.object(m,'BASE_SIZE',base['Size']),self.assertRaises(m.Rejected):m.convert(source,out,base)
    self.assertFalse((out/'index.json').exists())
 def test_disk_and_gzip_unpacked_budgets_and_expired_deadline(self):
  for budget in ['save','unpacked']:
   with TemporaryDirectory(prefix='sim-oci-fixture-',dir='/private/tmp') as root:
    source,out,base=self.fixture(root,True)
    with patch.object(m,'BASE',base['Id']),patch.object(m,'BASE_SIZE',base['Size']),patch.object(m,'MAX_SAVE' if budget=='save' else 'MAX_UNPACKED',1),self.assertRaises(m.Rejected):m.convert(source,out,base)
    self.assertFalse((out/'index.json').exists())
  with TemporaryDirectory(prefix='sim-oci-fixture-',dir='/private/tmp') as root:
   source,out,base=self.fixture(root)
   with patch.object(m,'BASE',base['Id']),patch.object(m,'BASE_SIZE',base['Size']),patch.object(m.time,'monotonic',side_effect=[0,121]),self.assertRaises(m.Rejected):m.convert_stream(io.BytesIO(source.read_bytes()),out,base)
 def test_source_symlink_and_preexisting_output_are_refused(self):
  for variant in ['source_link','output_exists']:
   with TemporaryDirectory(prefix='sim-oci-fixture-',dir='/private/tmp') as root:
    source,out,base=self.fixture(root)
    if variant=='source_link':link=Path(root)/'link';link.symlink_to(source);source=link
    else:out.mkdir()
    with patch.object(m,'BASE',base['Id']),patch.object(m,'BASE_SIZE',base['Size']),self.assertRaises((m.Rejected,OSError)):m.convert(source,out,base)
 def test_streamed_raw_and_gzip_produce_same_verified_layout_without_save_staging(self):
  for compressed in [False,True]:
   with TemporaryDirectory(prefix='sim-oci-fixture-',dir='/private/tmp') as root:
    source,out,base=self.fixture(root,compressed)
    with patch.object(m,'BASE',base['Id']),patch.object(m,'BASE_SIZE',base['Size']):
     file_result=m.convert(source,out,base)
     streamed=Path(root)/'streamed';result=m.convert_stream(io.BytesIO(source.read_bytes()),streamed,base)
    self.assertEqual(result['ociManifestDigest'],file_result['ociManifestDigest']);self.assertFalse(result['saveArchiveStaged'])
    self.assertEqual({p.name for p in (out/'blobs/sha256').iterdir()},{p.name for p in (streamed/'blobs/sha256').iterdir()})
    self.assertFalse(list(streamed.rglob('*.partial')))
 def test_streaming_global_header_denial_precedes_extension_payload_and_onbuild_rejected(self):
  for kind in [tarfile.XHDTYPE,tarfile.GNUTYPE_LONGNAME,tarfile.GNUTYPE_SPARSE,tarfile.SYMTYPE,tarfile.LNKTYPE]:
   with TemporaryDirectory(prefix='sim-oci-fixture-',dir='/private/tmp') as root:
    source,out,base=self.fixture(root)
    item=tarfile.TarInfo('bad');item.type=kind;item.size=2**30
    class HeaderOnly:
     calls=0
     def read(self,n):
      self.calls+=1
      if self.calls!=1:raise AssertionError('unsafe payload read')
      return item.tobuf(format=tarfile.USTAR_FORMAT)
    reader=HeaderOnly()
    with patch.object(m,'BASE',base['Id']),patch.object(m,'BASE_SIZE',base['Size']),self.assertRaises(m.Rejected):m.convert_stream(reader,out,base)
    self.assertEqual(reader.calls,1);self.assertFalse((out/'index.json').exists())
  with TemporaryDirectory(prefix='sim-oci-fixture-',dir='/private/tmp') as root:
   source,out,base=self.fixture(root);base['Config']['OnBuild']=['RUN unsafe']
   with patch.object(m,'BASE',base['Id']),patch.object(m,'BASE_SIZE',base['Size']),self.assertRaises(m.Rejected):m.convert_stream(io.BytesIO(source.read_bytes()),out,base)
   self.assertFalse(out.exists())
 def test_streaming_truncation_duplicate_and_byte_budget_have_no_complete_index(self):
  for variant in ['truncated','duplicate','budget']:
   with TemporaryDirectory(prefix='sim-oci-fixture-',dir='/private/tmp') as root:
    extra=tarfile.TarInfo('manifest.json') if variant=='duplicate' else None
    source,out,base=self.fixture(root,extra=extra);raw=source.read_bytes()
    if variant=='truncated':raw=raw[:700]
    with patch.object(m,'BASE',base['Id']),patch.object(m,'BASE_SIZE',base['Size']),patch.object(m,'MAX_SAVE',700 if variant=='budget' else m.MAX_SAVE),self.assertRaises(m.Rejected):m.convert_stream(io.BytesIO(raw),out,base)
    self.assertFalse((out/'index.json').exists())
 def test_streaming_malicious_large_header_cannot_allocate_unbounded_payload(self):
  with TemporaryDirectory(prefix='sim-oci-fixture-',dir='/private/tmp') as root:
   source,out,base=self.fixture(root);item=tarfile.TarInfo('huge');item.size=2**32
   stream=io.BytesIO(item.tobuf(format=tarfile.USTAR_FORMAT))
   with patch.object(m,'BASE',base['Id']),patch.object(m,'BASE_SIZE',base['Size']),self.assertRaises(m.Rejected):m.convert_stream(stream,out,base)
   self.assertEqual(stream.tell(),512);self.assertFalse(list(out.rglob('*.partial')))
 def test_actual_style_hybrid_oci_blob_paths_and_unused_metadata_are_supported(self):
  with TemporaryDirectory(prefix='sim-oci-fixture-',dir='/private/tmp') as root:
   source,out,base=self.fixture(root,hybrid=True)
   with tarfile.open(source) as archive:
    self.assertEqual(len(archive.getmembers()),35)
    self.assertEqual(sum(x.isfile() and x.name.startswith('blobs/sha256/') for x in archive),30)
   with patch.object(m,'BASE',base['Id']),patch.object(m,'BASE_SIZE',base['Size']):result=m.convert_stream(io.BytesIO(source.read_bytes()),out,base)
   self.assertEqual(result['layersVerified'],14);self.assertEqual(len(list((out/'blobs/sha256').iterdir())),16)
   self.assertFalse(result['saveArchiveStaged']);self.assertFalse(list(out.rglob('*.partial')))
if __name__=='__main__':unittest.main()
