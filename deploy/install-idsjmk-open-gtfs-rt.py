#!/usr/bin/env python3
"""Narrow root activation; no secret output, full configuration parity and rollback."""
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time

STAGE = Path('/srv/sim/.idsjmk-gtfs-rt-20261021')
spec = importlib.util.spec_from_file_location('support', STAGE / 'install-reviewed-routing-performance.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
OLD = 'sha256:b51f7dbce0407c498d7ba1dea69b6cd481be5fd44eb54ac70a14c66d852bfe04'
OVERRIDES = {'IDSJMK_VEHICLE_POSITIONS_URL': 'https://kordis-jmk.cz/gtfs/gtfsReal.dat',
             'SITUATION_DATA_IDSJMK_CACHE_TTL_SECONDS': '30'}
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
    # No public ports or provider-direct clients: exercise ordinary map API.
    script = """const r=await fetch('http://127.0.0.1:4020/api/v1/features?bbox=16.4,49.0,16.9,49.4&source=idsjmk_vehicle_positions&layers=traffic&limit=100');
if(!r.ok)process.exit(2);const b=await r.json();const f=b.features||b.data?.features||[];
const fresh=f.filter(x=>!x.properties.stale&&x.properties.tags?.livePosition==='true');
console.log(JSON.stringify({http:r.status,count:f.length,fresh:fresh.length}));if(!fresh.length)process.exit(3);"""
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
    new = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', 'sim-idsjmk-open-gtfs-rt:20261021']).strip()
    if new != (STAGE / 'candidate-image.txt').read_text().strip(): raise RuntimeError('CANDIDATE_CHANGED')
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
    receipt = {'candidate': new}
    try:
        s.replace_pin((json.dumps(changed, indent=2) + '\n').encode())
        after = json.loads(run(s.DC + ['config', '--format', 'json']))
        expected = copy.deepcopy(compose)
        expected['services']['situation-data-api']['image'] = new
        expected['services']['situation-data-api']['environment'].update(OVERRIDES)
        if after != expected: raise RuntimeError('COMPOSE_PARITY_FAILED')
        run(s.DC + ['up', '-d', '--no-deps', '--no-build', 'situation-data-api'])
        current = healthy(new)
        expected_runtime = copy.deepcopy(before)
        env = s.environment_map(before['Config']['Env'])
        env.update(OVERRIDES)
        expected_runtime['Config']['Env'] = [k + '=' + v for k, v in env.items()]
        if s.runtime_differences(expected_runtime, current) or before['Config'].get('Healthcheck') != current['Config'].get('Healthcheck'):
            raise RuntimeError('RUNTIME_PARITY_FAILED')
        receipt['realData'] = accept()
        committed = True
    finally:
        if not committed:
            receipt['diagnostics'] = s.safe_startup_diagnostics(NAME)
            s.replace_pin(original)
            run(s.DC + ['up', '-d', '--no-deps', '--no-build', 'situation-data-api'])
            restored = healthy(OLD)
            receipt['rollbackVerified'] = not s.runtime_differences(before, restored) and s.PIN.read_bytes() == original
        receipt['committed'] = committed
        path = STAGE / 'result.json'
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, 'w') as out: json.dump(receipt, out)
        print(json.dumps(receipt))

if __name__ == '__main__': main()
