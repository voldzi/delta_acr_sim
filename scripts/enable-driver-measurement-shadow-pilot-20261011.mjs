// Host-owner operation under COP's storage flock (inherited FD 9).
// Enables only the SIM shadow receiver. It does not enable normal COP intake,
// install an iPhone build, grant user consent, or influence traffic / ETA.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, statSync, lstatSync, existsSync,
  unlinkSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { posix } from 'node:path';

const mode = process.argv[2];
const expectedSimImage = 'sha256:60d66a8083e4df55ea5eb8d8713c1846556a96162cd4fce1b70600ffecf89fc4';
const simName = 'csm-sim-situation-data-api', copName = 'cop-cop-api-1';
const flag = 'DRIVER_MEASUREMENTS_ENABLED', envPath = '/srv/sim/.env';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const safe = (ok, code) => { if (!ok) throw new Error(code); };
const run = (bin, args, cwd = '/srv/sim', input, environment = process.env) => {
  try {
    return execFileSync(bin, args, { cwd, input, env: environment, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 9],
      maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  } catch { throw new Error('SUBPROCESS_FAILED_CAPTURE_SUPPRESSED'); }
};
const inspect = name => JSON.parse(run('docker', ['inspect', name]))[0];
const environment = state => Object.fromEntries(state.Config.Env.map(value => {
  const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)];
}));
const canonicalHost = host => {
  const result = structuredClone(host);
  if (result.Mounts) {
    const targets = result.Mounts.map(mount => mount.Target);
    safe(targets.every(target => typeof target === 'string' && target.startsWith('/') && target !== '/' && posix.normalize(target) === target)
      && new Set(targets).size === targets.length, 'AMBIGUOUS_MOUNT');
    result.Mounts.sort((a, b) => a.Target.localeCompare(b.Target));
  }
  return result;
};
const invariant = state => ({ image: state.Image,
  runtime: digest({ command: state.Config.Cmd, entrypoint: state.Config.Entrypoint,
    user: state.Config.User, workingDir: state.Config.WorkingDir, healthcheck: state.Config.Healthcheck }),
  environment: digest(Object.entries(environment(state)).filter(([key]) => key !== flag).sort(([a], [b]) => a.localeCompare(b))),
  host: digest(canonicalHost(state.HostConfig)), mounts: digest(state.Mounts),
  networks: Object.fromEntries(Object.entries(state.NetworkSettings.Networks).sort(([a], [b]) => a.localeCompare(b)).map(([name, network]) =>
    [name, { id: network.NetworkID, aliases: (network.Aliases ?? []).filter(alias => alias !== state.Id && alias !== state.Id.slice(0, 12)).sort() }])) });
const others = () => run('docker', ['ps', '--format', '{{.Names}} {{.ID}}']).trim().split('\n').filter(Boolean).sort().filter(line => !line.startsWith(simName + ' '));
const stripFlag = text => text.split('\n').filter(line => !line.startsWith(flag + '=')).join('\n');
const readFlag = text => {
  const lines = text.split('\n').filter(line => line.startsWith(flag + '='));
  safe(lines.length === 1 && ['true', 'false'].includes(lines[0].slice(flag.length + 1)), 'AMBIGUOUS_INTAKE_FLAG');
  return lines[0].slice(flag.length + 1);
};
const patchFlag = (text, value) => {
  readFlag(text);
  const patched = text.replace(new RegExp('^' + flag + '=.*$', 'm'), flag + '=' + value);
  safe(stripFlag(patched) === stripFlag(text), 'UNRELATED_ENV_CHANGE');
  return patched;
};
const containerScript = script => JSON.parse(run('docker', ['exec', '-i', '-w', '/app/apps/situation-data-api', simName, 'node', '--input-type=module'], '/srv/sim', script));
const writePrivateFlag = (value, expectedText, suffix) => {
  safe(readFileSync(envPath, 'utf8') === expectedText, 'CONCURRENT_ENV_CHANGE');
  const path = envPath + suffix;
  writeFileSync(path, patchFlag(expectedText, value), { flag: 'wx', mode: 0o600 });
  staged.push(path);
  renameSync(path, envPath);
};
const waitHealthy = async () => {
  // Honour the unchanged Docker health policy, plus one successful interval.
  // The old fixed 60s window could expire before the second 30s check finished.
  const health = before.Config.Healthcheck;
  const intervalMs = health.Interval / 1000000, timeoutMs = health.Timeout / 1000000;
  const startPeriodMs = (health.StartPeriod ?? 0) / 1000000;
  safe(Number.isFinite(intervalMs) && intervalMs > 0 && Number.isFinite(timeoutMs) && timeoutMs > 0
    && Number.isFinite(startPeriodMs) && startPeriodMs >= 0 && Number.isInteger(health.Retries) && health.Retries >= 1, 'INVALID_HEALTH_POLICY');
  const budgetMs = startPeriodMs + intervalMs * (health.Retries + 1) + timeoutMs;
  safe(budgetMs <= 600000, 'HEALTH_POLICY_BUDGET_UNBOUNDED');
  const deadline = Date.now() + budgetMs;
  let state;
  while (Date.now() < deadline) {
    state = inspect(simName);
    if (state.State.Health?.Status === 'healthy') return state;
    safe(state.State.Running, 'SIM_STOPPED');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('SIM_HEALTH_DEADLINE');
};

// All generated identities below are synthetic, private, and never printed.
const smokeScript = fixtures => `
 import {Pool} from 'pg'; import {createHmac} from 'node:crypto';
 const fs=${JSON.stringify(fixtures)}, result={}, h=process.env.DRIVER_MEASUREMENTS_HASH_SECRET;
 const token=process.env.DRIVER_MEASUREMENTS_COP_TOKEN;
 const base='http://127.0.0.1:4020/api/v1/internal/driver-measurements/v1';
 const pool=new Pool({connectionString:process.env.DRIVER_MEASUREMENTS_DATABASE_URL,max:1,connectionTimeoutMillis:1500,statement_timeout:5000});
 function batch(f,index=0) {
  const now=Date.now(), start=Math.floor(now/86400000)*86400000;
  const at=Math.min(Math.max(now-2000,start),start+86400000-3000);
  return {contractVersion:'sim-driver-measurements-v1',batchId:f.batchIds[index],contributorIdDay:f.pseudonym,contributorDay:new Date(at).toISOString().slice(0,10),
   consent:{version:'traffic-quality-v1',grantedAt:new Date(at-1000).toISOString(),attestation:'cop-driver-consent-v1'},vehicleClass:'passenger_car',
   points:f.sampleIds.map((sampleId,i)=>({sampleId,observedAt:new Date(at+i*1000).toISOString(),lat:49.19114,lon:16.61158,horizontalAccuracyM:3,speedMps:0,speedAccuracyMps:1,
    headingDeg:0,headingAccuracyDeg:5,positionSource:'simulated',motion:'unknown',reducedAccuracy:false}))};
 }
 async function call(path,method,body,{auth=true,origin=false}={}) {
  const headers={'Content-Type':'application/json','x-correlation-id':'synthetic-shadow-pilot-acceptance'};
  if(auth)headers.Authorization='Bearer '+token;if(origin)headers.Origin='https://synthetic.invalid';
  const r=await fetch(base+path,{method,signal:AbortSignal.timeout(10000),redirect:'error',headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
  let value={};try{value=await r.json();}catch{}
  return {status:r.status,replay:r.headers.get('x-idempotent-replay'),value};
 }
 const check=(ok)=>{if(!ok)throw new Error('SMOKE');};
 const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 const deletion=f=>({contractVersion:'sim-driver-measurements-v1',contributorIdDay:f.pseudonym});
 try {
  result.noAuthStatus=(await call('/batches','POST',{}, {auth:false})).status;
  result.invalidStatus=(await call('/batches','POST',{})).status;
  result.originStatus=(await call('/batches','POST',{}, {origin:true})).status;
  check(result.noAuthStatus===401&&result.invalidStatus===400&&result.originStatus===403);
  const first=batch(fs[0]); const accepted=await call('/batches','POST',first);
  result.simulatedBatchStatus=accepted.status; result.simulatedAcceptedIntervals=accepted.value.acceptedIntervalCount;
  result.applicationMode=accepted.value.applicationMode;result.rawPositionsStored=accepted.value.rawPositionsStored;
  check(accepted.status===200&&accepted.value.acceptedIntervalCount===0&&accepted.value.etaAccepted===false&&accepted.value.applicationMode==='shadow_only'&&accepted.value.rawPositionsStored===false);
  const replay=await call('/batches','POST',first);result.replayStatus=replay.status;result.replayExact=replay.replay==='true'&&JSON.stringify(canonical(replay.value))===JSON.stringify(canonical(accepted.value));
  check(replay.status===200&&result.replayExact);
  const conflict=structuredClone(first);conflict.points[0].speedMps=1;
  result.conflictStatus=(await call('/batches','POST',conflict)).status;check(result.conflictStatus===409);
  const removed=await call('/contributions','DELETE',deletion(fs[0]));
  result.deleteStatus=removed.status;result.deletedSyntheticBatchCount=removed.value.deletedBatchCount;check(removed.status===200&&removed.value.deletedBatchCount===1);
  result.lateBatchStatus=(await call('/batches','POST',first)).status;check(result.lateBatchStatus===403);
  for(let i=0;i<3;i++) {const r=await call('/batches','POST',batch(fs[1],i));check(r.status===(i===2?429:200));if(i===2)result.contributorLimitStatus=r.status;}
  const secondDeletion=await call('/contributions','DELETE',deletion(fs[1]));check(secondDeletion.status===200&&secondDeletion.value.deletedBatchCount===2);
  const raced=await Promise.all([call('/batches','POST',batch(fs[2])),call('/contributions','DELETE',deletion(fs[2]))]);
  result.raceBatchStatus=raced[0].status;result.raceDeleteStatus=raced[1].status;
  check([200,403].includes(result.raceBatchStatus)&&result.raceDeleteStatus===200);
  const contributorHashes=fs.map(f=>createHmac('sha256',h).update('cop:'+f.pseudonym).digest('hex'));
  const batchIds=fs.flatMap(f=>f.batchIds).map(value=>{const x=createHmac('sha256',h).update('cop:batch:'+value).digest('hex');return x.slice(0,8)+'-'+x.slice(8,12)+'-4'+x.slice(13,16)+'-8'+x.slice(17,20)+'-'+x.slice(20,32);});
  result.remainingSyntheticReceipts=(await pool.query('SELECT count(*)::int AS n FROM driver_measurement_receipts WHERE owner=$1 AND contributor_hash=ANY($2::text[])',['cop',contributorHashes])).rows[0].n;
  result.remainingSyntheticIntervals=(await pool.query('SELECT count(*)::int AS n FROM driver_measurement_intervals WHERE owner=$1 AND batch_id=ANY($2::uuid[])',['cop',batchIds])).rows[0].n;
  result.remainingSyntheticEta=(await pool.query('SELECT count(*)::int AS n FROM driver_measurement_eta WHERE owner=$1 AND batch_id=ANY($2::uuid[])',['cop',batchIds])).rows[0].n;
  result.syntheticTombstoneCount=(await pool.query('SELECT count(*)::int AS n FROM driver_measurement_revocations WHERE owner=$1 AND contributor_hash=ANY($2::text[]) AND expires_at>now()',['cop',contributorHashes])).rows[0].n;
  check(result.remainingSyntheticReceipts===0&&result.remainingSyntheticIntervals===0&&result.remainingSyntheticEta===0&&result.syntheticTombstoneCount===3);
  const aggregate=await call('/aggregates','GET');
  check(aggregate.status===200&&aggregate.value.applicationMode==='shadow_only'&&/^sim-routing-\\d{4}-\\d{2}-\\d{2}-\\d+$/.test(aggregate.value.routingDataset));
  result.aggregateStatus=aggregate.status;result.routingDataset=aggregate.value.routingDataset;
  result.simulatedPositionsOnly=true;result.raceContributionAbsentAfterDelete=true;
  console.log(JSON.stringify(result));
 }catch{console.log(JSON.stringify({...result,smokeFailed:true}));process.exitCode=1;}finally{await pool.end();}
`;
const cleanupScript = fixtures => `
 import {PostgresDriverMeasurementStore} from '/app/apps/situation-data-api/dist/driver-measurement-store.js';import {createHmac} from 'node:crypto';
 const h=process.env.DRIVER_MEASUREMENTS_HASH_SECRET, fs=${JSON.stringify(fixtures)};
 const store=new PostgresDriverMeasurementStore(process.env.DRIVER_MEASUREMENTS_DATABASE_URL,h);
 try{for(const f of fs)await store.revoke('cop',createHmac('sha256',h).update('cop:'+f.pseudonym).digest('hex'));console.log(JSON.stringify({syntheticCleanup:true}));}
 catch{process.exitCode=1;}finally{await store.close();}
`;

let lock, phase = 'preflight', before, originalText, composeArgs, configBefore, otherBefore,
  changed = false, recreateStarted = false, rollbackResult, proofDir, result, fixtures = [], copNormalIntakeEnabled;
const staged = [];
const recreate = value => run('docker', [...composeArgs, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'situation-data-api'], '/srv/sim', undefined, { ...process.env, [flag]: value });
const rollbackClosed = async () => {
  let verifiedRollback;
  try {
    phase = 'rollback_to_revocation_only'; const current = readFileSync(envPath, 'utf8');
    safe(stripFlag(current) === stripFlag(originalText), 'ROLLBACK_ENV_CONCURRENT_CHANGE');
    if (readFlag(current) !== 'false') writePrivateFlag('false', current, '.driver-shadow-rollback');
    recreate('false'); const restored = await waitHealthy();
    safe(environment(restored)[flag] === 'false' && environment(restored).DRIVER_MEASUREMENTS_REVOCATION_ENABLED === 'true' && digest(invariant(restored)) === digest(invariant(before)), 'ROLLBACK_RUNTIME_INVARIANTS_FAILED');
    verifiedRollback = { intakeDisabled: true, revocationEnabled: true, newPairedTokenRetained: true, hmacPreserved: true };
    safe(digest(others()) === digest(otherBefore), 'ANOTHER_CONTAINER_CHANGED');
    return verifiedRollback;
  } catch { return { ...verifiedRollback, failed: true, requiresAttention: true }; }
};
try {
  safe(['--enable', '--disable'].includes(mode), 'UNSUPPORTED_MODE');
  const approvedCopImage = process.argv[3] === '--cop-image-id' ? process.argv[4] : undefined;
  safe(mode === '--disable' ? process.argv.length === 3 : process.argv.length === 5 && /^sha256:[a-f0-9]{64}$/.test(approvedCopImage ?? ''), 'APPROVED_COP_IMAGE_REQUIRED');
  safe(process.env.COP_STORAGE_LOCK_FD === '9', 'COP_STORAGE_LOCK_NOT_INHERITED');
  safe(run('hostname').trim() === 'docker', 'HOST_MISMATCH');
  run('python3', ['scripts/cop-storage.py', 'preflight'], '/srv/cop');
  safe(run('findmnt', ['-n', '-o', 'UUID', '--mountpoint', '/srv/x5-production']).trim() === '2f93f595-b61b-4eea-9054-7afa9b275b5b', 'X5_MOUNT_MISMATCH');
  safe(!existsSync('/srv/sim/.deploy-search-boundary.lock') && !existsSync('/srv/sim/.driver-token-rotation.lock'), 'SIM_DEPLOYMENT_ACTIVE');
  lock = openSync('/srv/sim/.driver-shadow-pilot.lock', 'wx', 0o600);
  before = inspect(simName); const simEnv = environment(before), cop = inspect(copName), copEnv = environment(cop);
  safe(['true', 'false'].includes(copEnv.COP_DRIVER_MEASUREMENTS_ENABLED), 'INVALID_COP_INTAKE_FLAG');
  copNormalIntakeEnabled = copEnv.COP_DRIVER_MEASUREMENTS_ENABLED === 'true';
  safe(before.Image === expectedSimImage && before.State.Health?.Status === 'healthy', 'SIM_IMAGE_OR_HEALTH_MISMATCH');
  safe(simEnv.DRIVER_MEASUREMENTS_REVOCATION_ENABLED === 'true' && simEnv.DRIVER_MEASUREMENTS_HASH_SECRET?.length >= 32 && simEnv.DRIVER_MEASUREMENTS_COP_TOKEN?.length >= 32, 'SIM_REVOCATION_CONFIG_MISSING');
  safe(copEnv.COP_DRIVER_MEASUREMENTS_CLEANUP_ENABLED === 'true' && simEnv.DRIVER_MEASUREMENTS_COP_TOKEN === copEnv.COP_DRIVER_MEASUREMENTS_SIM_TOKEN, 'COP_CLEANUP_OR_PAIRED_TOKEN_MISMATCH');
  if (mode === '--enable') {
    safe(simEnv[flag] === 'false', 'INTAKE_MUST_BE_DISABLED_BEFORE_ENABLE');
    safe(cop.Image === approvedCopImage && cop.State.Health?.Status === 'healthy', 'APPROVED_COP_IMAGE_OR_HEALTH_MISMATCH');
    safe(copEnv.COP_DRIVER_MEASUREMENTS_ENABLED === 'false' && copEnv.COP_DRIVER_MEASUREMENTS_PILOT_ENABLED === 'true', 'COP_PILOT_BOUNDARY_MISSING');
    const subjects = (copEnv.COP_DRIVER_MEASUREMENTS_PILOT_SUBJECT_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
    safe(subjects.length === 1 && uuid.test(subjects[0]), 'SINGLE_UUID_PILOT_SUBJECT_REQUIRED');
    safe(Number(simEnv.DRIVER_MEASUREMENTS_RATE_PER_MINUTE) >= 15, 'PILOT_SMOKE_RATE_HEADROOM_LOW');
  } else safe(['true', 'false'].includes(simEnv[flag]), 'INVALID_RUNTIME_INTAKE_FLAG');
  const fileState = lstatSync(envPath);
  safe(fileState.isFile() && !fileState.isSymbolicLink() && (statSync(envPath).mode & 0o777) === 0o600, 'ENV_MODE_MISMATCH');
  originalText = readFileSync(envPath, 'utf8'); safe(readFlag(originalText) === simEnv[flag], 'ENV_RUNTIME_FLAG_DRIFT');
  const files = before.Config.Labels['com.docker.compose.project.config_files'].split(',');
  safe(JSON.stringify(files) === JSON.stringify(['/srv/sim/docker-compose.yml', '/srv/sim/docker-compose.x5.yml', '/srv/sim/docker-compose.driver-measurements.yml']), 'SIM_COMPOSE_MISMATCH');
  composeArgs = ['compose', '--project-name', 'sim', ...files.flatMap(file => ['-f', file])];
  configBefore = JSON.parse(run('docker', [...composeArgs, 'config', '--format', 'json']));
  const service = configBefore.services['situation-data-api'];
  safe(JSON.parse(run('docker', ['image', 'inspect', service.image]))[0].Id === expectedSimImage, 'SIM_IMAGE_TAG_CHANGED');
  for (const key of [flag, 'DRIVER_MEASUREMENTS_COP_TOKEN', 'DRIVER_MEASUREMENTS_HASH_SECRET', 'DRIVER_MEASUREMENTS_DATABASE_URL', 'DRIVER_MEASUREMENTS_REVOCATION_ENABLED'])
    safe(service.environment[key] === simEnv[key], 'ENV_RUNTIME_DRIFT');
  const network = JSON.parse(run('docker', ['network', 'inspect', 'cop_sim_driver_measurements_internal']))[0];
  safe(network.Internal === true && JSON.stringify(Object.values(network.Containers).map(value => value.Name).sort()) === JSON.stringify([simName, copName].sort()), 'INTERNAL_NETWORK_MISMATCH');
  otherBefore = others();
  // These external one-shot diagnostic jobs were present in two captured
  // baselines and finished during health acceptance. Wait for a quiet window;
  // do not exclude them from the unchanged-container invariant or stop them.
  if (mode === '--enable') safe(!otherBefore.some(line => line.startsWith('fkc-prep-scram-20261011-')), 'HOST_TEMPORARY_DIAGNOSTIC_ACTIVE');
  const targetValue = mode === '--enable' ? 'true' : 'false';
  const candidate = JSON.parse(run('docker', [...composeArgs, 'config', '--format', 'json'], '/srv/sim', undefined, { ...process.env, [flag]: targetValue }));
  safe(candidate.services['situation-data-api'].environment[flag] === targetValue, 'INTAKE_OVERRIDE_NOT_SUPPORTED');
  candidate.services['situation-data-api'].environment[flag] = simEnv[flag];
  safe(digest(candidate) === digest(configBefore), 'COMPOSE_CHANGED_BEYOND_INTAKE_FLAG');
  proofDir = '/srv/sim/.driver-shadow-pilot/' + new Date().toISOString().replaceAll(':', '-'); mkdirSync(proofDir, { recursive: true, mode: 0o700 });
  writeFileSync(proofDir + '/before.json', JSON.stringify({ at: new Date().toISOString(), image: before.Image, invariant: invariant(before), otherContainers: otherBefore, priorIntakeEnabled: simEnv[flag] === 'true', singlePilotSubject: mode === '--enable' }, null, 2), { mode: 0o600 });
  if (simEnv[flag] !== targetValue) {
    phase = 'flag_write'; writePrivateFlag(targetValue, originalText, '.driver-shadow-next'); changed = true;
    phase = 'compose_acceptance';
    const selected = JSON.parse(run('docker', [...composeArgs, 'config', '--format', 'json']));
    safe(selected.services['situation-data-api'].environment[flag] === targetValue, 'NEW_INTAKE_FLAG_NOT_SELECTED');
    selected.services['situation-data-api'].environment[flag] = simEnv[flag]; safe(digest(selected) === digest(configBefore), 'COMPOSE_CHANGED_BEYOND_INTAKE_FLAG');
    phase = 'sim_recreate'; recreateStarted = true; recreate(targetValue);
  }
  phase = 'runtime_acceptance'; const after = await waitHealthy();
  safe(environment(after)[flag] === targetValue && environment(after).DRIVER_MEASUREMENTS_REVOCATION_ENABLED === 'true', 'RUNTIME_INTAKE_FLAG_MISMATCH');
  safe(digest(invariant(after)) === digest(invariant(before)), 'SIM_INVARIANTS_CHANGED');
  safe(stripFlag(readFileSync(envPath, 'utf8')) === stripFlag(originalText), 'UNRELATED_ENV_CHANGE');
  safe(digest(others()) === digest(otherBefore), 'ANOTHER_CONTAINER_CHANGED');
  let smoke;
  if (mode === '--enable') {
    fixtures = Array.from({ length: 3 }, () => ({ pseudonym: 'synthetic-shadow-pilot-' + randomUUID(), batchIds: Array.from({ length: 3 }, () => randomUUID()), sampleIds: Array.from({ length: 3 }, () => randomUUID()) }));
    phase = 'synthetic_shadow_acceptance'; smoke = containerScript(smokeScript(fixtures));
    safe(!smoke.smokeFailed && smoke.applicationMode === 'shadow_only' && smoke.simulatedAcceptedIntervals === 0, 'SYNTHETIC_SHADOW_ACCEPTANCE_FAILED');
  } else {
    smoke = containerScript(`const b='http://127.0.0.1:4020/api/v1/internal/driver-measurements/v1';const h={'Authorization':'Bearer '+process.env.DRIVER_MEASUREMENTS_COP_TOKEN,'Content-Type':'application/json'};try{const r=await fetch(b+'/batches',{method:'POST',signal:AbortSignal.timeout(10000),headers:h,body:'{}'});await r.arrayBuffer();const d=await fetch(b+'/contributions',{method:'DELETE',signal:AbortSignal.timeout(10000),headers:h,body:'{}'});await d.arrayBuffer();if(r.status!==503||d.status!==400)throw new Error('SMOKE');console.log(JSON.stringify({disabledIntakeStatus:r.status,revocationValidationStatus:d.status}));}catch{process.exitCode=1;}`);
  }
  result = { status: mode === '--enable' ? 'sim_shadow_receiver_pilot_enabled' : 'sim_shadow_receiver_disabled', at: new Date().toISOString(), simImage: after.Image, intakeEnabled: targetValue === 'true', revocationEnabled: true, pairedTokenPreserved: true, hmacPreserved: true, onlySimRecreated: changed, copNormalIntakeEnabled, singlePilotSubject: mode === '--enable', applicationMode: 'shadow_only', physicalIphoneAccepted: false, liveTrafficOrEtaEnabled: false, smoke, proofDir };
} catch (error) {
  const failurePhase = phase;
  if (mode === '--enable' && (changed || recreateStarted) && before && originalText && composeArgs) {
    rollbackResult = await rollbackClosed();
  }
  result = { status: 'failed', phase: failurePhase, errorCode: /^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'DIAGNOSTIC_CAPTURE_SUPPRESSED', intakeEnabled: rollbackResult?.intakeDisabled ? false : undefined, rollback: rollbackResult, proofDir };
  process.exitCode = 1;
} finally {
  if (fixtures.length) {
    try { safe(containerScript(cleanupScript(fixtures)).syntheticCleanup === true, 'SYNTHETIC_CLEANUP_FAILED'); }
    catch { result = { ...result, status: 'failed', syntheticCleanup: false, requiresAttention: true }; process.exitCode = 1; }
  }
  for (const path of staged) if (existsSync(path)) {
    try { unlinkSync(path); } catch { result = { ...result, status: 'failed', privateStagingCleanupFailed: true }; process.exitCode = 1; }
  }
}
try { if (proofDir && result) writeFileSync(proofDir + '/after.json', JSON.stringify(result, null, 2), { mode: 0o600 }); }
catch { result = { ...result, status: 'failed', proofWriteFailed: true }; process.exitCode = 1; }
// Keep the SIM marker and inherited COP flock throughout fail-closed handling.
// A cleanup / proof failure after successful smoke must not leave intake on.
if (process.exitCode && mode === '--enable' && (changed || recreateStarted) && before && originalText && composeArgs && !rollbackResult?.intakeDisabled) {
  rollbackResult = await rollbackClosed();
  result = { ...result, status: 'failed', intakeEnabled: rollbackResult.intakeDisabled ? false : undefined, rollback: rollbackResult };
  try { if (proofDir) writeFileSync(proofDir + '/after.json', JSON.stringify(result, null, 2), { mode: 0o600 }); }
  catch { result = { ...result, proofWriteFailed: true }; }
}
if (lock !== undefined) {
  try { unlinkSync('/srv/sim/.driver-shadow-pilot.lock'); }
  catch {
    result = { ...result, status: 'failed', lockCleanupFailed: true }; process.exitCode = 1;
    if (mode === '--enable' && (changed || recreateStarted) && !rollbackResult?.intakeDisabled) {
      rollbackResult = await rollbackClosed();
      result = { ...result, intakeEnabled: rollbackResult.intakeDisabled ? false : undefined, rollback: rollbackResult };
    }
    try { if (proofDir) writeFileSync(proofDir + '/after.json', JSON.stringify(result, null, 2), { mode: 0o600 }); }
    catch { result = { ...result, proofWriteFailed: true }; }
  }
  try { closeSync(lock); } catch {
    result = { ...result, status: 'failed', lockCloseFailed: true }; process.exitCode = 1;
    if (mode === '--enable' && (changed || recreateStarted) && !rollbackResult?.intakeDisabled) {
      rollbackResult = await rollbackClosed();
      result = { ...result, intakeEnabled: rollbackResult.intakeDisabled ? false : undefined, rollback: rollbackResult };
    }
    try { if (proofDir) writeFileSync(proofDir + '/after.json', JSON.stringify(result, null, 2), { mode: 0o600 }); }
    catch { result = { ...result, proofWriteFailed: true }; }
  }
}
console.log(JSON.stringify(result ?? { status: 'failed', errorCode: 'RESULT_UNAVAILABLE' }));
