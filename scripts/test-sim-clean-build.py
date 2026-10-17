"""Pure guard tests; not an actual server build or Root acceptance."""
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('sim_build', Path(__file__).with_name('prepare-sim-clean-build.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Guards(unittest.TestCase):
    def public(self, extra='', omit=None):
        return '\n'.join(k+'='+v for k,v in m.PUBLIC_WEB.items() if k != omit)+'\n'+extra

    def test_public_config_preserved(self):
        with patch('builtins.open', return_value=io.StringIO(self.public('IGNORED_SECRET=synthetic-only\n'))):
            value=m.public_web_args()
        self.assertEqual(value['SIM_WEB_MODE'],'hybrid')
        self.assertNotIn('IGNORED_SECRET',value)

    def test_public_config_changed(self):
        text=self.public().replace('VITE_SIM_AUTH_MODE=hybrid','VITE_SIM_AUTH_MODE=token')
        with patch('builtins.open',return_value=io.StringIO(text)),self.assertRaisesRegex(RuntimeError,'PUBLIC_CONFIG_CHANGED'):
            m.public_web_args()

    def test_public_duplicate(self):
        with patch('builtins.open',return_value=io.StringIO(self.public('VITE_SIM_AUTH_MODE=hybrid\n'))),self.assertRaisesRegex(RuntimeError,'DUPLICATE'):
            m.public_web_args()

    def test_public_missing(self):
        with patch('builtins.open',return_value=io.StringIO(self.public(omit='VITE_SIM_AUTH_MODE'))),self.assertRaisesRegex(RuntimeError,'MISSING'):
            m.public_web_args()

    def fixtures(self):
        return ({'Driver':'local','Options':{'type':'none','o':'bind','device':str(m.STATE)}},
                {'Image':m.BUILD_ID,'HostConfig':{'RestartPolicy':{'Name':'no'},'PortBindings':{}},'State':{'Running':True},
                 'Mounts':[{'Destination':'/var/lib/buildkit','Name':m.VOLUME}]},
                {'Name':m.BUILDER,'Driver':'docker-container','Nodes':[{'Name':'sim-x50','Endpoint':'unix:///var/run/docker.sock'}]})

    def verify(self, values):
        volume,node,config=values
        with patch.object(m,'docker',side_effect=[json.dumps([volume]).encode(),json.dumps([node]).encode(),b'2065\n']),patch.object(m,'run',return_value=json.dumps(config).encode()),patch.object(m.os,'stat',return_value=type('Stat',(),{'st_dev':2065})()):
            m.builder_check()

    def test_exact_builder(self):
        self.verify(self.fixtures())

    def test_internal_volume_denied(self):
        f=self.fixtures();f[0]['Options']['device']='/var/lib/docker/buildkit'
        with self.assertRaisesRegex(RuntimeError,'NOT_X5'):
            self.verify(f)

    def test_other_image_denied(self):
        f=self.fixtures();f[1]['Image']='sha256:'+'0'*64
        with self.assertRaisesRegex(RuntimeError,'NODE_DRIFT'):
            self.verify(f)

    def test_remote_builder_denied(self):
        f=self.fixtures();f[2]['Nodes'][0]['Endpoint']='tcp://unreviewed.invalid:1234'
        with self.assertRaisesRegex(RuntimeError,'CONFIG'):
            self.verify(f)

if __name__=='__main__':
    unittest.main()
