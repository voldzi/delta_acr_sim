"""Non-deleting checks of ONLY the new owned isolated TLS SIM fixture."""
import json,subprocess,time
OWNER='cop-clean-whole12-9aff26e65b74'
CLIENT=OWNER+'-sim-tls-v2';PG=OWNER+'-pg-tls'
def docker(*args):return subprocess.check_output(['/usr/bin/docker',*args],stderr=subprocess.PIPE,timeout=30)
for name in [CLIENT,PG]:
    c=json.loads(docker('inspect',name))[0]
    assert c['Config']['Labels']['cop.test.owner']==OWNER and not c['HostConfig'].get('PortBindings')
def sql(statement):
    docker('exec',PG,'psql','-v','ON_ERROR_STOP=1','-h','/private/tmp/sim-user-install-pg-9aff26e65b74/s','-p','5000','-U','fixture_admin','-d','cop_account_safety_guard','-Atc',statement)
JS=r'''(async()=>{const x=JSON.parse(require('fs').readFileSync('/dev/shm/cop-clean-whole/sim-private.json'));const main=process.argv[1]==='main';const url=main?'http://127.0.0.1:4314/api/v1/internal/sim-user-data/v1/capabilities':'http://127.0.0.1:4324/readback';const token=main?x.input.userDataEnvironment.copToken:x.input.base.environment.copServiceToken;const r=await fetch(url,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(9000)});const body=await r.json();console.log(JSON.stringify({status:r.status,body}));})().catch(()=>{console.error('PRIVATE_TEST_PROBE_FAILED');process.exitCode=1})'''
def request(lane='all'):return json.loads(docker('exec',CLIENT,'node','-e',JS,lane))
before=request();assert before['status']==200
results={}
try:
    sql("UPDATE sim_erasure_guard_v2.user_data_checkpoint SET state='quarantined' WHERE component='sim_user_data'")
    assert request()['status']==503 and request('main')['status']==503
    results['checkpointQuarantineRefused']=True
finally:sql("UPDATE sim_erasure_guard_v2.user_data_checkpoint SET state='ready' WHERE component='sim_user_data'")
assert request()['status']==200
try:
    sql('ALTER ROLE sim_user_data_guard_runtime NOLOGIN;ALTER ROLE sim_user_history_guard_runtime NOLOGIN')
    sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='cop_account_safety_guard' AND usename IN('sim_user_data_guard_runtime','sim_user_history_guard_runtime') AND pid<>pg_backend_pid()")
    assert request()['status']==503 and request('main')['status']==503
    results['actualGuardConnectionOutageRefused']=True
finally:sql('ALTER ROLE sim_user_data_guard_runtime LOGIN;ALTER ROLE sim_user_history_guard_runtime LOGIN')
deadline=time.monotonic()+15
while True:
    after=request()
    if after['status']==200:break
    assert time.monotonic()<deadline,'GUARD_RECOVERY_FAILED'
    time.sleep(.2)
assert request('main')['status']==200
for name in ['a','b']:
    assert after['body']['appOwners'][name]==before['body']['appOwners'][name]
    assert after['body']['simHistory'][name]==before['body']['simHistory'][name]
results.update(actualRecoveryFreshAdmission=True,bothActorsPreserved=True,deletionsPerformed=0,productionChanged=False,actualRootAdmission=False,wholeAccountComplete=False)
print(json.dumps({'contractVersion':'whole12-tls-nondeleting-guard-probe-v1',**results}))
