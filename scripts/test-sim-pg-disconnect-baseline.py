import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout
from io import StringIO
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('baseline', Path(__file__).with_name('sim-pg-disconnect-baseline.py'))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

class BaselineTests(unittest.TestCase):
    def fixture(self):
        binding = {'source_sha256': b.FILES['packages/sim-user-data/authority.mjs']}
        current = {'Id':'synthetic-cid','Image':b.BASE,'Config':{'Labels':{
            'com.docker.compose.project.config_files':','.join(b.LAYERS),
            'com.docker.compose.project.environment_file':'/srv/sim/.env','com.docker.compose.replace':'csm-sim-api','com.docker.compose.version':'5.6.0',
            'com.docker.compose.service':'sim-api','com.docker.compose.project':'sim'},
            'Env':['PRIVATE_SECRET=never-export-this','SIM_USER_DATA_ENABLED=true','SIM_USER_DATA_MODE=production-sim-user-data-v1',
                   'SIM_USER_DATA_CONTINUITY_BINDING='+json.dumps(binding)]},
            'State':{'Health':{'Status':'healthy'}},'RestartCount':1}
        image={'Id':b.BASE,'Config':{},'RootFS':{'Layers':['synthetic-layer']}}
        return current,image,{'hashes':copy.deepcopy(b.FILES),'newObserverAbsent':True}

    def test_output_is_not_authority_or_secret(self):
        result=b.inspect_facts(*self.fixture())
        self.assertFalse(result['controllerVerified'])
        self.assertFalse(result['markerJournalLineageVerified'])
        self.assertNotIn('never-export-this',json.dumps(result))
        self.assertNotIn('PRIVATE_SECRET',json.dumps(result))

    def test_drift_refused(self):
        for field in ['image','layers','module','mode','binding','duplicates']:
            c,i,m=self.fixture()
            if field=='image':c['Image']='different'
            if field=='layers':c['Config']['Labels']['com.docker.compose.project.config_files']='different'
            if field=='module':m['hashes']['apps/simulator-api/dist/user-data.js']='different'
            if field=='mode':c['Config']['Env'][1]='SIM_USER_DATA_ENABLED=false'
            if field=='binding':c['Config']['Env'][-1]='SIM_USER_DATA_CONTINUITY_BINDING={}'
            if field=='duplicates':c['Config']['Env'].append('SIM_USER_DATA_ENABLED=true')
            with self.subTest(field=field),self.assertRaises(b.Stop):b.inspect_facts(c,i,m)

    def test_whole_baseline_denies_and_runs_no_mutating_command(self):
        c,i,m=self.fixture();calls=[]
        def run(args):
            calls.append(args)
            if args[:2]==['docker','inspect']:return json.dumps([c])
            if args[:3]==['docker','image','inspect']:return json.dumps([i])
            if args[:2]==['docker','exec']:return json.dumps(m)
            if args[:2]==['docker','compose']:return json.dumps({'services':{'sim-api':{'image':b.BASE}}})
            if args[0]=='findmnt':return '2f93f595-b61b-4eea-9054-7afa9b275b5b'
            self.fail('Unexpected command')
        out=StringIO()
        with patch.object(b.sys,'argv',['helper','--baseline']),patch.object(b.socket,'gethostname',return_value='docker'),\
             patch.object(b,'run',side_effect=run),patch.object(b,'file_digest',return_value='digest'),\
             patch.object(b.shutil,'disk_usage',return_value=SimpleNamespace(total=100,used=96,free=4)),redirect_stdout(out):
            self.assertEqual(b.main(),2)
        result=json.loads(out.getvalue());self.assertFalse(result['activationAllowed'])
        self.assertIn('ROOT_VERIFIED_SIM_MAINTAIN_CONTROLLER',result['missingEvidence'])
        self.assertNotIn('never-export-this',out.getvalue())
        self.assertFalse(any(x in ['up','build','run','cp','restart','rm','prune'] for args in calls for x in args))

if __name__=='__main__':unittest.main()
