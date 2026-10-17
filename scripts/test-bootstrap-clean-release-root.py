"""Local synthetic archive tests only; never invokes Root/Docker/SSH."""
import importlib.util,io,pathlib,subprocess,tarfile,tempfile,unittest
from unittest.mock import patch
p=pathlib.Path(__file__).parent/'bootstrap-clean-release-root.py'
s=importlib.util.spec_from_file_location('bootstrap',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Bootstrap(unittest.TestCase):
 def test_public_peer_helper_executes_only_verified_bytes(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp')as d:
   p=pathlib.Path(d)/'helper.py';raw=b'value = "synthetic"\nif __name__ == "__main__": raise RuntimeError("NO_PREPARE")\n';p.write_bytes(raw)
   with patch.object(m,'PEER_HELPER',p),patch.object(m,'PEER_HELPER_SHA',__import__('hashlib').sha256(raw).hexdigest()):
    self.assertEqual(m.verified_release_peer_helper().value,'synthetic')
    p.write_bytes(raw+b'# changed\n')
    with self.assertRaisesRegex(RuntimeError,'HELPER_SHA'):m.verified_release_peer_helper()
 def test_peer_branch_is_explicit_fixed_host_and_key_only(self):
  def peer(host):return {'identityFile':'/run/cop-clean-reset-comm/id_ed25519','host':host}
  with patch.object(m,'release_peer_identity',side_effect=peer),patch.object(m,'temporary_comm_identity',side_effect=AssertionError('NO_LEGACY_FALLBACK')):
   for host in ['comm.home.cz','storage.home.cz']:
    a=m.transport_args(host);self.assertIn('BatchMode=yes',a);self.assertIn('PasswordAuthentication=no',a);self.assertIn('PreferredAuthentications=publickey',a);self.assertIn('IdentitiesOnly=yes',a);self.assertNotIn('PreferredAuthentications=password',a)
 def test_invalid_peer_never_falls_back_to_password(self):
  with patch.object(m,'release_peer_identity',side_effect=RuntimeError('ROOT_RELEASE_PEER_IDENTITY_UNPROVEN')):
   with self.assertRaisesRegex(RuntimeError,'PEER_IDENTITY'):m.transport_args('storage.home.cz')
 def test_peer_preflight_never_opens_tty(self):
  with patch.object(m,'release_peer_identity',side_effect=lambda host:{'host':host,'identityFile':'/run/cop-clean-reset-comm/id_ed25519'}),patch('builtins.open',side_effect=AssertionError('NO_PASSWORD_TTY')),patch.object(m.subprocess,'run',return_value=__import__('types').SimpleNamespace(returncode=0,stdout=b'0\n'))as run:
   m.check_transports();self.assertEqual(run.call_count,2)
 def test_peer_receipt_wrong_scope_key_or_host_refused(self):
  good={'host':'storage.home.cz','identityFile':'/run/cop-clean-reset-comm/id_ed25519','fingerprint':'SHA256:synthetic','authorizedLineSha256':'a'*64,'expiresAt':'synthetic'}
  for update in [{'host':'other.home.cz'},{'identityFile':'/tmp/arbitrary-key'},{'authorizedLineSha256':'bad'},{'extra':'not-permitted'}]:
   v={**good,**update}
   with patch.object(m.os.path,'lexists',return_value=True),patch.object(m,'verified_release_peer_helper',return_value=__import__('types').SimpleNamespace(identity_for_peer=lambda *a,**kw:v)):
    with self.assertRaisesRegex(RuntimeError,'IDENTITY_SCOPE'):m.release_peer_identity('storage.home.cz')
 def test_derived_key_accepts_only_optional_exact_comment(self):
  expected='ssh-ed25519 SYNTHETIC cop-clean-release-test'
  for actual in ['ssh-ed25519 SYNTHETIC',expected]:m.validate_derived_public(actual,expected,'cop-clean-release-test')
  for actual in ['ssh-ed25519 OTHER','ssh-rsa SYNTHETIC','ssh-ed25519 SYNTHETIC wrong','ssh-ed25519 SYNTHETIC cop-clean-release-test extra']:
   with self.assertRaisesRegex(RuntimeError,'KEY_PAIR'):m.validate_derived_public(actual,expected,'cop-clean-release-test')
 def test_real_openssh_public_derivation_with_comment(self):
  # A new disposable synthetic key, not a server identity or existing secret.
  with tempfile.TemporaryDirectory(dir='/private/tmp',prefix='sim-synthetic-ssh-regression-')as d:
   key=pathlib.Path(d)/'synthetic';marker='cop-clean-release-00000000-0000-4000-8000-000000000000'
   subprocess.run(['/usr/bin/ssh-keygen','-q','-t','ed25519','-N','','-C',marker,'-f',str(key)],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)
   actual=subprocess.check_output(['/usr/bin/ssh-keygen','-y','-f',str(key)],stdin=subprocess.DEVNULL,stderr=subprocess.PIPE).decode().strip()
   expected=key.with_suffix('.pub').read_text().strip()
   self.assertEqual(len(actual.split()),3);self.assertEqual(actual.split()[2],marker)
   m.validate_derived_public(actual,expected,marker)
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
