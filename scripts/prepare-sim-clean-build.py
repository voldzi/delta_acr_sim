#!/usr/bin/env python3
"""Fixed build-only SIM candidate. No .env, database, app restart or prune.
Root runs --prepare once; voldzi runs --build-only. Context/state/logs on X5;
image load uses the unchanged Docker image store.
"""
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import time
sys.dont_write_bytecode = True
REV = 'a337cfc1aa3dc8ef3fd49a84b6e2fb94a651ee4d'
AUTHORITY = 'a0b3fd882baff5ee24401af035ff99134b8ea1f5cc362c88c909cb9bd67ad3d2'
BASE = Path('/srv/x5-production/cache/csm-sim/build')
SOURCE = BASE / 'source-a337cfc'
STATE = BASE / 'buildkit'
BUILDER = 'sim-x5'
VOLUME = 'buildx_buildkit_sim-x50_state'
CONTAINER = 'buildx_buildkit_sim-x50'
BUILD_IMAGE = 'moby/buildkit@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea'
BUILD_ID = 'sha256:27933730df224df80c41f4e5a9b33fa78831a79fd31903df3bb7deb49363422f'
UUID = '2f93f595-b61b-4eea-9054-7afa9b275b5b'
SERVICES = {'simulator-api': 'apps/simulator-api/Dockerfile', 'ai-router-api': 'apps/ai-router-api/Dockerfile',
            'situation-data-api': 'apps/situation-data-api/Dockerfile', 'simulator-web': 'apps/simulator-web/Dockerfile'}
WRITERS = ['csm-sim-api', 'csm-sim-ai-router-api', 'csm-sim-situation-data-api', 'csm-sim-web']
PUBLIC_WEB = {'VITE_COP_DISPLAY_URL': 'https://cop.zeleznalady.cz', 'VITE_SIM_AUTH_MODE': 'hybrid',
              'VITE_SIM_OIDC_ISSUER': 'https://login.zeleznalady.cz/realms/cop', 'VITE_SIM_OIDC_CLIENT_ID': 'csm-sim-web',
              'VITE_SIM_OIDC_SCOPE': 'openid profile email', 'VITE_SIM_PUBLIC_READ_ENABLED': 'false', 'VITE_SIM_ALLOW_TOKEN_LOGIN': 'false'}
ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/home/voldzi',
       'LANG': 'C', 'DOCKER_HOST': 'unix:///var/run/docker.sock', 'GIT_OPTIONAL_LOCKS': '0',
       'GIT_SSH_COMMAND': 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes', 'BUILDX_BUILDER': BUILDER}

def need(value, code):
    if not value:
        raise RuntimeError(code)

def run(args, *, user=False, timeout=60):
    if user and os.getuid() == 0:
        args = ['/usr/sbin/runuser', '-u', 'voldzi', '--', *args]
    r = subprocess.run(args, capture_output=True, env=ENV, timeout=timeout, check=False)
    need(r.returncode == 0, 'SIM_BUILD_COMMAND_FAILED')
    return r.stdout

def docker(*args):
    return run(['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', *args])

def layout():
    need(socket.gethostname().split('.')[0] == 'docker', 'SIM_BUILD_HOST')
    mount = Path('/srv/x5-production')
    need(run(['/usr/bin/findmnt', '-n', '-o', 'UUID', '--mountpoint', str(mount)]).decode().strip() == UUID,
         'SIM_BUILD_X5_UUID')
    need(mount.resolve() == mount and mount.stat().st_dev != Path('/').stat().st_dev, 'SIM_BUILD_SEPARATE_DEVICE')
    fs = os.statvfs(mount)
    need(fs.f_bavail * fs.f_frsize >= 8 * 1024 ** 3, 'SIM_BUILD_X5_HEADROOM')
    p = mount
    for part in ['cache', 'csm-sim']:
        p /= part
        need(p.is_dir() and not p.is_symlink() and p.resolve() == p and p.stat().st_dev == mount.stat().st_dev, 'SIM_BUILD_PARENT')

def git(*args):
    return run(['/usr/bin/git', '-c', 'safe.directory=' + str(SOURCE), '-c', 'core.fsmonitor=false',
                '-c', 'core.hooksPath=/dev/null', '-C', str(SOURCE), *args])

def source_check():
    need(SOURCE.resolve() == SOURCE and (SOURCE / '.git').is_dir(), 'SIM_BUILD_SOURCE')
    need(git('rev-parse', 'HEAD').decode().strip() == REV and git('rev-parse', '--abbrev-ref', 'HEAD').strip() == b'HEAD',
         'SIM_BUILD_REVISION')
    need(not git('status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'), 'SIM_BUILD_SOURCE_DIRTY')
    actual = set()
    for directory, dirs, files in os.walk(SOURCE, followlinks=False):
        for p in [Path(directory), *[Path(directory) / x for x in dirs + files]]:
            s = p.lstat()
            need(not stat.S_ISLNK(s.st_mode) and (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode))
                 and s.st_uid == 0 and not stat.S_IMODE(s.st_mode) & 0o222
                 and s.st_dev == BASE.stat().st_dev and (not stat.S_ISREG(s.st_mode) or s.st_nlink == 1), 'SIM_BUILD_SOURCE_CUSTODY')
            if p.is_file() and SOURCE / '.git' not in p.parents:
                actual.add(os.fsencode(p.relative_to(SOURCE)))
    tracked = set()
    for row in git('ls-tree', '-rz', 'HEAD').split(b'\0'):
        if not row:
            continue
        meta, name = row.split(b'\t', 1)
        mode, kind, blob = meta.split()
        need(kind == b'blob' and mode in (b'100644', b'100755'), 'SIM_BUILD_SOURCE_KIND')
        p = SOURCE / os.fsdecode(name)
        raw = p.read_bytes()
        need(hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest().encode() == blob,
             'SIM_BUILD_SOURCE_BYTES')
        tracked.add(name)
    need(actual == tracked, 'SIM_BUILD_UNTRACKED_BYTES')

def builder_check():
    volume = json.loads(docker('volume', 'inspect', VOLUME))[0]
    need(volume['Driver'] == 'local' and volume['Options'] == {'type': 'none', 'o': 'bind', 'device': str(STATE)},
         'SIM_BUILD_VOLUME_NOT_X5')
    node = json.loads(docker('inspect', CONTAINER))[0]
    need(node['Image'] == BUILD_ID and node['HostConfig']['RestartPolicy']['Name'] == 'no'
         and node['State']['Running'] is True and not node['HostConfig']['PortBindings'], 'SIM_BUILD_NODE_DRIFT')
    mounts = [x for x in node['Mounts'] if x['Destination'] == '/var/lib/buildkit']
    need(len(mounts) == 1 and mounts[0].get('Name') == VOLUME, 'SIM_BUILD_STATE_MOUNT')
    # This installed Buildx supports JSON on ls, not inspect. Some releases
    # render the same builder once per table row; duplicates must be identical.
    records = [json.loads(line) for line in run(['/usr/bin/docker', 'buildx', 'ls', '--format', '{{json .}}'], user=True).decode().splitlines() if line.strip()]
    records = [item for item in records if item.get('Name') == BUILDER]
    need(records and all(item == records[0] for item in records), 'SIM_BUILD_CONFIG_AMBIGUOUS')
    config = records[0]
    need(config['Name'] == BUILDER and config['Driver'] == 'docker-container'
         and len(config['Nodes']) == 1 and config['Nodes'][0]['Name'] == 'sim-x50'
         and config['Nodes'][0]['Endpoint'] == 'unix:///var/run/docker.sock', 'SIM_BUILD_CONFIG')
    actual_device = int(docker('exec', CONTAINER, 'stat', '-c', '%d', '/var/lib/buildkit').decode().strip())
    need(actual_device == os.stat(STATE).st_dev, 'SIM_BUILD_ACTUAL_CACHE_NOT_X5')

def public_web_args():
    values = dict(PUBLIC_WEB)
    seen = set()
    with open('/srv/sim/.env', encoding='utf8') as handle:
        for line in handle:
            key, sep, value = line.partition('=')
            if sep and key in PUBLIC_WEB:
                need(key not in seen, 'SIM_BUILD_DUPLICATE_PUBLIC_CONFIG')
                seen.add(key)
                values[key] = value.strip().strip('\"\'')
    need(set(PUBLIC_WEB) - {'VITE_COP_DISPLAY_URL'} <= seen, 'SIM_BUILD_PUBLIC_CONFIG_MISSING')
    need(values == PUBLIC_WEB, 'SIM_BUILD_PUBLIC_CONFIG_CHANGED')
    names = {'VITE_SIM_AUTH_MODE': 'SIM_WEB_MODE', 'VITE_SIM_ALLOW_TOKEN_LOGIN': 'SIM_WEB_ALLOW_MANUAL_LOGIN'}
    return {names.get(key, key): value for key, value in values.items()}

def running():
    result = json.loads(docker('inspect', *WRITERS))
    need(len(result) == 4 and all(x['State']['Running'] for x in result), 'SIM_BUILD_CURRENT_SERVICE_UNAVAILABLE')
    return [(x['Name'], x['Id'], x['Image'], x['State']['StartedAt']) for x in result]

def prepare():
    need(os.getuid() == 0, 'SIM_BUILD_ROOT_PREPARE_REQUIRED')
    layout()
    before = running()
    for path, uid, mode in [(BASE, 0, 0o755), (STATE, 0, 0o700), (BASE / 'logs', 1000, 0o700)]:
        if not path.exists():
            path.mkdir(mode=mode)
            os.chown(path, uid, uid)
        need(path.is_dir() and not path.is_symlink() and path.resolve() == path and path.stat().st_uid == uid
             and path.stat().st_dev == Path('/srv/x5-production').stat().st_dev,
             'SIM_BUILD_OWNED_PATH')
    if not SOURCE.exists():
        run(['/usr/bin/install', '-d', '-m', '0755', '-o', 'voldzi', '-g', 'voldzi', str(SOURCE)])
        run(['/usr/bin/git', 'clone', '--no-checkout', 'git@github-sim:voldzi/delta_acr_sim.git', str(SOURCE)], user=True, timeout=180)
        run(['/usr/bin/git', '-C', str(SOURCE), 'checkout', '--detach', REV], user=True)
        for directory, dirs, files in os.walk(SOURCE, followlinks=False):
            for p in [Path(directory), *[Path(directory) / x for x in dirs + files]]:
                s = p.lstat()
                need(not stat.S_ISLNK(s.st_mode) and (p.is_file() or p.is_dir()), 'SIM_BUILD_SOURCE_KIND')
                os.chown(p, 0, 0)
                os.chmod(p, stat.S_IMODE(s.st_mode) & ~0o222)
    source_check()
    need(json.loads(docker('image', 'inspect', BUILD_IMAGE))[0]['Id'] == BUILD_ID, 'SIM_BUILD_PINNED_ENGINE_MISSING')
    volumes = docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines()
    if VOLUME not in volumes:
        docker('volume', 'create', '--driver', 'local', '--opt', 'type=none', '--opt', 'o=bind', '--opt', 'device=' + str(STATE), VOLUME)
    volume = json.loads(docker('volume', 'inspect', VOLUME))[0]
    need(volume['Options'] == {'type': 'none', 'o': 'bind', 'device': str(STATE)}, 'SIM_BUILD_VOLUME_DRIFT')
    names = run(['/usr/bin/docker', 'buildx', 'ls', '--format', '{{.Name}}'], user=True).decode().splitlines()
    if BUILDER not in names:
        run(['/usr/bin/docker', 'buildx', 'create', '--name', BUILDER, '--driver', 'docker-container',
             '--driver-opt', 'image=' + BUILD_IMAGE, '--driver-opt', 'memory=3g', '--driver-opt', 'cpu-quota=200000',
             '--buildkitd-flags', '--oci-worker-gc --oci-worker-gc-keepstorage 10000', 'unix:///var/run/docker.sock'], user=True)
    run(['/usr/bin/docker', 'buildx', 'inspect', BUILDER, '--bootstrap'], user=True, timeout=120)
    node = json.loads(docker('inspect', CONTAINER))[0]
    need(node['Image'] == BUILD_ID, 'SIM_BUILD_ENGINE_DRIFT')
    docker('update', '--restart=no', CONTAINER)
    builder_check()
    need(running() == before, 'SIM_BUILD_SERVICE_CHANGED')
    print(json.dumps({'phase': 'sim_build_only_prepared', 'revision': REV, 'builder': BUILDER,
                      'context': str(SOURCE), 'applicationChanged': False, 'prune': False}), flush=True)

def build():
    need(os.getuid() == 1000, 'SIM_BUILD_VOLDZI_REQUIRED')
    layout(); source_check(); builder_check()
    web_args = public_web_args()
    before = running()
    images = {}
    for name, dockerfile in SERVICES.items():
        tag = 'csm-sim-clean/' + name + ':a337cfc'
        log = BASE / 'logs' / (name + '-a337cfc-' + str(time.time_ns()) + '.log')
        args = []
        if name == 'simulator-web':
            for key, value in web_args.items():
                args += ['--build-arg', key + '=' + value]
        with open(log, 'xb') as handle:
            os.chmod(log, 0o600)
            result = subprocess.run(['/usr/bin/docker', 'buildx', 'build', '--builder', BUILDER, '--platform', 'linux/amd64',
                                     '--load', '--progress', 'plain', '--label', 'org.opencontainers.image.revision=' + REV,
                                     '--file', str(SOURCE / dockerfile), '--tag', tag, *args, str(SOURCE)],
                                    stdout=handle, stderr=subprocess.STDOUT, env=ENV, timeout=3600, check=False)
        need(result.returncode == 0, 'SIM_BUILD_CANDIDATE_FAILED')
        source_check(); builder_check(); need(running() == before, 'SIM_BUILD_SERVICE_CHANGED'); need(public_web_args() == web_args, 'SIM_BUILD_PUBLIC_CONFIG_CHANGED')
        image = json.loads(docker('image', 'inspect', tag))[0]
        need(image['Config']['Labels'].get('org.opencontainers.image.revision') == REV, 'SIM_BUILD_IMAGE_REVISION')
        if name != 'simulator-web':
            probe = "if(process.versions.node.split('.')[0]!=='24')process.exit(2);"
            if name != 'situation-data-api':
                probe += "const f=require('fs'),c=require('crypto');if(c.createHash('sha256').update(f.readFileSync('/app/packages/sim-user-data/authority.mjs')).digest('hex')!=='" + AUTHORITY + "')process.exit(3);"
            else:
                probe += "import('/app/apps/situation-data-api/dist/sim-user-data-relay.js').then(m=>{if(typeof m.registerSimUserDataRelay!=='function')process.exit(4)}).catch(()=>process.exit(5));"
            run(['/usr/bin/docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                 '--entrypoint', 'node', image['Id'], '-e', probe])
        images[name] = image['Id']
        print(json.dumps({'phase': 'sim_candidate_built_only', 'service': name, 'image': image['Id'], 'revision': REV,
                          'applicationChanged': False, 'accountDeletionEnabled': False}), flush=True)
    need(running() == before, 'SIM_BUILD_SERVICE_CHANGED')
    print(json.dumps({'phase': 'sim_candidate_images_ready', 'revision': REV, 'images': images,
                      'applicationChanged': False, 'prune': False}), flush=True)

def main():
    need(len(sys.argv) == 2 and sys.argv[1] in ['--prepare', '--build-only']
         and not os.environ.get('PYTHONPATH') and not os.environ.get('PYTHONHOME'), 'SIM_BUILD_FIXED_OPERATION')
    prepare() if sys.argv[1] == '--prepare' else build()

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and str(error).startswith('SIM_BUILD_') else 'SIM_BUILD_FAILED'
        print(json.dumps({'phase': 'sim_build_not_complete', 'code': code, 'accountDeletionEnabled': False})); raise SystemExit(2)
