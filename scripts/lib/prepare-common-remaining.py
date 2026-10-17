"""Source-only Root preparation. No CLI, apply, freeze or authentication setup.
Caller owns the sealed source descriptor and already-open provider transports.
Every return value except publicSummary is PRIVATE RAM; never log it.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket

COP_ROOT = '/srv/x5-production/staging/cop/clean-operator-2e61857/app'

def need(value):
    if not value:
        raise RuntimeError('COMMON_REMAINING_PREPARATION_REJECTED')

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def load_remaining(plan):
    source = plan['sources']['cop']
    need(source['root'] == COP_ROOT)
    relative = 'scripts/account-safety/clean-remaining-reset.py'
    path = Path(COP_ROOT) / relative
    need(path.resolve() == path and path.is_file() and path.stat().st_uid == 0
         and not path.stat().st_mode & 0o222)
    need(hashlib.sha256(path.read_bytes()).hexdigest() == source['files'][relative])
    spec = importlib.util.spec_from_file_location('sim_sealed_remaining_prepare', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def collect_remaining_plans(metadata, native, native_media, s3, edge):
    """Inspect-only composition; injectable pure synthetic adapters for tests."""
    return {'messaging': {'metadata': metadata(), 'native': native()},
            'media': {'nativeMedia': native_media(), 's3': s3()}, 'edge': edge()}

def inspect_remaining_private(plan, private_config, postgres_password, native_admin_token, remote, storage):
    need(os.getuid() == 0 and socket.gethostname().split('.')[0] == 'docker')
    need(private_config['resetEpoch'] == plan['resetEpoch']
         and private_config['tokensNotBefore'] == plan['tokensNotBefore'])
    need(isinstance(postgres_password, str) and postgres_password and '\0' not in postgres_password)
    need(isinstance(native_admin_token, str) and 20 <= len(native_admin_token) <= 16384)
    remaining = load_remaining(plan)
    messaging = remaining.load(plan, 'clean-reset-messaging.py', 'sim_prepare_messaging')
    s3_module = remaining.load(plan, 'clean-reset-s3.py', 'sim_prepare_s3')
    # Require the concrete transport classes, never an app-supplied positive result.
    remaining.source(plan, 'scripts/account-safety/clean-reset-root.py')
    need(type(remote).__name__ == 'CommunicationResetTransport'
         and Path(type(remote)._custody.__code__.co_filename).resolve()
         == Path(COP_ROOT+'/scripts/account-safety/clean-reset-root.py'))
    need(type(storage).__name__ == 'ProductionStorage'
         and Path(type(storage).custody.__code__.co_filename).resolve()
         == Path(COP_ROOT+'/scripts/account-safety/clean-reset-s3.py'))
    remote._custody()
    storage.custody()
    import psycopg2
    configs = {lane: {'host': 'haproxy.home.cz', 'port': 5000, 'dbname': database,
                      'user': 'postgres', 'password': postgres_password,
                      'sslmode': 'verify-full', 'sslrootcert': '/etc/vcode-cop-pgbouncer/postgres-ca.crt'}
               for lane, database in [('native', 'csm_synapse'), ('metadata', 'csm_messaging')]}
    connections = {}
    try:
        for lane, config in configs.items():
            connections[lane] = psycopg2.connect(**config, connect_timeout=8,
                application_name='cop-clean-readonly-prepare', options='-c default_transaction_read_only=on')
        plans = collect_remaining_plans(
            lambda: messaging.inspect_metadata_reset(connections['metadata'], 'docker.home.cz'),
            lambda: messaging.inspect_native_reset(connections['native'], native_admin_token, 'docker.home.cz'),
            lambda: remaining.helper(plan, remote, 'native_media', 'inspect'),
            lambda: s3_module.inspect_s3_reset(storage),
            lambda: remaining.helper(plan, remote, 'edge', 'inspect'))
        remote._custody()
        storage.custody()
        return {'contractVersion': 'cop-clean-remaining-private-v1', 'connections': configs,
                'nativeAdminToken': native_admin_token, 'reviewedPlans': plans}
    finally:
        for connection in connections.values():
            connection.close()

def finalize_private_preparation(private_config, remaining, cop_safety_prepared, manifest_bytes, postgres_password):
    """Join actual inspector outputs; does not seal PLAN or claim authorization.
    manifest_bytes is the exact UTF-8 JSON+newline returned by COP's real builder.
    The sealed parent must keep it in RAM until separately authorized publication.
    """
    need(private_config.get('phase') == 'inspect')
    need(set(private_config['reviewedPlans']) == {'cop','ai','driver','files','keycloak','sim_app_files','sim_user_install'})
    need(remaining.get('contractVersion') == 'cop-clean-remaining-private-v1'
         and set(remaining['reviewedPlans']) == {'messaging','media','edge'})
    need(isinstance(manifest_bytes, bytes) and 0 < len(manifest_bytes) < 1048576)
    manifest = json.loads(manifest_bytes)
    need(manifest == cop_safety_prepared['manifest']
         and manifest['contractVersion'] == 'cop-database-safety-provision-clean-v1'
         and manifest['resetEpoch'] == private_config['resetEpoch']
         and manifest['tokensNotBefore'] == private_config['tokensNotBefore'])
    sha = hashlib.sha256(manifest_bytes).hexdigest()
    need(cop_safety_prepared['plan']['planDigest'] == sha
         and cop_safety_prepared['plan']['factsInspected'] is False
         and cop_safety_prepared['plan']['readinessClaimed'] is False)
    need(isinstance(postgres_password,str) and postgres_password)
    plans = {**private_config['reviewedPlans'], 'cop_safety_install': cop_safety_prepared['plan']}
    hashes = {}
    for key, value in plans.items():
        value_digest = value.get('inventoryDigest' if key == 'keycloak' else 'planDigest')
        need(isinstance(value_digest,str) and len(value_digest)==64
             and all(c in '0123456789abcdef' for c in value_digest))
        hashes[key] = value_digest
    all_digests = {**hashes, **{k:digest(v) for k,v in remaining['reviewedPlans'].items()}}
    config = {**private_config, 'reviewedPlans':plans, 'reviewedPlanDigests':hashes,
              'remaining':remaining,'copSafetyInstall':{'mode':'apply','password':postgres_password}}
    return {'privateConfig':config,'privateCopManifestBytes':manifest_bytes,
            'publicSummary':{'contractVersion':'cop-sim-eleven-prepared-plans-v1',
                'reviewedPlanDigests':all_digests,'planCount':11,
                'productionFactsInspectedByCopManifestBuilder':False,
                'messagingProfileAndBaselineInstallationIncluded':False,
                'freezeAuthorized':False,'productionActivated':False}}

def attach_messaging_install_preparation(prepared, envelope, connections, root_base64):
    """Explicit twelfth plan; requires actual COP schema inspector output."""
    need(set(envelope)=={'contractVersion','configuration','schemaPlan','usagePlan'}
         and envelope['contractVersion']=='cop-messaging-clean-install-plan-v1')
    need(envelope['schemaPlan']['contractVersion']=='cop-messaging-production-initial-plan-v1'
         and isinstance(envelope['schemaPlan'].get('planDigest'),str)
         and envelope['schemaPlan']['planDigest']==digest({k:v for k,v in envelope['schemaPlan'].items() if k!='planDigest'}))
    usage=envelope['usagePlan'];configuration=envelope['configuration']
    need(envelope['schemaPlan']['configurationDigest']==digest(configuration))
    need(usage['contractVersion']=='cop-messaging-usage-enrollment-plan-v1'
         and usage['mode']=='initial' and usage['lineage']==[]
         and usage['binding']['issuer']=='https://login.zeleznalady.cz/realms/cop'
         and configuration['baselineId']==usage['baselineId']
         and configuration['sourcePins']==usage['sourcePins']
         and configuration['writerInventorySha256']==usage['writerInventorySha256']
         and configuration['guardRuntimeRole']==usage['guardRuntimeRole']
         and all(configuration['binding'].get(k)==v for k,v in usage['binding'].items()))
    need(set(connections)=={'guard','metadata','native'} and isinstance(root_base64,str) and root_base64)
    public=prepared['publicSummary']
    need(public['planCount']==11 and 'messaging_install' not in public['reviewedPlanDigests'])
    sha=digest(envelope);config=prepared['privateConfig']
    config={**config,'messagingInstall':{'reviewedPlan':envelope,'connections':connections,'rootBase64':root_base64},
            'reviewedPlans':{**config['reviewedPlans'],'messaging_install':envelope},
            'reviewedPlanDigests':{**config['reviewedPlanDigests'],'messaging_install':sha}}
    return {**prepared,'privateConfig':config,'publicSummary':{**public,
            'contractVersion':'cop-sim-twelve-prepared-plans-v1','planCount':12,
            'reviewedPlanDigests':{**public['reviewedPlanDigests'],'messaging_install':sha},
            'messagingProfileAndBaselineInstallationIncluded':True,
            'messagingSchemaOrBaselineApplied':False,'productionActivated':False}}
