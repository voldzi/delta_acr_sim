#!/usr/bin/env python3
"""Narrow root activation; no secret output, full configuration parity and rollback."""
import copy
import hashlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time

STAGE = Path('/srv/sim/.arrival-20261023')
EXPECTED_IMAGE = 'sha256:9f0a6d789116cad19d363e79e9c8e5963861106e10ecd9c281e9f864c1d2c124'
for name, digest in {
    'install-reviewed-routing-performance.py': '0fd40ed9873b218f6e6027956122daaee875f047694e00317443b0393068781b',
    'accept-live-arrival.mjs': '299420f89c21ae38d5e74f54d3da767d421ec4128052895f10654fd7ee893e6a'
}.items():
    path = STAGE / name
    if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise RuntimeError('DEPENDENCY_HASH_MISMATCH')
spec = importlib.util.spec_from_file_location('support', STAGE / 'install-reviewed-routing-performance.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
OLD = 'sha256:a28bf8dc020963a723c1307980e0c408ab0e359420b4b05462a4549bdb943bfb'
OVERRIDES = {}
NAME = 'csm-sim-situation-data-api'

def run(args):
    try:
        return subprocess.check_output(args, cwd='/srv/sim', env=s.COMPOSE_ENV,
            stderr=subprocess.PIPE, text=True, timeout=120)
    except subprocess.SubprocessError:
        raise RuntimeError('COMMAND_FAILED_OUTPUT_WITHHELD') from None

def inspect(): return json.loads(run(['docker', 'inspect', NAME]))[0]

def healthy(image):
    for _ in range(90):
        v = inspect()
        if v['Image'] != image: raise RuntimeError('IMAGE_MISMATCH')
        if v['State'].get('Health', {}).get('Status') == 'healthy': return v
        if v['State'].get('OOMKilled') or v.get('RestartCount', 0): break
        time.sleep(1)
    raise RuntimeError('READINESS_FAILED')

def accept():
    script = (STAGE / 'accept-live-arrival.mjs').read_text()
    return json.loads(run(['docker', 'exec', NAME, 'node', '--input-type=module', '-e', script]))

def main():
    if os.geteuid() != 0: raise RuntimeError('ROOT_OPERATOR_REQUIRED')
    lock = os.open(STAGE / '.install.lock', os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    private = STAGE / 'root-rollback'
    if private.exists(): raise RuntimeError('PREVIOUS_ATTEMPT_REQUIRES_REVIEW')
    original = s.PIN.read_bytes()
    pin = json.loads(original)
    if pin['services']['situation-data-api']['image'] != OLD: raise RuntimeError('BASELINE_PIN_CHANGED')
    s.COMPOSE_ENV = s.reviewed_compose_environment(pin)
    before = inspect()
    if before['Image'] != OLD or before['State'].get('Health', {}).get('Status') != 'healthy':
        raise RuntimeError('BASELINE_NOT_HEALTHY')
    new = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', 'sim-user-arrival:dd3a75b']).strip()
    if new != EXPECTED_IMAGE: raise RuntimeError('CANDIDATE_CHANGED')
    compose = json.loads(run(s.DC + ['config', '--format', 'json']))
    private.mkdir(mode=0o700)
    backup = private / 'pin.json'
    backup.write_bytes(original)
    backup.chmod(0o600)
    changed = copy.deepcopy(pin)
    target = changed['services']['situation-data-api']
    target['image'] = new
    target.setdefault('environment', {}).update(OVERRIDES)
    committed = False
    receipt = {'candidate': new, 'phase': 'compose-parity'}
    try:
        s.replace_pin((json.dumps(changed, indent=2) + '\n').encode())
        after = json.loads(run(s.DC + ['config', '--format', 'json']))
        expected = copy.deepcopy(compose)
        expected['services']['situation-data-api']['image'] = new
        expected['services']['situation-data-api']['environment'].update(OVERRIDES)
        if after != expected: raise RuntimeError('COMPOSE_PARITY_FAILED')
        receipt['phase'] = 'candidate-start'
        run(s.DC + ['up', '-d', '--no-deps', '--no-build', 'situation-data-api'])
        current = healthy(new)
        expected_runtime = copy.deepcopy(before)
        env = s.environment_map(before['Config']['Env'])
        env.update(OVERRIDES)
        expected_runtime['Config']['Env'] = [k + '=' + v for k, v in env.items()]
        if s.runtime_differences(expected_runtime, current) or before['Config'].get('Healthcheck') != current['Config'].get('Healthcheck'):
            raise RuntimeError('RUNTIME_PARITY_FAILED')
        receipt['phase'] = 'live-arrival-acceptance'
        receipt['realData'] = accept()
        if not receipt['realData'].get('verified'): raise RuntimeError('LIVE_ACCEPTANCE_FAILED')
        committed = True
        receipt['phase'] = 'complete'
    finally:
        if not committed:
            receipt['diagnostics'] = s.safe_startup_diagnostics(NAME)
            s.replace_pin(original)
            run(s.DC + ['up', '-d', '--no-deps', '--no-build', 'situation-data-api'])
            restored = healthy(OLD)
            receipt['rollbackVerified'] = not s.runtime_differences(before, restored) and before['Config'].get('Healthcheck') == restored['Config'].get('Healthcheck') and s.PIN.read_bytes() == original
        receipt['committed'] = committed
        path = STAGE / 'result.json'
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, 'w') as out: json.dump(receipt, out)
        print(json.dumps(receipt))

if __name__ == '__main__': main()
