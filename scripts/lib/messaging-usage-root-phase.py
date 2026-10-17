"""Actual baseline commit adapter, AFTER separately reviewed schema installation.
No CLI, SQL grants, app endpoint, credential generation or writer restart.
The common Root must register messaging_install with its OWN reviewed digest.
"""
import hashlib,importlib.util,json
from pathlib import Path

def need(value):
    if not value:raise RuntimeError('MESSAGING_USAGE_ROOT_PHASE_REJECTED')

def digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def writer_inventory_digest(root_plan):
    return digest({k:root_plan[k] for k in ['localWriters','remoteWriters','producerInventorySha256']})

def commit_with_current_custody(admission, prepared, expected_writer_digest):
    """Fresh real admission checks, not a caller-supplied paused boolean."""
    admission.assert_current()
    s=prepared.summary
    need(s['mode']=='initial' and s['knownOwners']==0 and s['unresolved']==0
         and s['writerInventorySha256']==expected_writer_digest)
    packet={'contractVersion':'cop-messaging-usage-commit-v1','nonce':prepared.nonce,
            'planSha256':s['planSha256'],'writerInventorySha256':expected_writer_digest}
    admission.assert_current()
    result=prepared.commit(packet)
    admission.assert_current()
    need(result['committed'] is True and result['knownOwners']==0 and result['unresolved']==0
         and result['writerClosureVerified'] is False)
    return {'contractVersion':'cop-messaging-root-initial-baseline-v1',
            'baselineDigest':result['baselineDigest'],'knownOwners':0,
            'hostWriterCustodyVerified':True,'componentClaimsHostClosure':False,
            'runtimeRestarted':False,'wholeAccountReady':False}

def run_messaging_usage_phase(root_module, admission, reviewed_install, connections, root_base64):
    """Root-only existing guard/metadata/native ADMIN connections in that order.
    PreparedEnrollment verifies actual catalogs, binding and inventories itself.
    Unreachable guard or missing schema is an error, never a positive absence.
    """
    need(type(admission) is root_module.RootResetAdmission)
    admission.assert_current()
    plan=admission.plan
    need(reviewed_install['contractVersion']=='cop-messaging-clean-install-plan-v1'
         and plan['reviewedPlanDigests'].get('messaging_install')==digest(reviewed_install))
    usage=reviewed_install['usagePlan']
    need(usage['mode']=='initial' and usage['lineage']==[]
         and usage['binding']['issuer']=='https://login.zeleznalady.cz/realms/cop'
         and usage['writerInventorySha256']==writer_inventory_digest(plan))
    source=plan['sources']['messaging'];relative='deploy/account-safety/communication_usage_enrollment.py'
    p=Path(source['root'])/relative
    need(p.resolve()==p and p.stat().st_uid==0 and not p.stat().st_mode&0o222
         and hashlib.sha256(p.read_bytes()).hexdigest()==source['files'][relative]
         and usage['sourcePins'][relative]==source['files'][relative])
    need(len(connections)==3)
    spec=importlib.util.spec_from_file_location('sealed_actual_usage_phase',p)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    prepared=None
    try:
        prepared=module.PreparedEnrollment(connections,Path(source['root']),usage,root_base64)
        return commit_with_current_custody(admission,prepared,writer_inventory_digest(plan))
    finally:
        if prepared:prepared.close()

def run_messaging_install_phase(root_module, admission, private_config):
    """Schema-only COP installer then ONE actual baseline, under same custody."""
    need(type(admission) is root_module.RootResetAdmission)
    admission.assert_current()
    private=private_config['messagingInstall']
    need(set(private)=={'reviewedPlan','connections','rootBase64'})
    envelope=private['reviewedPlan'];plan=admission.plan
    need(set(envelope)=={'contractVersion','configuration','schemaPlan','usagePlan'}
         and envelope['contractVersion']=='cop-messaging-clean-install-plan-v1'
         and plan['reviewedPlanDigests'].get('messaging_install')==digest(envelope))
    config=envelope['configuration'];usage=envelope['usagePlan']
    need(config['baselineId']==usage['baselineId']
         and config['guardRuntimeRole']==usage['guardRuntimeRole']
         and config['sourcePins']==usage['sourcePins']
         and config['writerInventorySha256']==usage['writerInventorySha256'])
    need(all(config['binding'].get(k)==v for k,v in usage['binding'].items()))
    source=plan['sources']['cop'];relative='scripts/account-safety/clean-messaging-install.py'
    p=Path(source['root'])/relative
    need(p.resolve()==p and p.stat().st_uid==0 and not p.stat().st_mode&0o222
         and hashlib.sha256(p.read_bytes()).hexdigest()==source['files'][relative])
    spec=importlib.util.spec_from_file_location('sealed_actual_messaging_install',p)
    installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
    # Do not invoke the old combined installer and accidentally enroll twice.
    install=getattr(installer,'install_initial_schema_and_bindings',None)
    need(callable(install))
    configs=private['connections'];need(set(configs)=={'guard','metadata','native'})
    for lane,db in [('guard','cop_account_safety_guard'),('metadata','csm_messaging'),('native','csm_synapse')]:
        c=configs[lane]
        need(set(c)=={'host','port','dbname','user','password','sslmode','sslrootcert'}
             and c['host']=='haproxy.home.cz' and c['port']==5000 and c['dbname']==db
             and c['user']=='postgres' and isinstance(c['password'],str) and c['password']
             and c['sslmode']=='verify-full'
             and c['sslrootcert']=='/etc/vcode-cop-pgbouncer/postgres-ca.crt')
    import psycopg2
    connections={}
    try:
        for lane,c in configs.items():
            connections[lane]=psycopg2.connect(**c,connect_timeout=8,application_name='cop-messaging-root-install')
        admission.assert_current()
        result=install(connections,Path(plan['sources']['messaging']['root']),config,
                       envelope['schemaPlan'],private['rootBase64'],admission)
        need(result.get('schemaAndBindingInstalled') is True and 'baselineDigest' not in result)
        admission.assert_current()
        baseline=run_messaging_usage_phase(root_module,admission,envelope,
            [connections[k] for k in ['guard','metadata','native']],private['rootBase64'])
        return {'contractVersion':'cop-messaging-root-install-result-v1',
                'schemaAndBindingInstalled':True,'baseline':baseline,
                'runtimeRestarted':False,'erasureEnabled':False,'wholeAccountComplete':False}
    finally:
        for connection in connections.values():connection.close()
