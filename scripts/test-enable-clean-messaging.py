"""Synthetic boundary checks only; no remote process, production or secrets."""
import copy,importlib.util,json,pathlib,types,unittest
from unittest.mock import patch
p=pathlib.Path(__file__).parent/'lib/enable-clean-messaging.py'
s=importlib.util.spec_from_file_location('message_enable',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
IMAGES={'messaging_api':'sha256:'+'a'*64,'synapse':'sha256:'+'b'*64}
def receipt():return {'contractVersion':'cop-messaging-disabled-runtime-result-v1','runtimeReady':True,'erasureEnabled':False,'oldImageFallback':False,'containerBindings':{'csm-messaging-api':{'id':'c'*64,'image':IMAGES['messaging_api']},'csm-matrix-synapse':{'id':'d'*64,'image':IMAGES['synapse']}}}
class Boundaries(unittest.TestCase):
 def test_disabled_candidate_binding(self):self.assertEqual(len(m.validate_disabled(receipt(),IMAGES)),2)
 def test_refuse_wrong_or_enabled_candidate(self):
  for mutate in [lambda r:r.update(erasureEnabled=True),lambda r:r.update(runtimeReady=False),lambda r:r.update(oldImageFallback=True),lambda r:r['containerBindings']['csm-messaging-api'].update(image='sha256:'+'e'*64),lambda r:r['containerBindings'].pop('csm-matrix-synapse')]:
   r=receipt();mutate(r)
   with self.assertRaises(RuntimeError):m.validate_disabled(r,IMAGES)
 def test_remote_program_inert_and_compiles(self):
  compile(m.REMOTE_PROGRAM,'remote','exec')
  self.assertIn('AccountErasureAcceptance.verify()',m.REMOTE_PROGRAM)
  self.assertIn("'--no-deps','--no-build','--pull','never','api'",m.REMOTE_PROGRAM)
  self.assertNotIn('docker system prune',m.REMOTE_PROGRAM)
 def test_only_four_exact_flags(self):
  self.assertEqual(len(m.FLAGS),4)
  self.assertNotIn('CSM_COMMUNICATION_SAFETY_ENABLED',m.FLAGS)
  self.assertNotIn('CSM_APP_DEVICE_LEDGER_ENABLED',m.FLAGS)
 def test_failure_response_not_accepted(self):
  class Remote:
   def run(self,*a,**k):return b'{"code":"MESSAGING_ENABLE_FAILED"}'
  with patch.object(m.os,'getuid',return_value=0),patch.object(m.socket,'gethostname',return_value='docker'):
   with self.assertRaises(RuntimeError):m.enable_messaging(types.SimpleNamespace(CommunicationResetTransport=Remote),Remote(),receipt(),IMAGES)
 def test_arbitrary_transport_rejected_before_call(self):
  with patch.object(m.os,'getuid',return_value=0),patch.object(m.socket,'gethostname',return_value='docker'):
   with self.assertRaises(RuntimeError):m.enable_messaging(types.SimpleNamespace(CommunicationResetTransport=type('Expected',(),{})),object(),receipt(),IMAGES)
if __name__=='__main__':unittest.main()
