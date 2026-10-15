/** NEW isolated SQL007 gate. Main alone executes after full source review.
 * No production, Root authority, provider, image build/pull or old-evidence run.
 * Reuses SQL006's actual role/schema bootstrap in a fresh Linux PG18.6 cluster.
 */
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

assert.deepEqual(process.argv.slice(2), ['--run']);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), self = fileURLToPath(import.meta.url);
const fixture = join(repo, 'scripts/fixtures/driver-eta-binding/harness.mjs');
const receiptPath = join(repo, 'docs/archive/2026-10-15_DRIVER_ETA_CONTRIBUTOR_BINDING_SQL.json');
assert.ok(!existsSync(receiptPath), 'Never overwrite previous evidence.');
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const selfPin = hash(await readFile(self));
const nodeImage = 'sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf';
const postgresImage = 'sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
const sqlPins: Record<string, string> = {
  'schema.sql': '6dd60a3acf28d63575198c8526c368df19bbd543f4063d4985fb55f308da02d0',
  '002_account_erasure.sql': 'f13db2106a1fe1a02d0d1a26afa8ad7d7c045172ba4419749719ed0f166e16ad',
  '003_guarded_operations.sql': 'e3513a983a3b6d1bd52d46851c734dd1c3b208e2e2f6430a6f9eddd38b10d3b5',
  '004_read_admission_facts.sql': '791545b9df91e65bb555c68a44dadd73a847ca64fde0c31a9036f9f555ba1d2d',
  '005_root_checkpoint.sql': '77faac125f6133a774e6d9e900c2dcbfc3b86419d3179bfb4d5bcf64eb3bb3cb',
  '006_inventory_candidates.sql': 'bd69ca4e58746c852b49bf0ad1f59465a64fc781a59c4c9fe88073199080efe0',
  '007_eta_contributor_binding.sql': '135acb29c58734e232891aa9b61fac3e6520b6dd7209a57dbd5dc8240fbc5942',
};
const purePath = join(repo, 'deploy/driver-measurements/read-admission-facts.mjs');
const purePin = '756d25ae2ce00c9a02a6295a5d00812732a04b01ace82c347f68e58a902d0456';
const frozenPins: Record<string, string> = {
  [join(repo, 'scripts/test-driver-inventory-candidates-postgres.mts')]: 'b4dd82d5a95826d934697544a22117ebf602e62330fdc61f731969183eb27ab2',
  [join(repo, 'docs/archive/2026-10-15_DRIVER_INVENTORY_CANDIDATES_SQL.json')]: 'b9c698eb6eb38a25517e17198849a0ca5814d8953d07c83436e4cc7f00e266c2',
};
const sourcePins: Record<string, string> = {[self]: selfPin, [fixture]: hash(await readFile(fixture)), [purePath]: purePin};
for (const [name, pin] of Object.entries(sqlPins)) sourcePins[join(repo, 'deploy/driver-measurements', name)] = pin;
for (const [path, pin] of Object.entries({...sourcePins, ...frozenPins})) assert.equal(hash(await readFile(path)), pin, 'Pinned input changed: ' + path);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR'].includes(key)));
const execute = promisify(execFile);
const docker = (args: string[], timeout = 30000) => execute('docker', ['--host', 'unix:///Users/voldzi/.docker/run/docker.sock', ...args], {env, timeout, maxBuffer: 3 * 1024 * 1024});
for (const id of [nodeImage, postgresImage]) {
  const actual = JSON.parse((await docker(['image', 'inspect', id])).stdout)[0];
  assert.equal(actual.Id, id); assert.equal(actual.Os, 'linux'); assert.equal(actual.Architecture, 'arm64');
}
const umask = process.umask(0o077), tmp = await mkdtemp('/private/tmp/sim-driver-eta-binding-');
assert.equal(dirname(await realpath(tmp)), '/private/tmp');
const owned: string[] = [], packages: Record<string, string> = {}, suffix = randomBytes(6).toString('hex'), startedAt = new Date().toISOString();
let success = false, cleanup = true, receipt: any;
try {
  const tree = join(tmp, 'modules'), stage = join(tmp, 'fixture');
  await mkdir(join(tree, 'node_modules'), {recursive: true, mode: 0o700}); await mkdir(join(stage, 'sql'), {recursive: true, mode: 0o700});
  await writeFile(join(tree, 'package.json'), '{"private":true,"type":"module"}\n', {mode: 0o600});
  // Copy only the installed pg closure as ordinary files, never workspace links,
  // an app tree, .env, credentials, native Root helpers or an existing database.
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
      const path = join(parent, 'node_modules', item.name, 'package.json');
      if (existsSync(path)) {version = JSON.parse(await readFile(path, 'utf8')).version; break;}
      if (parent === tree) break; assert.ok(parent.startsWith(tree + '/'));
    }
    if (version === data.version) continue;
    const target = join(item.parent, 'node_modules', item.name); assert.ok(!existsSync(target)); packages[relative(tree, target)] = data.version;
    await cp(directory, target, {recursive: true, dereference: true,
      filter: path => !path.split('/').slice(directory!.split('/').length).some(part => part === 'node_modules' || part === '.git' || part.startsWith('.env'))});
    for (const name of Object.keys(data.dependencies ?? {})) queue.push({name, from: join(directory, 'package.json'), optional: false, parent: target});
    for (const name of Object.keys(data.optionalDependencies ?? {})) queue.push({name, from: join(directory, 'package.json'), optional: true, parent: target});
  }
  const manifest: Record<string, string> = {'/fixture/harness.mjs': sourcePins[fixture], '/sql-test/read-admission-facts.mjs': purePin};
  await cp(fixture, join(stage, 'harness.mjs')); await cp(purePath, join(tree, 'read-admission-facts.mjs'));
  for (const [name, pin] of Object.entries(sqlPins)) {await cp(join(repo, 'deploy/driver-measurements', name), join(stage, 'sql', name)); manifest['/fixture/sql/' + name] = pin;}
  await writeFile(join(stage, 'source-pins.json'), JSON.stringify(manifest) + '\n', {mode: 0o600});
  const create = async (name: string, args: string[]) => {
    const id = (await docker(['create', '--pull', 'never', '--name', name, '--label', 'csm.sim.test=driver-eta-binding-20261015', ...args])).stdout.trim();
    assert.match(id, /^[0-9a-f]{64}$/); owned.push(id); return id;
  };
  const node = await create('sim-eta-node-source-' + suffix, ['--network', 'none', '--entrypoint', '/usr/local/bin/node', nodeImage, '--version']);
  const pg = await create('sim-driver-eta-binding-' + suffix, ['--network', 'none', '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
    '--tmpfs', '/var/lib/postgresql:rw,nosuid,nodev,size=268435456', '--tmpfs', '/tmp:rw,nosuid,nodev,size=33554432',
    '--entrypoint', '/bin/sh', postgresImage, '-c', 'exec sleep 600']);
  for (const [source, name, target] of [['/usr/local/bin/node', 'node', '/usr/local/bin/node'],
    ['/usr/lib/libstdc++.so.6', 'libstdc++.so.6', '/usr/lib/libstdc++.so.6'], ['/usr/lib/libgcc_s.so.1', 'libgcc_s.so.1', '/usr/lib/libgcc_s.so.1']]) {
    await docker(['cp', '-L', node + ':' + source, join(tmp, name)]); await docker(['cp', join(tmp, name), pg + ':' + target]);
  }
  await docker(['start', pg]); await docker(['exec', pg, 'mkdir', '-p', '/sql-test', '/fixture']);
  await docker(['cp', tree + '/.', pg + ':/sql-test']); await docker(['cp', stage + '/.', pg + ':/fixture']);
  await docker(['exec', pg, 'chown', '-R', '0:0', '/sql-test', '/fixture']); await docker(['exec', pg, 'chmod', '-R', 'go-w', '/sql-test', '/fixture']);
  const inspect = JSON.parse((await docker(['inspect', pg])).stdout)[0];
  assert.equal(inspect.HostConfig.NetworkMode, 'none'); assert.equal(inspect.HostConfig.Privileged, false);
  assert.equal((inspect.Mounts ?? []).filter((entry: any) => entry.Type === 'bind' || entry.Type === 'volume').length, 0);
  assert.equal(Object.keys(inspect.HostConfig.PortBindings ?? {}).length, 0);
  const output = await docker(['exec', pg, '/usr/local/bin/node', '/fixture/harness.mjs', '--run'], 150000);
  const result = JSON.parse(output.stdout.trim().split('\n').at(-1)!);
  assert.equal(result.contractVersion, 'sim-driver-eta-binding-sql-test-v1'); assert.equal(result.passed, 6); assert.equal(result.cases.length, 6);
  assert.ok(result.cases.every((entry: any) => entry.passed === true)); assert.equal(result.rootAuthorityVerified, false);
  assert.equal(result.cleanup.clusterStopped, true); assert.equal(result.cleanup.connectionsClosed, true);
  for (const [path, pin] of Object.entries({...sourcePins, ...frozenPins})) assert.equal(hash(await readFile(path)), pin);
  receipt = {status: 'SOURCE_DRIVER_ETA_CONTRIBUTOR_BINDING_SQL_ONLY', startedAt, completedAt: new Date().toISOString(), result,
    sourcePins, frozenPins, stagedSourcePins: manifest, packageVersions: packages, images: {node: nodeImage, postgres: postgresImage},
    isolation: {newOwnedCluster: true, externalNetwork: false, hostBindMounts: false, volumes: false, publicPorts: false, tcpListener: false,
      imagePull: false, imageBuild: false, nodeSourceContainerStarted: false},
    actual: {productionChanged: false, rootAuthorityVerified: false, rootSignaturesVerified: false, nativeTransport: false, realAccounts: false,
      providerCalls: 0, restoreAccepted: false, deploymentAccepted: false, wholeAccountComplete: false}};
  success = true;
} finally {
  for (const id of owned.reverse()) await docker(['rm', '-f', '-v', id]).catch(() => {cleanup = false;});
  process.umask(umask);
  if (success && cleanup) {assert.equal((await stat(tmp)).uid, process.getuid!()); await rm(tmp, {recursive: true});}
  else console.error('Private failed ETA-binding fixture retained: ' + tmp);
}
assert.ok(success && cleanup, 'Owned resources must be removed before evidence.');
receipt.cleanup = {ownedContainersRemoved: true, privateContextRemoved: true, globalPrune: false};
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
console.log(JSON.stringify({receiptPath, passed: 6, productionChanged: false}));
