/** NEW isolated source-refresh SQL CAS gate. Main alone executes it.
 * No Root authority, signatures, native transport, real accounts or providers.
 * Existing 8/22/retention evidence is never rerun, rewritten or counted here.
 */
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

assert.deepEqual(process.argv.slice(2), ['--run']);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), self = fileURLToPath(import.meta.url);
const receiptPath = join(repo, 'docs/archive/2026-10-15_SOURCE_REFRESH_CAS_SQL.json');
assert.ok(!existsSync(receiptPath), 'Never overwrite previous evidence.');
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const selfPin = hash(await readFile(self)), fixture = join(repo, 'scripts/fixtures/source-refresh-cas/harness.mjs');
const nodeImage = 'sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf';
const postgresImage = 'sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
const sql = {
  '001-guard-metadata.sql': {path: '/Users/voldzi/Documents/Codex/2026-07-19/upgrade-proxmox-clusteru-c-lem-je-2/reports/cop-account-safety-20261014/isolated-continuity/001-guard-metadata.sql',
    sha256: 'a29369e48a1380bb12ce3b40b9254d924e0d98a3b90f7cdcdc0fb7e9ba27aaba'},
  '002-root-reader.sql': {path: '/private/tmp/cop-runtime-source-recovery-20261013/scripts/account-safety/002-root-reader.sql',
    sha256: '9a08e4174f25a64cf9c1897d5df1c9b772d7ab072c5bb8cffc5a8f0e7939476a'},
  '004_source_refresh_cas.sql': {path: join(repo, 'deploy/account-safety/004_source_refresh_cas.sql'), sha256: '48dbf4f816af0b89c913a5361ae9ddf61b827dc61db0ce242100ea5189a958cf'},
};
// Actual reviewed migration bytes, never a test-local RPC implementation.
for (const input of Object.values(sql)) {assert.match(input.sha256, /^[0-9a-f]{64}$/); assert.equal(hash(await readFile(input.path)), input.sha256);}
const sourcePins: Record<string, string> = {[self]: selfPin, [fixture]: hash(await readFile(fixture))};
for (const input of Object.values(sql)) sourcePins[input.path] = input.sha256;
const frozenEvidence: Record<string, string> = {};
for (const name of ['2026-10-15_ROOT_OWNER_AUTHORITY.json', '2026-10-15_ROOT_OWNER_POLICY_LINEAGE.json', '2026-10-14_DRIVER_RETENTION_LIFECYCLE.json']) {
  const path = join(repo, 'docs/archive', name); assert.ok(existsSync(path)); frozenEvidence[path] = hash(await readFile(path));
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR'].includes(key)));
const execute = promisify(execFile);
const docker = (args: string[], timeout = 30000) => execute('docker', ['--host', 'unix:///Users/voldzi/.docker/run/docker.sock', ...args], {env, timeout, maxBuffer: 3 * 1024 * 1024});
for (const id of [nodeImage, postgresImage]) {
  const value = JSON.parse((await docker(['image', 'inspect', id])).stdout)[0]; assert.equal(value.Id, id); assert.equal(value.Os, 'linux'); assert.equal(value.Architecture, 'arm64');
}
const umask = process.umask(0o077), tmp = await mkdtemp('/private/tmp/sim-source-refresh-cas-');
assert.equal(dirname(await realpath(tmp)), '/private/tmp');
const owned: string[] = [], packages: Record<string, string> = {}, suffix = randomBytes(6).toString('hex'), startedAt = new Date().toISOString();
let success = false, cleanup = true, receipt: any;
try {
  const tree = join(tmp, 'modules'), stage = join(tmp, 'fixture');
  await mkdir(join(tree, 'node_modules'), {recursive: true, mode: 0o700}); await mkdir(join(stage, 'sql'), {recursive: true, mode: 0o700});
  await writeFile(join(tree, 'package.json'), '{"private":true,"type":"module"}\n', {mode: 0o600});
  // Only the actual installed pg closure, ordinary files rather than pnpm
  // links. No app code, .env, key, native addon or entire checkout is staged.
  const queue = [{name: 'pg', from: join(repo, 'apps/situation-data-api/package.json'), optional: false, parent: tree}];
  while (queue.length) {
    const item = queue.shift()!; let directory: string | undefined, data: any;
    for (const parent of createRequire(item.from).resolve.paths(item.name) ?? []) {
      const path = join(parent, item.name, 'package.json'); if (!existsSync(path)) continue;
      directory = await realpath(dirname(path)); data = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); assert.equal(data.name, item.name); break;
    }
    if (!directory) {if (item.optional) continue; throw new Error('Installed pg dependency missing.');}
    let version: string | undefined;
    for (let parent = item.parent;; parent = dirname(parent)) {
      const path = join(parent, 'node_modules', item.name, 'package.json'); if (existsSync(path)) {version = JSON.parse(await readFile(path, 'utf8')).version; break;}
      if (parent === tree) break; assert.ok(parent.startsWith(tree + '/'));
    }
    if (version === data.version) continue;
    const target = join(item.parent, 'node_modules', item.name); assert.ok(!existsSync(target)); packages[relative(tree, target)] = data.version;
    await cp(directory, target, {recursive: true, dereference: true,
      filter: path => !path.split('/').slice(directory!.split('/').length).some(part => part === 'node_modules' || part === '.git' || part.startsWith('.env'))});
    for (const name of Object.keys(data.dependencies ?? {})) queue.push({name, from: join(directory, 'package.json'), optional: false, parent: target});
    for (const name of Object.keys(data.optionalDependencies ?? {})) queue.push({name, from: join(directory, 'package.json'), optional: true, parent: target});
  }
  const manifest: Record<string, string> = {'/fixture/harness.mjs': sourcePins[fixture]};
  await cp(fixture, join(stage, 'harness.mjs'));
  for (const [name, input] of Object.entries(sql)) {await cp(input.path, join(stage, 'sql', name)); manifest['/fixture/sql/' + name] = input.sha256;}
  await writeFile(join(stage, 'source-pins.json'), JSON.stringify(manifest) + '\n', {mode: 0o600});
  const create = async (name: string, args: string[]) => {
    const id = (await docker(['create', '--pull', 'never', '--name', name, '--label', 'csm.sim.test=source-refresh-cas-20261015', ...args])).stdout.trim();
    assert.match(id, /^[0-9a-f]{64}$/); owned.push(id); return id;
  };
  const node = await create('sim-refresh-node-source-' + suffix, ['--network', 'none', '--entrypoint', '/usr/local/bin/node', nodeImage, '--version']);
  const pg = await create('sim-refresh-cas-' + suffix, ['--network', 'none', '--memory', '512m', '--cpus', '2', '--pids-limit', '128',
    '--tmpfs', '/var/lib/postgresql:rw,nosuid,nodev,size=268435456', '--tmpfs', '/tmp:rw,nosuid,nodev,size=33554432',
    '--entrypoint', '/bin/sh', postgresImage, '-c', 'exec sleep 600']);
  for (const [source, name, target] of [['/usr/local/bin/node', 'node', '/usr/local/bin/node'],
    ['/usr/lib/libstdc++.so.6', 'libstdc++.so.6', '/usr/lib/libstdc++.so.6'], ['/usr/lib/libgcc_s.so.1', 'libgcc_s.so.1', '/usr/lib/libgcc_s.so.1']]) {
    await docker(['cp', '-L', node + ':' + source, join(tmp, name)]); await docker(['cp', join(tmp, name), pg + ':' + target]);
  }
  await docker(['start', pg]); await docker(['exec', pg, 'mkdir', '-p', '/sql-test', '/fixture']);
  await docker(['cp', tree + '/.', pg + ':/sql-test']); await docker(['cp', stage + '/.', pg + ':/fixture']);
  await docker(['exec', pg, 'chown', '-R', '0:0', '/sql-test', '/fixture']); await docker(['exec', pg, 'chmod', '-R', 'go-w', '/sql-test', '/fixture']);
  const inspect = JSON.parse((await docker(['inspect', pg])).stdout)[0]; assert.equal(inspect.HostConfig.NetworkMode, 'none'); assert.equal(inspect.HostConfig.Privileged, false);
  assert.equal((inspect.Mounts ?? []).filter((entry: any) => entry.Type === 'bind' || entry.Type === 'volume').length, 0); assert.equal(Object.keys(inspect.HostConfig.PortBindings ?? {}).length, 0);
  const result = JSON.parse((await docker(['exec', pg, '/usr/local/bin/node', '/fixture/harness.mjs', '--run'], 150000)).stdout.trim().split('\n').at(-1)!);
  assert.equal(result.contractVersion, 'sim-source-refresh-cas-sql-test-v1'); assert.equal(result.passed, 8); assert.equal(result.cases.length, 8);
  assert.ok(result.cases.every((entry: any) => entry.passed === true)); assert.equal(result.rootAuthorityVerified, false); assert.equal(result.lostCommitExercised, false);
  for (const [path, pin] of Object.entries({...sourcePins, ...frozenEvidence})) assert.equal(hash(await readFile(path)), pin);
  receipt = {status: 'SOURCE_REFRESH_CAS_SQL_ONLY', startedAt, completedAt: new Date().toISOString(), result, sourcePins, frozenEvidence,
    stagedSourcePins: manifest, packageVersions: packages, images: {node: nodeImage, postgres: postgresImage},
    isolation: {newOwnedCluster: true, externalNetwork: false, hostBindMounts: false, volumes: false, publicPorts: false, tcpListener: false, imagePull: false, imageBuild: false, sourceContainersStarted: false},
    actual: {productionChanged: false, rootAuthorityVerified: false, rootSignaturesVerified: false, nativeTransport: false, realAccounts: false,
      providerCalls: 0, lostCommitExercised: false, restoreAccepted: false, deploymentAccepted: false, wholeAccountComplete: false}};
  success = true;
} finally {
  for (const id of owned.reverse()) await docker(['rm', '-f', '-v', id]).catch(() => {cleanup = false;});
  process.umask(umask);
  if (success && cleanup) {assert.equal((await stat(tmp)).uid, process.getuid!()); await rm(tmp, {recursive: true});}
  else console.error('Private failed source-refresh SQL fixture retained: ' + tmp);
}
assert.ok(success && cleanup, 'Owned resources must be removed before evidence.');
receipt.cleanup = {ownedContainersRemoved: true, privateContextRemoved: true, globalPrune: false};
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
console.log(JSON.stringify({receiptPath, passed: 8, productionChanged: false}));
