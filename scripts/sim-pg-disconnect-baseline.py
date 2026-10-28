#!/usr/bin/env python3
"""Read-only baseline. NO build/upload/activation or controller substitution.

Run on docker.home.cz: python3 sim-pg-disconnect-baseline.py --baseline
Output is bounded metadata/digests, never inspect/env/source file contents.
Exit 2 intentionally until the existing SIM maintain controller and protected
profile/marker/journal evidence are verified through its real interface.
"""
import hashlib
import copy
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys

NAME = 'csm-sim-api'
BASE = 'sha256:4076069b3f8c935c0cd07ea2bf95d92703270b72197ff2b74a27d1aee8c6bdf0'
LAYERS = ['/srv/sim/docker-compose.yml', '/srv/sim/docker-compose.x5.yml',
          '/srv/sim/docker-compose.driver-measurements.yml', '/srv/sim/docker-compose.clean-user-data.json']
FILES = {
    'apps/simulator-api/dist/user-data.js': 'bb34e391f98985da89dc5bedfb2352a0155d2a3e241c30f51d2b2491f8039749',
    'packages/sim-user-data/bootstrap.mjs': '3f51a4d243608e57953464fa751e5b1e346a80fc6664958ac3fdbfa69074f4ec',
    'packages/sim-user-data/authority.mjs': 'a0b3fd882baff5ee24401af035ff99134b8ea1f5cc362c88c909cb9bd67ad3d2',
    'packages/sim-user-data/ledger.mjs': '61a4dc6d62b45819274a271fdb36c90c92a6fa724e121af7a72c8db96481603b'}
SOURCE_PROBE = """const fs=require('fs'),crypto=require('crypto');const files=%s;
console.log(JSON.stringify({hashes:Object.fromEntries(files.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')])),newObserverAbsent:!fs.existsSync('packages/sim-user-data/pg-errors.mjs')}));""" % json.dumps(list(FILES))

class Stop(Exception):
    pass

def need(ok, code):
    if not ok:
        raise Stop(code)

def digest(value):
    raw = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(raw).hexdigest()

def run(args):
    try:
        return subprocess.check_output(args, timeout=30, stderr=subprocess.PIPE, text=True,
            env={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C','DOCKER_HOST':'unix:///var/run/docker.sock'})
    except (OSError, subprocess.SubprocessError):
        raise Stop('READ_COMMAND_FAILED_OUTPUT_WITHHELD') from None

def file_digest(path):
    p = Path(path)
    need(not any(x.is_symlink() for x in (p, *p.parents)), 'CONFIG_SYMLINK')
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= 4 * 1024 * 1024, 'CONFIG_CUSTODY')
        chunks, total = [], 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            total += len(chunk)
            need(total <= 4 * 1024 * 1024, 'CONFIG_SIZE')
            chunks.append(chunk)
        after = os.fstat(fd)
        need((before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
             (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
             and os.lstat(p).st_ino == before.st_ino, 'CONFIG_CHANGED_DURING_READ')
        return digest(b''.join(chunks))
    finally:
        os.close(fd)

def maintenance_runtime(value):
    result=copy.deepcopy({k:value.get(k) for k in ['Config','HostConfig','Mounts']})
    result['Config'].pop('Image',None)
    if result['Config'].get('Hostname')==value.get('Id','')[:12]:
        result['Config']['Hostname']='__docker_generated_hostname__'
    for key in ['com.docker.compose.config-hash','com.docker.compose.image']:
        result['Config'].get('Labels',{}).pop(key,None)
    pairs=[v.split('=',1) for v in result['Config'].get('Env') or []]
    need(all(len(v)==2 for v in pairs) and len({v[0] for v in pairs})==len(pairs),'ENV_STRUCTURE')
    result['Config']['Env']=dict(pairs)
    result['networks']={k:{'NetworkID':v.get('NetworkID'),'Aliases':v.get('Aliases')} for k,v in value.get('NetworkSettings',{}).get('Networks',{}).items()}
    return result

def inspect_facts(current, image, modules):
    need(current['Image'] == BASE and image['Id'] == BASE, 'BASE_IMAGE_CHANGED')
    labels = current['Config'].get('Labels') or {}
    need(labels.get('com.docker.compose.project.config_files', '').split(',') == LAYERS, 'COMPOSE_LAYERS_CHANGED')
    need(labels.get('com.docker.compose.service') == 'sim-api' and labels.get('com.docker.compose.project') == 'sim', 'SERVICE_CHANGED')
    need(modules['hashes'] == FILES and modules['newObserverAbsent'] is True, 'BASE_MODULE_CHANGED')
    env = {}
    for entry in current['Config'].get('Env') or []:
        key, sep, value = entry.partition('=')
        need(sep and key not in env, 'ENV_STRUCTURE')
        env[key] = value
    try:
        binding = json.loads(env['SIM_USER_DATA_CONTINUITY_BINDING'])
    except (KeyError, TypeError, ValueError):
        raise Stop('BINDING_UNAVAILABLE') from None
    need(binding.get('source_sha256') == FILES['packages/sim-user-data/authority.mjs'], 'SOURCE_BINDING_CHANGED')
    need(env.get('SIM_USER_DATA_ENABLED') == 'true' and env.get('SIM_USER_DATA_MODE') == 'production-sim-user-data-v1', 'MODE_CHANGED')
    return {
        'cid': current['Id'], 'image': current['Image'],
        'healthy': current['State'].get('Health', {}).get('Status') == 'healthy',
        'restartCount': current['RestartCount'],
        'startedAt': current['State'].get('StartedAt'),
        'moduleSha256': modules['hashes'],
        'runtimeConfigSha256': digest({k: current.get(k) for k in ['Config', 'HostConfig', 'Mounts', 'NetworkSettings']}),
        'maintenanceRuntimeSha256': hashlib.sha256((json.dumps(maintenance_runtime(current),sort_keys=True,separators=(',',':'))+'\n').encode()).hexdigest(),
        'imageConfigSha256': digest(image['Config']), 'imageLayerSha256': digest(image['RootFS']),
        'imageLayerCount': len(image['RootFS'].get('Layers', [])),
        'activeBindingSha256': digest(binding), 'authoritySourceMatches': True,
        # Do not confuse the app's configured binding with verified DB/controller
        # evidence. No authority is minted from this inspection.
        'configuredBindingIsDatabaseAcceptance': False,
        'controllerVerified': False, 'profileVerified': False,
        'markerJournalLineageVerified': False,
        'buildActivity': 'unknown_requires_build_owner_attestation',
    }

def stable_runtime(value):
    result = {k: value.get(k) for k in ['Id','Image','Config','HostConfig','Mounts','NetworkSettings','RestartCount']}
    state = value['State']
    result['state'] = {'startedAt':state.get('StartedAt'),'running':state.get('Running'),
                       'healthy':state.get('Health',{}).get('Status')}
    return result

def main():
    need(sys.argv[1:] == ['--baseline'], 'BASELINE_ONLY')
    need(socket.gethostname().split('.')[0] == 'docker', 'HOST_MISMATCH')
    current = json.loads(run(['docker', 'inspect', NAME]))[0]
    image = json.loads(run(['docker', 'image', 'inspect', BASE]))[0]
    modules = json.loads(run(['docker', 'exec', NAME, 'node', '-e', SOURCE_PROBE]))
    result = inspect_facts(current, image, modules)
    result['composeSha256'] = {p: file_digest(p) for p in LAYERS}
    dc=['docker','compose','--project-name','sim','--project-directory','/srv/sim','--env-file','/srv/sim/.env']
    for path in LAYERS:dc+=['-f',path]
    rendered=json.loads(run(dc+['config','--format','json']))
    result['maintenanceComposeSha256']=hashlib.sha256((json.dumps(rendered,sort_keys=True,separators=(',',':'))+'\n').encode()).hexdigest()
    result['capacity'] = {}
    for path in ['/srv/sim', '/srv/x5-production']:
        usage = shutil.disk_usage(path)
        result['capacity'][path] = {'availableBytes': usage.free, 'totalBytes': usage.total,
                                  'highPressure': usage.used / usage.total >= .9}
    result['x5UuidMatches'] = run(['findmnt', '-n', '-o', 'UUID', '--mountpoint', '/srv/x5-production']).strip() == '2f93f595-b61b-4eea-9054-7afa9b275b5b'
    # Detect any container/config/layer-file drift across the read window.
    after = json.loads(run(['docker', 'inspect', NAME]))[0]
    need(stable_runtime(after) == stable_runtime(current), 'RUNTIME_CHANGED_DURING_BASELINE')
    need({p: file_digest(p) for p in LAYERS} == result['composeSha256'], 'COMPOSE_CHANGED_DURING_BASELINE')
    result.update(contract='sim-pg-disconnect-readonly-baseline-v1', activationAllowed=False,
                  status='incomplete_not_release_authority',
                  missingEvidence=['ROOT_VERIFIED_SIM_MAINTAIN_CONTROLLER', 'PROTECTED_PROFILE_AND_MARKER_JOURNAL_LINEAGE', 'BUILD_OWNER_ACTIVITY_AND_CAPACITY_ADMISSION'])
    print(json.dumps(result, sort_keys=True))
    return 2

if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Stop, OSError, KeyError, TypeError, ValueError):
        print(json.dumps({'status': 'baseline_rejected', 'activationAllowed': False, 'code': 'BASELINE_FAILED_DETAILS_WITHHELD'}))
        sys.exit(2)
