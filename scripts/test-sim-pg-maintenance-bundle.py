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
if __name__=='__main__':unittest.main()
