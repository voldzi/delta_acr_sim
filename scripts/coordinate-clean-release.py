"""Concrete common reset under COP's actual Root owner. No CLI or auto-start.
Caller supplies secrets in RAM. Missing actual whole12 acceptance refuses BEFORE
remote auth, producer freeze or writer stop. Never fabricates Root authority.
"""
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import stat
import uuid
from urllib.parse import quote

PLAN = Path('/srv/cop/runtime/clean-reset/plan.json')
COP_ROOT = Path('/srv/x5-production/staging/cop/clean-operator-2e61857/app')
SIM_ENV = Path('/srv/sim/.env')
OVERLAY = Path('/srv/sim/docker-compose.clean-user-data.json')
DEPLOY_GUARD = Path('/srv/sim/scripts/deploy-docker-home.sh')
OLD_DEPLOY_HASHES = {'86f75085dc89cf67626472b2b5c92efcd2b039ce3c1e273b44cc49ee7df3ce80',
                    'a5972c9ab17652912e7107fb937651c4da31393e17fb0d6ee971acdb467e7d5c'}
COMMON_PHASES = ('identity', 'cop', 'ai', 'driver', 'files', 'sim_app_files', 'sim_user_install', 'cop_safety_install')
MODE = 'production-clean-lifecycle-v1'

def need(value, code):
    if not value:
        raise RuntimeError(code)

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def protected(path, modes=(0o444, 0o555), limit=1048576):
    path = Path(path)
    need(path.is_absolute() and path.resolve() == path, 'COMMON_SOURCE_PATH')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == 0 and stat.S_IMODE(s.st_mode) in modes
             and s.st_size <= limit and path.parent.stat().st_uid == 0 and not path.parent.stat().st_mode & 0o022,
             'COMMON_SOURCE_CUSTODY')
        raw = os.read(fd, limit + 1)
        a = os.fstat(fd)
        need(len(raw) == s.st_size and (s.st_ino, s.st_mtime_ns, s.st_ctime_ns) == (a.st_ino, a.st_mtime_ns, a.st_ctime_ns), 'COMMON_SOURCE_CHANGED')
        return raw
    finally:
        os.close(fd)

def load_sealed(cop_source, relative, name):
    need(cop_source['root'] == str(COP_ROOT) and relative in cop_source['files'], 'COMMON_SOURCE_NOT_ENROLLED')
    path = COP_ROOT / relative
    need(digest(protected(path)) == cop_source['files'][relative], 'COMMON_SOURCE_HASH')
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def read_environment(path=SIM_ENV):
    need(path.resolve() == path and path.parent.is_dir() and not path.parent.stat().st_mode & 0o022, 'COMMON_ENV_PARENT')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid in {0, 1000, os.getuid()}
             and stat.S_IMODE(s.st_mode) == 0o600 and s.st_size <= 1048576, 'COMMON_ENV_CUSTODY')
        raw = os.read(fd, 1048577)
        a = os.fstat(fd)
        need(len(raw) == s.st_size and (s.st_ino, s.st_mtime_ns, s.st_ctime_ns) == (a.st_ino, a.st_mtime_ns, a.st_ctime_ns), 'COMMON_ENV_CHANGED')
        return raw, s
    finally:
        os.close(fd)

def selected_values(raw, keys):
    values = {}
    for line in raw.decode('utf8').splitlines():
        key, sep, value = line.partition('=')
        if sep and key in keys:
            need(key not in values, 'COMMON_ENV_DUPLICATE')
            value = value.strip()
            if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[key] = value
    return values

def disabled_runtime(config, current):
    """Only fixed SIM clean scopes. Existing provider/DB/OpenAI keys untouched."""
    s = config['simUserInstall']
    required = {'AI_ROUTER_COP_TOKEN', 'AI_ROUTER_COP_ACTOR_SECRET', 'AI_ROUTER_ACCOUNT_ERASURE_ISSUER',
                'AI_ROUTER_USER_HASH_SECRET', 'AI_ROUTER_SIM_TOKEN', 'DRIVER_MEASUREMENTS_COP_TOKEN',
                'DRIVER_MEASUREMENTS_HASH_SECRET', 'DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET',
                'DRIVER_ACCOUNT_ERASURE_ISSUER', 'SIM_OIDC_ISSUER', 'SIM_API_AUTH_MODE', 'SIM_PUBLISHER_MODE'}
    existing = selected_values(current, required)
    need(required <= set(existing) and all(len(existing[k]) >= 32 for k in required if k not in
         {'SIM_API_AUTH_MODE', 'SIM_PUBLISHER_MODE'}), 'COMMON_EXISTING_IDENTITY_MISSING')
    need(existing['SIM_API_AUTH_MODE'] in {'hybrid', 'oidc'} and existing['SIM_PUBLISHER_MODE'] == 'DRY_RUN', 'COMMON_SIM_RUNTIME_MODE')
    identity = s['identities']['sim_user_data']
    history = s['identities']['sim_user_history']
    need(existing['SIM_OIDC_ISSUER'] == identity['issuer'] == history['issuer']
         == existing['AI_ROUTER_ACCOUNT_ERASURE_ISSUER'] == existing['DRIVER_ACCOUNT_ERASURE_ISSUER'], 'COMMON_ISSUER_CHANGED')
    need(hmac.compare_digest(existing['AI_ROUTER_USER_HASH_SECRET'], history['hashSecret']), 'COMMON_ROUTER_HASH_CHANGED')
    fresh = [s['serviceToken'], identity['ownerSecret'], identity['actorSecret'], identity['routerActorSecret']]
    need(all(re.fullmatch(r'[A-Za-z0-9_-]{32,128}', x) for x in fresh), 'COMMON_NEW_SECRET_FORMAT')
    uri = lambda db, user: 'postgresql://' + user + ':' + quote(s['credentials'][user], safe='') + '@haproxy.home.cz:5000/' + db + '?sslmode=verify-full&sslrootcert=%2Fetc%2Fcsm-sim%2Fpostgresql-ca.pem'
    env = {'SIM_USER_DATA_ENABLED': 'false', 'SIM_USER_HISTORY_ENABLED': 'false', 'SIM_USER_DATA_RELAY_ENABLED': 'false',
           'SIM_USER_DATA_MODE': 'production-sim-user-data-v1', 'SIM_USER_HISTORY_MODE': 'production-sim-user-data-v1',
           'SIM_USER_DATA_ENVIRONMENT_ID': s['bindings']['sim_user_data']['environment_id'],
           'SIM_USER_DATA_RESET_EPOCH': s['resetEpoch'], 'SIM_USER_DATA_TOKENS_NOT_BEFORE': str(s['tokensNotBefore']),
           'SIM_USER_DATA_DATABASE_URL': uri('sim_user_data', 'sim_user_data_runtime'), 'SIM_USER_DATA_ROOT': '/data/sim-user-data-v1',
           'SIM_USER_DATA_OWNER_SECRET': identity['ownerSecret'], 'SIM_USER_DATA_COP_ACTOR_SECRET': identity['actorSecret'],
           'SIM_USER_DATA_ROUTER_ACTOR_SECRET': identity['routerActorSecret'], 'SIM_USER_DATA_COP_TOKEN': s['serviceToken'],
           'SIM_AI_ROUTER_SIM_TOKEN': existing['AI_ROUTER_SIM_TOKEN'],
           'SIM_USER_DATA_GUARD_DATABASE_URL': uri('cop_account_safety_guard', 'sim_user_data_guard_runtime'),
           'SIM_USER_HISTORY_GUARD_DATABASE_URL': uri('cop_account_safety_guard', 'sim_user_history_guard_runtime'),
           'SIM_USER_DATA_CONTINUITY_BINDING': json.dumps(s['bindings']['sim_user_data'], separators=(',', ':')),
           'SIM_USER_HISTORY_CONTINUITY_BINDING': json.dumps(s['bindings']['sim_user_history'], separators=(',', ':'))}
    replay = s.get('completedReplayMode', 'disabled')
    need(replay in {'disabled', 'same-epoch-completed-content-replay-v1'}, 'COMMON_COMPLETED_REPLAY_MODE')
    env.update({key: replay for key in ['SIM_CLEAN_COMPLETED_REPLAY_MODE', 'SIM_USER_DATA_COMPLETED_REPLAY_MODE', 'SIM_USER_HISTORY_COMPLETED_REPLAY_MODE']})
    service = {'sim-api': {k: k for k in env if k.startswith('SIM_USER_DATA_') or k == 'SIM_AI_ROUTER_SIM_TOKEN'},
               'ai-router-api': {k: k for k in env if k.startswith('SIM_USER_HISTORY_') or k in {
                   'SIM_USER_DATA_ENVIRONMENT_ID', 'SIM_USER_DATA_RESET_EPOCH', 'SIM_USER_DATA_TOKENS_NOT_BEFORE', 'SIM_USER_DATA_ROUTER_ACTOR_SECRET'}},
               'situation-data-api': {'SIM_USER_DATA_RELAY_ENABLED': 'SIM_USER_DATA_RELAY_ENABLED'}, 'sim-web': {}}
    service['sim-api'].pop('SIM_USER_DATA_RELAY_ENABLED')
    service['ai-router-api']['SIM_CLEAN_COMPLETED_REPLAY_MODE'] = 'SIM_CLEAN_COMPLETED_REPLAY_MODE'
    service['situation-data-api']['SIM_CLEAN_COMPLETED_REPLAY_MODE'] = 'SIM_CLEAN_COMPLETED_REPLAY_MODE'
    for lane, target in [('ai', 'ai-router-api'), ('driver', 'situation-data-api')]:
        e = config['enrollments'][lane]
        need(e['resetEpoch'] == s['resetEpoch'] and e['tokensNotBefore'] == s['tokensNotBefore'], 'COMMON_BASE_CLEAN_EPOCH')
        values = {'ENABLED': 'false', 'MODE': MODE, 'ENVIRONMENT_ID': e['environmentId'], 'RESET_EPOCH': e['resetEpoch'],
                  'TOKENS_NOT_BEFORE': str(e['tokensNotBefore']), 'USER_DATASET_ID': e['userDatasetId'],
                  'PRODUCTION_ENROLLMENT_ID': e['enrollmentId']}
        for suffix, value in values.items():
            name = 'SIM_CLEAN_' + lane.upper() + '_' + suffix
            env[name] = value
            service[target]['SIM_CLEAN_LIFECYCLE_' + suffix] = name
        # New clean composition and the legacy erasure composition cannot coexist.
        legacy = 'AI_ROUTER_ACCOUNT_ERASURE_ENABLED' if lane == 'ai' else 'DRIVER_ACCOUNT_ERASURE_ENABLED'
        env[legacy] = 'false'
        service[target][legacy] = legacy
    return env, service

def render_environment(original, values):
    need(all(re.fullmatch(r'[A-Z][A-Z0-9_]+', key) and isinstance(value, str)
             and not any(x in value for x in ['\n', '\r', '\0', "'", '$']) for key, value in values.items()), 'COMMON_ENV_VALUE')
    seen = set()
    out = []
    for line in original.decode('utf8').splitlines(keepends=True):
        key, sep, _ = line.partition('=')
        if sep and key in values:
            need(key not in seen, 'COMMON_ENV_DUPLICATE')
            seen.add(key)
            out.append(key + "='" + values[key] + "'\n")
        else:
            out.append(line)
    if out and not out[-1].endswith('\n'):
        out.append('\n')
    out.extend(key + "='" + value + "'\n" for key, value in sorted(values.items()) if key not in seen)
    return ''.join(out).encode()

def replace_file(path, raw, uid, gid, mode, admission, expected=None):
    admission.assert_current()
    need(path.parent.resolve() == path.parent and not path.is_symlink(), 'COMMON_OUTPUT_PATH')
    if expected is not None:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            need(os.read(fd, len(expected) + 1) == expected, 'COMMON_OUTPUT_CHANGED')
        finally:
            os.close(fd)
    else:
        need(not path.exists(), 'COMMON_OUTPUT_EXISTS')
    temp = path.parent / ('.' + path.name + '.clean-' + str(uuid.uuid4()))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchown(fd, uid, gid); os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(raw); handle.flush(); os.fsync(handle.fileno())
        admission.assert_current()
        if expected is not None:
            need(path.read_bytes() == expected, 'COMMON_OUTPUT_CHANGED')
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
        need(path.read_bytes() == raw, 'COMMON_OUTPUT_READBACK')
        admission.assert_current()
    finally:
        temp.unlink(missing_ok=True)

def stage_sim_configuration(config, plan, admission):
    before, info = read_environment()
    values, services = disabled_runtime(config, before)
    images = plan['candidateImages']
    names = {'sim-api': 'sim_api', 'ai-router-api': 'ai_router', 'situation-data-api': 'situation_data', 'sim-web': 'sim_web'}
    overlay = {'services': {name: {'image': images[names[name]], 'environment': {key: '${' + value + ':?Missing clean runtime configuration}' for key, value in variables.items()}}
                            for name, variables in services.items()}}
    for name in ['sim-api', 'ai-router-api']:
        overlay['services'][name]['volumes'] = [{'type': 'bind', 'source': '/etc/vcode-cop-pgbouncer/postgres-ca.crt',
            'target': '/etc/csm-sim/postgresql-ca.pem', 'read_only': True, 'bind': {'create_host_path': False}}]
    ca = Path('/etc/vcode-cop-pgbouncer/postgres-ca.crt')
    need(ca.is_file() and not ca.is_symlink() and b'BEGIN CERTIFICATE' in ca.read_bytes(), 'COMMON_CA_MISSING')
    source_guard, old_guard, guard_info = deploy_guard_input(plan)
    replace_file(DEPLOY_GUARD, source_guard, guard_info.st_uid, guard_info.st_gid, stat.S_IMODE(guard_info.st_mode), admission, old_guard)
    after = render_environment(before, values)
    replace_file(SIM_ENV, after, info.st_uid, info.st_gid, 0o600, admission, before)
    raw = json.dumps(overlay, sort_keys=True, indent=2).encode() + b'\n'
    replace_file(OVERLAY, raw, 0, 0, 0o644, admission)
    return {'contractVersion': 'sim-clean-runtime-config-staged-v1', 'environmentSha256': digest(after),
            'overlaySha256': digest(raw), 'intakeEnabled': False, 'baseCleanEnabled': False, 'servicesStarted': False}

def deploy_guard_input(plan):
    source = plan['sources']['sim']
    relative = 'scripts/deploy-docker-home.sh'
    need(relative in source['files'], 'COMMON_DEPLOY_GUARD_SOURCE')
    raw = protected(Path(source['root']) / relative)
    need(digest(raw) == source['files'][relative], 'COMMON_DEPLOY_GUARD_SOURCE')
    fd = os.open(DEPLOY_GUARD, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid in {0,1000}
             and stat.S_IMODE(s.st_mode) in {0o755,0o555} and s.st_size <= 1048576, 'COMMON_DEPLOY_GUARD_CUSTODY')
        old = os.read(fd,1048577)
        need(digest(old) in OLD_DEPLOY_HASHES | {digest(raw)}, 'COMMON_DEPLOY_GUARD_UNKNOWN')
        return raw, old, s
    finally:
        os.close(fd)

def run_common_reset(private_config):
    need(os.getuid() == 0 and socket.gethostname().split('.')[0] == 'docker', 'COMMON_ROOT_REQUIRED')
    raw = protected(PLAN, modes=(0o600,))
    plan = json.loads(raw)
    source = plan['sources']['cop']
    # Verify the complete enrolled public operator source before importing code.
    for relative, expected in source['files'].items():
        need(not Path(relative).is_absolute() and '..' not in Path(relative).parts
             and digest(protected(Path(source['root']) / relative)) == expected, 'COMMON_SOURCE_HASH')
    controller = load_sealed(source, 'scripts/account-safety/clean-reset-controller.py', 'common_root_controller')
    host = controller.host
    plan = host.validate_plan(plan)
    need(private_config['resetEpoch'] == plan['resetEpoch'] and private_config['tokensNotBefore'] == plan['tokensNotBefore'], 'COMMON_CONFIG_EPOCH')
    # This is the actual COP factory reading the protected whole12 report, not a
    # caller-supplied success bit. freeze_reviewed repeats it and holds its CAS.
    proof = host._acceptance_module().verified_pre_stop_acceptance(plan['candidateImages'])
    remaining = load_sealed(source, 'scripts/account-safety/clean-remaining-reset.py', 'common_remaining_reset')
    need(callable(getattr(remaining, 'run_remaining_reset', None)), 'COMMON_CLOSURE_MISSING')
    need(callable(getattr(remaining, 'prepare_remaining_reset', None)), 'COMMON_CLOSURE_PREFLIGHT_MISSING')
    # Check runtime/secret prerequisites while all current services still run.
    disabled_runtime(private_config, read_environment()[0])
    deploy_guard_input(plan)
    remote = host.CommunicationResetTransport()
    producers = host.DriverReportProducerCustody()
    receipts = {}
    try:
        remote.open()
        # Enter the actual closure inventory/transport preflight BEFORE acquiring
        # the writer freeze; keep its custody until the held lease is released.
        with remaining.prepare_remaining_reset(plan, private_config, remote), host.RootResetAdmission.freeze_reviewed(remote, producers) as admission:
            need(admission.pre_stop_acceptance == proof, 'COMMON_WHOLE_PROOF_CHANGED')
            need(host.protected(PLAN) == raw, 'COMMON_PLAN_CHANGED')
            for phase in COMMON_PHASES:
                admission.assert_current()
                request = {**private_config, 'phase': phase}
                if phase == 'sim_user_install':
                    request['simUserInstall'] = {**request['simUserInstall'], 'phase': 'apply'}
                receipts[phase] = controller.run_private_worker(admission, request)
                admission.assert_current()
            receipts['remaining'] = remaining.run_remaining_reset(admission, private_config)
            admission.assert_current()
            receipts['readback'] = controller.run_private_worker(admission, {**private_config, 'phase': 'readback'})
            receipts['sim_config'] = stage_sim_configuration(private_config, plan, admission)
            admission.assert_current()
            return {'contractVersion': 'cop-sim-common-reset-fenced-v1', 'resetEpoch': plan['resetEpoch'],
                    'preStopReportSha256': proof['reportSha256'], 'completedPhases': list(receipts),
                    'simConfiguration': receipts['sim_config'],
                    'servicesRestarted': False, 'runtimeFlagsEnabled': False, 'wholeAccountComplete': False}
    finally:
        remote.close()
