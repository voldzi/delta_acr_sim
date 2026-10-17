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
