"""Local synthetic planning checks only. Never starts Docker or a route engine."""
import json
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

class FixturePlanTests(unittest.TestCase):
    def generate(self, extended):
        with tempfile.TemporaryDirectory(prefix='sim-routing-time-') as d:
            args = ['python3', str(ROOT / 'scripts/generate-mapped-profile-test-pbf.py'), d]
            if extended:
                args.append('--routing-time-cases')
            summary = json.loads(subprocess.check_output(args))
            cases = json.loads((pathlib.Path(d) / 'cases.json').read_text())
            script = 'routing-time-engine-plan.mjs' if extended else 'mapped-profile-engine-plan.mjs'
            plan = json.loads(subprocess.check_output(['node', str(ROOT / 'scripts' / script), str(pathlib.Path(d) / 'cases.json')]))
            return summary, cases, plan

    def test_existing_default_unchanged(self):
        summary, cases, plan = self.generate(False)
        self.assertEqual(summary, {'synthetic': True, 'nodes': 56, 'ways': 40, 'cases': 8})
        self.assertEqual(len(plan), 52)

    def test_bounded_plan_preserves_protections(self):
        summary, fixtures, plan = self.generate(True)
        self.assertEqual(summary['cases'], 18)
        self.assertEqual(len(plan['cases']), 160)
        self.assertFalse(plan['engineExecutionAuthorized'])
        self.assertFalse(plan['productionAcceptance'])
        self.assertEqual(len({c['name'] for c in plan['cases']}), 160)
        for c in plan['cases']:
            self.assertEqual(c['request']['costing'], 'auto')
            for key, value in c['request']['costing_options']['auto'].items():
                if key.startswith('ignore_'):
                    self.assertFalse(value)
            if c['fixture'].endswith('_height') and '-3-' in c['name']:
                self.assertTrue(c['forbiddenRestrictedWay'])
            if c['requestedMode'] == 'none':
                self.assertNotIn('date_time', c['request'])
            if c['requestedMode'] == 'depart_now':
                self.assertEqual(c['request']['date_time'], {'type': 0})
        time_fixtures = [f for f in fixtures if f['name'].startswith('time_')]
        self.assertTrue(all(f['requiresImportInspection'] for f in time_fixtures))

    def test_missing_extended_fixture_rejected(self):
        with tempfile.TemporaryDirectory(prefix='sim-routing-time-') as d:
            p = pathlib.Path(d) / 'cases.json'
            p.write_text('[]')
            result = subprocess.run(['node', str(ROOT / 'scripts/routing-time-engine-plan.mjs'), str(p)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)

if __name__ == '__main__':
    unittest.main()
