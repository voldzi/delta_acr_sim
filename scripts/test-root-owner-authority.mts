/** NEW source-only Root common integration harness. Main alone executes it.
 * No external target, image pull/build, host bind, public port, secret import
 * or production enrollment. Previous runners/receipts are immutable inputs.
 */
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

assert.equal(process.argv.length, 5); assert.equal(process.argv[2], '--run'); assert.equal(process.argv[3], '--cop-source');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), cop = resolve(process.argv[4]);
const receiptPath = join(repo, 'docs/archive/2026-10-15_ROOT_OWNER_AUTHORITY.json');
assert.ok(!existsSync(receiptPath), 'Never overwrite previous evidence.');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const selfPath = fileURLToPath(import.meta.url), selfPin = hash(await readFile(selfPath));
const fixturePath = join(repo, 'scripts/fixtures/root-owner-authority/harness.mjs');
const sourcePins: Record<string, string> = {}, packages: Record<string, string> = {};
const nodeImage = 'sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf';
const postgresImage = 'sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
const metadataSource = '/Users/voldzi/Documents/Codex/2026-07-19/upgrade-proxmox-clusteru-c-lem-je-2/reports/cop-account-safety-20261014/isolated-continuity/001-guard-metadata.sql';
const metadataPin = 'a29369e48a1380bb12ce3b40b9254d924e0d98a3b90f7cdcdc0fb7e9ba27aaba';
assert.equal(hash(await readFile(metadataSource)), metadataPin);
const readerMetadataSource = join(cop, 'scripts/account-safety/002-root-reader.sql');
const readerMetadataPin = '9a08e4174f25a64cf9c1897d5df1c9b772d7ab072c5bb8cffc5a8f0e7939476a';
assert.equal(hash(await readFile(readerMetadataSource)), readerMetadataPin);
const frozen = 'scripts/fixtures/driver-read-keyring/harness.mjs';
const frozenPin = '8992fdd14310ed9fece233ba0a3a8eea7272c4740550f9a863bede8a1a5c0c85';
assert.equal(hash(await readFile(join(repo, frozen))), frozenPin);
const helperPin = 'ad203b1a1858bea7f8f799a6147720d1d0d6df790bfc1d4c866a12c45d6bb7fd';
assert.equal(hash(await readFile(join(cop, 'scripts/account-safety/root-records.mjs'))), helperPin);
const nativeSource = '/private/tmp/cop-root-seqpacket-arm64-20261015.node';
const nativePin = '283f528f6ffce67c46e180a8a7ddcf215c1588dd579cbf36ca507b8896802d20';
assert.equal(hash(await readFile(nativeSource)), nativePin);
// Only actual fixed Root source files enter this closure. No .env, credentials,
// arbitrary native addon, entire checkout or application node_modules tree is
// copied. The one separately pinned actual addon provides kernel SELF identity.
const candidates = new Map<string, string>();
for (const entry of await readdir(join(cop, 'scripts/account-safety'), {withFileTypes: true})) {
  if (!entry.isFile() || !entry.name.endsWith('.mjs') || entry.name.endsWith('.test.mjs') || /^(?:test-|run-)/.test(entry.name)) continue;
  candidates.set(entry.name, join(cop, 'scripts/account-safety', entry.name));
}
for (const entry of await readdir(join(repo, 'deploy/account-safety'), {withFileTypes: true})) {
  if (entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs'))
    candidates.set(entry.name, join(repo, 'deploy/account-safety', entry.name));
}
for (const [directory, names] of Object.entries({
  'driver-measurements': ['read-admission-facts.mjs', 'root-read-admission.mjs'],
  'ai-router': ['checkpoint-facts.mjs', 'root-checkpoint-read.mjs'],
})) for (const name of names) candidates.set(name, join(repo, 'deploy', directory, name));
for (const [name, pin] of Object.entries({
  'driver-account-erasure.js': 'd184e31dda5484d4d8d2382208834197247ff47a1a37437f4f0550fdd95ea999',
  'driver-revocation-actor.js': '43116e10d8616f1320593b32a76dfdb7c15f6718f8b17e1f3b84bfc40efbe7fa',
})) {
  const path = join(repo, 'apps/situation-data-api/dist', name); assert.equal(hash(await readFile(path)), pin); candidates.set(name, path);
}
// Traverse the actual fixed import closure only. Unused COP producer/watch
// files are not copied merely because they happen to share this directory.
const inputs = new Map<string, string>(), pending = ['root-owner-authority.mjs', 'root-owner-read.mjs'];
while (pending.length) {
  const name = pending.pop()!; if (inputs.has(name)) continue;
  assert.match(name, /^[a-z][a-z0-9-]*\.(?:mjs|js)$/); const path = candidates.get(name); assert.ok(path, 'Fixed dependency missing: ' + name);
  inputs.set(name, path); const text = await readFile(path, 'utf8');
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]\.\/([^'"]+)['"]|['"]\/opt\/cop-account-safety\/([a-z][a-z0-9-]*\.(?:mjs|js))['"]/g))
    pending.push(match[1] ?? match[2]);
}
for (const name of ['root-owner-authority.mjs', 'root-owner-authority-protocol.mjs', 'root-owner-read.mjs', 'root-jws.mjs', 'root-record-issuer.mjs']) assert.ok(inputs.has(name));
for (const [name, pin] of Object.entries({
  'root-owner-authority.mjs': '4842899595b9b2efa9c913057ad1978208e44042ee39d7f009faf49565921d06',
  'root-owner-authority-protocol.mjs': '0fab874389fdc5660241f7b26ead63a7b9003b06915a78dcbec4b744614632a3',
})) assert.equal(hash(await readFile(inputs.get(name)!)), pin);
const sql = new Map<string, string>([['metadata/001-guard-metadata.sql', metadataSource], ['metadata/002-root-reader.sql', readerMetadataSource]]);
for (const [directory, names] of Object.entries({
  driver: ['schema.sql', '002_account_erasure.sql', '003_guarded_operations.sql', '004_read_admission_facts.sql', '005_root_checkpoint.sql', '006_inventory_candidates.sql'],
  ai: ['001_schema.sql', '002_separate_billing.sql', '003_account_erasure.sql', '004_root_checkpoint_facts.sql', '005_root_checkpoint.sql'],
})) for (const name of names) sql.set(directory + '/' + name, join(repo, 'deploy', directory === 'driver' ? 'driver-measurements' : 'ai-router', name));
for (const path of new Set([...inputs.values(), ...sql.values(), nativeSource, fixturePath, join(repo, frozen)])) sourcePins[path] = hash(await readFile(path));
const execute = promisify(execFile);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR'].includes(key)));
const docker = async (args: string[], timeout = 30_000) => execute('docker', ['--host', 'unix:///Users/voldzi/.docker/run/docker.sock', ...args],
  {env, timeout, maxBuffer: 3 * 1024 * 1024});
for (const id of [nodeImage, postgresImage]) {
  const info = JSON.parse((await docker(['image', 'inspect', id])).stdout)[0];
  assert.equal(info.Id, id); assert.equal(info.Os, 'linux'); assert.equal(info.Architecture, 'arm64');
}
const previousUmask = process.umask(0o077), tmp = await mkdtemp('/private/tmp/sim-root-owner-authority-');
assert.equal(dirname(await realpath(tmp)), '/private/tmp');
const suffix = randomBytes(6).toString('hex'), containers: string[] = [], startedAt = new Date().toISOString();
let success = false, cleanupComplete = true, receipt: any;
try {
  const tree = join(tmp, 'root-tree'); await mkdir(join(tree, 'node_modules'), {recursive: true, mode: 0o700});
  await writeFile(join(tree, 'package.json'), '{"private":true,"type":"module"}\n', {mode: 0o600});
  for (const [name, path] of inputs) await cp(path, join(tree, name));
  await mkdir(join(tree, 'native'), {mode: 0o700});
  await cp(nativeSource, join(tree, 'native/root-seqpacket.node'));
  // Same nearest-package/dereferenced dependency mechanics as the reviewed new
  // layout runner. pg is real and unpatched; no registry/provider callback.
  const queue = [{name: 'pg', from: join(repo, 'apps/situation-data-api/package.json'), optional: false, parent: tree}];
  while (queue.length) {
    const item = queue.shift()!; let directory: string | undefined, data: any;
    for (const parent of createRequire(item.from).resolve.paths(item.name) ?? []) {
      const candidate = join(parent, item.name, 'package.json'); if (!existsSync(candidate)) continue;
      directory = await realpath(dirname(candidate)); data = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); assert.equal(data.name, item.name); break;
    }
    if (!directory) { if (item.optional) continue; throw new Error('Installed dependency metadata is missing.'); }
    let foundVersion: string | undefined;
    for (let parent = item.parent;; parent = dirname(parent)) {
      const candidate = join(parent, 'node_modules', item.name, 'package.json');
      if (existsSync(candidate)) { foundVersion = JSON.parse(await readFile(candidate, 'utf8')).version; break; }
      if (parent === tree) break; assert.ok(parent.startsWith(tree + '/'));
    }
    if (foundVersion === data.version) continue;
    const target = join(item.parent, 'node_modules', item.name); assert.ok(!existsSync(target)); packages[relative(tree, target)] = data.version;
    await cp(directory, target, {recursive: true, dereference: true,
      filter: path => !path.split('/').slice(directory!.split('/').length).some(part => part === 'node_modules' || part === '.git' || part.startsWith('.env'))});
    for (const name of Object.keys(data.dependencies ?? {})) queue.push({name, from: join(directory, 'package.json'), optional: false, parent: target});
    for (const name of Object.keys(data.optionalDependencies ?? {})) queue.push({name, from: join(directory, 'package.json'), optional: true, parent: target});
  }
  const fixture = join(tmp, 'fixture'); await mkdir(join(fixture, 'sql'), {recursive: true, mode: 0o700});
  for (const [name, path] of sql) { await mkdir(dirname(join(fixture, 'sql', name)), {recursive: true, mode: 0o700}); await cp(path, join(fixture, 'sql', name)); }
  await cp(fixturePath, join(fixture, 'harness.mjs'));
  // Reuse ONLY the frozen actual X.509 DER implementation, never its bootstrap,
  // minimal synthetic registry DDL, old run(), cases or receipt interpretation.
  const frozenSource = await readFile(join(repo, frozen), 'utf8');
  const start = frozenSource.indexOf('const der = (tag, ...parts) => {'), end = frozenSource.indexOf('async function privateFile(', start);
  assert.ok(start > 0 && end > start); assert.equal(frozenSource.indexOf('const der = (tag, ...parts) => {', start + 1), -1);
  const certificateSource = "import assert from 'node:assert/strict';\nimport {generateKeyPairSync,randomBytes,sign,X509Certificate} from 'node:crypto';\n" + frozenSource.slice(start, end) + '\nexport {certificates};\n';
  await writeFile(join(fixture, 'certificates.mjs'), certificateSource, {mode: 0o600});
  const manifest = Object.fromEntries([...inputs].map(([name, path]) => ['/opt/cop-account-safety/' + name, sourcePins[path]]));
  manifest['/opt/cop-account-safety/native/root-seqpacket.node'] = nativePin;
  for (const [name, path] of sql) manifest['/fixture/sql/' + name] = sourcePins[path];
  manifest['/fixture/harness.mjs'] = sourcePins[fixturePath]; manifest['/fixture/certificates.mjs'] = hash(certificateSource);
  await writeFile(join(fixture, 'source-pins.json'), JSON.stringify(manifest) + '\n', {mode: 0o600});
  const create = async (name: string, args: string[]) => {
    const id = (await docker(['create', '--pull', 'never', '--name', name, '--label', 'csm.sim.test=root-owner-authority-20261015', ...args])).stdout.trim();
    assert.match(id, /^[0-9a-f]{64}$/); containers.push(id); return id;
  };
  const node = await create('sim-owner-node-source-' + suffix, ['--network', 'none', '--entrypoint', '/usr/local/bin/node', nodeImage, '--version']);
  const target = await create('sim-owner-authority-' + suffix, ['--network', 'none', '--memory', '896m', '--cpus', '2', '--pids-limit', '256',
    '--tmpfs', '/var/lib/postgresql:rw,nosuid,nodev,size=536870912', '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864',
    '--tmpfs', '/run/cop-account-safety/private:rw,nosuid,nodev,mode=0700,size=33554432',
    '--entrypoint', '/bin/sh', postgresImage, '-c', 'exec sleep 1200']);
  for (const [source, name, destination] of [
    ['/usr/local/bin/node', 'node', '/usr/local/bin/node'], ['/usr/lib/libstdc++.so.6', 'libstdc++.so.6', '/usr/lib/libstdc++.so.6'],
    ['/usr/lib/libgcc_s.so.1', 'libgcc_s.so.1', '/usr/lib/libgcc_s.so.1'],
  ]) { await docker(['cp', '-L', node + ':' + source, join(tmp, name)]); await docker(['cp', join(tmp, name), target + ':' + destination]); }
  await docker(['start', target]);
  await docker(['exec', target, 'mkdir', '-p', '/opt/cop-account-safety', '/fixture']);
  await docker(['cp', tree + '/.', target + ':/opt/cop-account-safety']); await docker(['cp', fixture + '/.', target + ':/fixture']);
  await docker(['exec', target, 'chown', '-R', '0:0', '/opt/cop-account-safety', '/fixture']);
  await docker(['exec', target, 'chmod', '-R', 'go-w', '/opt/cop-account-safety', '/fixture']);
  const inspection = JSON.parse((await docker(['inspect', target])).stdout)[0];
  assert.equal(inspection.HostConfig.NetworkMode, 'none'); assert.equal(inspection.HostConfig.Privileged, false);
  assert.equal((inspection.Mounts ?? []).filter((m: any) => m.Type === 'bind' || m.Type === 'volume').length, 0);
  assert.equal(Object.keys(inspection.HostConfig.PortBindings ?? {}).length, 0);
  const result = JSON.parse((await docker(['exec', target, '/usr/local/bin/node', '/fixture/harness.mjs', '--run'], 300_000)).stdout.trim().split('\n').at(-1)!);
  assert.equal(result.contractVersion, 'sim-root-owner-authority-isolated-linux-v1');
  assert.equal(result.passed, 22); assert.equal(result.cases.length, 22);
  assert.ok(result.cases.every((item: any) => item.passed === true));
  assert.equal(result.hostObservationSynthetic, true); assert.equal(result.actualHostObserverExecuted, false); assert.equal(result.providerCalls, 0);
  assert.equal(result.appPeerSynthetic, true); assert.equal(result.actualPidfdSelf, true); assert.equal(result.singleRootProcess, true);
  assert.equal(result.nativeTransport, false); assert.equal(result.productionEnrollment, false);
  for (const [path, pin] of Object.entries(sourcePins)) assert.equal(hash(await readFile(path)), pin, 'Source changed during fixture.');
  assert.equal(hash(await readFile(selfPath)), selfPin);
  receipt = {status: 'SOURCE_ROOT_OWNER_AUTHORITY_LINUX_ONLY', startedAt, completedAt: new Date().toISOString(), result,
    executingRunnerSha256: selfPin, sourcePins, stagedSourcePins: manifest, certificateDerivation: {frozenSource: frozen, frozenSha256: frozenPin, generatedSha256: hash(certificateSource)},
    nativeSelfArtifact: {path: nativeSource, sha256: nativePin, abi: 'Node24.20.0-linux-arm64-musl', kernelSelfOnly: true, packetTransportTested: false},
    images: {node: nodeImage, postgres: postgresImage}, packageVersions: packages,
    isolation: {externalNetwork: false, hostBindMounts: false, volumes: false, publicPorts: false, privateTmpfs: true, imagePull: false, imageBuild: false, sourceContainersStarted: false},
    actual: {productionChanged: false, acceptedOwnerEvidence: false, nativeTransport: false, nativeHostDeployment: false, restoreAccepted: false,
      realAccounts: false, externalProviderCalls: false, hostObservationSynthetic: true, actualHostObserverExecuted: false,
      actualPidfdProcObserver: false, actualPidfdSelf: true, actualBrokerStartTicks: true, actualBrokerExecutableDigest: true,
      singleRootProcess: true, appPeerSynthetic: true, nativePeerTransport: false}};
  success = true;
} finally {
  for (const id of containers.reverse()) await docker(['rm', '-f', '-v', id]).catch(() => {cleanupComplete = false;});
  process.umask(previousUmask);
  if (success && cleanupComplete) {assert.equal((await stat(tmp)).uid, process.getuid!()); await rm(tmp, {recursive: true});}
  else console.error('Private source-only common fixture retained: ' + tmp);
}
assert.ok(success && cleanupComplete, 'Owned containers/context must be removed before PASS evidence.');
receipt.cleanup = {ownedContainersRemoved: true, ownedVolumesRemoved: true, privateContextRemoved: true, globalPrune: false};
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
console.log(JSON.stringify({receiptPath, passed: receipt.result.passed, productionChanged: false}));
