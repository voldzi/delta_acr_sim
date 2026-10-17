"""Local synthetic archive tests only; never invokes Root/Docker/SSH."""
import importlib.util,io,pathlib,tarfile,tempfile,unittest
from unittest.mock import patch
p=pathlib.Path(__file__).parent/'bootstrap-clean-release-root.py'
s=importlib.util.spec_from_file_location('bootstrap',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Bootstrap(unittest.TestCase):
 def archive(self,root,name,kind='file',target=''):
  a=root/'input.tar'
  with tarfile.open(a,'w') as t:
   x=tarfile.TarInfo(name)
   if kind=='file':x.size=3;t.addfile(x,io.BytesIO(b'abc'))
   else:x.type=tarfile.SYMTYPE;x.linkname=target;t.addfile(x)
  return a
 def test_regular_archive(self):
  with tempfile.TemporaryDirectory() as d:
   r=pathlib.Path(d);m.extract(self.archive(r,'scripts/example.py'),r/'out',lambda n:True,False);self.assertEqual((r/'out/scripts/example.py').read_bytes(),b'abc')
 def test_absolute_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   r=pathlib.Path(d);self.assertRaises(RuntimeError,m.extract,self.archive(r,'/etc/bad'),r/'out',lambda n:True,False)
 def test_parent_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   r=pathlib.Path(d);self.assertRaises(RuntimeError,m.extract,self.archive(r,'../bad'),r/'out',lambda n:True,False)
 def test_source_links_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   r=pathlib.Path(d);self.assertRaises(RuntimeError,m.extract,self.archive(r,'a','link','b'),r/'out',lambda n:True,False)
 def test_image_link_escape_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   r=pathlib.Path(d);self.assertRaises(RuntimeError,m.extract,self.archive(r,'a','link','../../etc'),r/'out',lambda n:True,True)
 def test_public_symlink_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   r=pathlib.Path(d);(r/'a').write_bytes(b'a');(r/'link').symlink_to('a')
   with self.assertRaises(OSError):m.public_bytes(r/'link',10)
 def test_sha_rejected_before_archive_or_images(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'manifest';p.write_bytes(b'{}')
   with patch.object(m,'context'),patch.object(m,'check_transports'),patch.object(m,'command',side_effect=AssertionError('UNEXPECTED_DOCKER')):
    with self.assertRaisesRegex(RuntimeError,'MANIFEST_SHA'):m.bootstrap_clean_release(p,'0'*64)
 def test_no_password_reset_apply_or_activation(self):
  t=p.read_text()
  for bad in ['getpass(','.freeze_reviewed(','.run_common_reset(','.activate(','.chmod(0o777)']:self.assertNotIn(bad,t)
 def test_comm_existing_public_key_only(self):
  a=m.transport_args('comm.home.cz');self.assertIn('BatchMode=yes',a);self.assertIn('PasswordAuthentication=no',a);self.assertIn('PreferredAuthentications=publickey',a);self.assertNotIn('PreferredAuthentications=password',a)
 def test_storage_existing_tty_password_not_new_key(self):
  a=m.transport_args('storage.home.cz');self.assertIn('BatchMode=no',a);self.assertIn('PubkeyAuthentication=no',a);self.assertIn('PreferredAuthentications=password',a);self.assertIn('NumberOfPasswordPrompts=1',a)
 def test_fixed_temporary_comm_key_only(self):
  with patch.object(m,'temporary_comm_identity',return_value='/run/cop-clean-reset-comm/id_ed25519'):
   a=m.transport_args('comm.home.cz');self.assertIn('IdentitiesOnly=yes',a);self.assertEqual(a[a.index('-i')+1],'/run/cop-clean-reset-comm/id_ed25519')
 def test_bad_temporary_identity_never_falls_back(self):
  with patch.object(m,'temporary_comm_identity',side_effect=RuntimeError('TEST_EXPIRED')):
   with self.assertRaisesRegex(RuntimeError,'EXPIRED'):m.transport_args('comm.home.cz')
 def test_storage_does_not_consult_temporary_identity(self):
  with patch.object(m,'temporary_comm_identity',side_effect=AssertionError('NO_COMM_KEY')):m.transport_args('storage.home.cz')
if __name__=='__main__':unittest.main()
