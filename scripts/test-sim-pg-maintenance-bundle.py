import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('bundle',Path(__file__).with_name('prepare-sim-pg-maintenance-bundle.py'))
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
class BundleTests(unittest.TestCase):
 def test_exact_build_context_and_inert_manifest(self):
  entries=b.collect();raw=b.archive(entries,'synthetic-revision')
  with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
   members=archive.getmembers();self.assertEqual(len(members),11)
   self.assertEqual({x.name for x in members if x.name.startswith('build/')},{'build/Dockerfile','build/apps/simulator-api/dist/user-data.js','build/packages/sim-user-data/bootstrap.mjs','build/packages/sim-user-data/pg-errors.mjs'})
   self.assertTrue(all(x.isfile() and x.mode==0o644 and x.uid==x.gid==x.mtime==0 for x in members))
   manifest=json.load(archive.extractfile('manifest.json'));self.assertFalse(manifest['deploymentAuthority']);self.assertIsNone(manifest['candidateImage'])
   self.assertFalse(any('go.json' in x.name or '.env' in x.name for x in members))
  self.assertEqual(raw,b.archive(entries,'synthetic-revision'))
 def test_changed_payload_refused_before_output_creation(self):
  with patch.object(b.Path,'read_bytes',return_value=b'wrong bytes'),self.assertRaisesRegex(RuntimeError,'SIM_BUNDLE_REJECTED'):b.collect()
 def test_dirty_checkout_cannot_prepare(self):
  with patch.object(b,'git',return_value=' M changed'),patch.object(b.tempfile,'mkdtemp') as create,self.assertRaises(RuntimeError):b.main()
  create.assert_not_called()
 def test_oci_variant_changes_only_dockerfile_and_keeps_exact_copy_inputs(self):
  bare=b.collect();oci=b.collect('oci')
  self.assertEqual(set(oci)-set(bare),set(b.OCI_BUILD_ONLY))
  self.assertEqual({p for p in bare if bare[p]!=oci[p]},{'build/Dockerfile'})
  commands=[line for line in oci['build/Dockerfile'].decode().splitlines() if line and not line.startswith('#')]
  self.assertEqual(commands[0],'FROM sim_reviewed_base')
  self.assertEqual(commands[1:],[line for line in bare['build/Dockerfile'].decode().splitlines() if line.startswith('COPY ')])
  self.assertEqual(len(commands),4)
  with tarfile.open(fileobj=io.BytesIO(b.archive(oci,'synthetic','oci'))) as archive:
   manifest=json.load(archive.extractfile('manifest.json'))
  base=manifest['namedBaseContext'];self.assertEqual(base['requiredConfigBlobDigest'],b.BASE)
  self.assertIsNone(base['path']);self.assertIsNone(base['manifestDigest']);self.assertFalse(base['workerIdentityAndStorageVerified']);self.assertFalse(base['bootstrapOrFallbackAllowed'])
  self.assertIn('4*actualBaseImageSize',manifest['capacityPlan']['x5RequiredFreeFormula'])
  self.assertIn('10737418240',manifest['capacityPlan']['x5RequiredFreeFormula'])
  self.assertEqual(base['builderName'],'cop-x5');self.assertEqual(base['builderDriver'],'direct-existing-container-exec')
 def test_actual_build_context_is_exact_ustar_zero_mtime_and_no_extensions(self):
  context=b.build_context(b.collect('oci'))
  self.assertEqual(context[257:263],b'ustar\0')
  with tarfile.open(fileobj=io.BytesIO(context)) as archive:
   members=archive.getmembers();self.assertEqual(len(members),4)
   self.assertEqual({x.name for x in members},{'Dockerfile','apps/simulator-api/dist/user-data.js','packages/sim-user-data/bootstrap.mjs','packages/sim-user-data/pg-errors.mjs'})
   self.assertTrue(all(x.type==tarfile.REGTYPE and x.mtime==x.uid==x.gid==0 and x.mode==0o644 and not x.pax_headers and x.offset_data==x.offset+512 for x in members))
  self.assertEqual(context,b.build_context(b.collect('oci')))
  with self.assertRaises(RuntimeError):b.collect('unknown')
if __name__=='__main__':unittest.main()
