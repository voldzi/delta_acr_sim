/** NEW Driver keyring-revision evidence, mechanically derived from the frozen
 * fifteen-case runner without modifying that runner/fixture/receipt. Disposable
 * externally networkless Linux only; no production target or accepted Root. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

assert.equal(process.argv.length, 5);
assert.equal(process.argv[2], '--run'); assert.equal(process.argv[3], '--cop-source');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), cop = resolve(process.argv[4]);
const receiptPath = join(repo, 'docs/archive/2026-10-15_DRIVER_READ_KEYRING_FINAL.json');
assert.ok(!existsSync(receiptPath), 'Existing test evidence must not be overwritten.');
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const selfPath = fileURLToPath(import.meta.url), selfPin = hash(await readFile(selfPath));
const nodeImage = 'sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf';
const postgresImage = 'sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
const helperPath = join(cop, 'scripts/account-safety/root-records.mjs');
const helperPin = 'ad203b1a1858bea7f8f799a6147720d1d0d6df790bfc1d4c866a12c45d6bb7fd';
assert.equal(hash(await readFile(helperPath)), helperPin, 'Only the reviewed COP Root helper is accepted.');
const frozenEvidencePins: Record<string, string> = {
  'scripts/test-driver-read-root.mts': 'd478ca2597e38f95a93325614f3d90360665bc712169b180c3ab3483f431319c',
  'scripts/fixtures/driver-read-root/harness.mjs': 'fe4eca9f99f4082c86fc1229554a78bac7187f017ee5b141952d7491d81dce02',
  'scripts/fixtures/driver-read-root/Dockerfile': '532d8783661a025b720fd01ba82b829bb60fe50fac386170a3a004b34e66c998',
  'docs/archive/2026-10-15_DRIVER_READ_ROOT.json': '4d50470cc6398b8108fef3aad622a3fa747f749d8d8d0414854d36a7ee14c249',
  'docs/archive/2026-10-15_DRIVER_READ_ROOT.md': 'c8329c7e5aedd1ca929ec21aa83031d6d23b8f0f1fd05fe0134718b8d476fed4',
  'docs/archive/2026-10-15_DRIVER_READ_KEYRING.json': 'e2746c3f2fcb1e39dd248ef643d573fabc802c7db22bb3ad494f72a3927ca29c',
};
for (const [name, pin] of Object.entries(frozenEvidencePins))
  assert.equal(hash(await readFile(join(repo, name))), pin, 'Frozen earlier evidence must remain unchanged.');
const sqlPins: Record<string, string> = {
  'schema.sql': '6dd60a3acf28d63575198c8526c368df19bbd543f4063d4985fb55f308da02d0',
  '002_account_erasure.sql': 'f13db2106a1fe1a02d0d1a26afa8ad7d7c045172ba4419749719ed0f166e16ad',
  '003_guarded_operations.sql': 'e3513a983a3b6d1bd52d46851c734dd1c3b208e2e2f6430a6f9eddd38b10d3b5',
  '004_read_admission_facts.sql': '791545b9df91e65bb555c68a44dadd73a847ca64fde0c31a9036f9f555ba1d2d',
};
const sourcePins: Record<string, string> = {};
const ownInputs = ['deploy/driver-measurements/root-read-admission.mjs', 'deploy/driver-measurements/read-admission-facts.mjs',
  'scripts/fixtures/driver-read-keyring/harness.mjs', ...Object.keys(sqlPins).map(n => 'deploy/driver-measurements/' + n)];
for (const name of ownInputs) sourcePins[name] = hash(await readFile(join(repo, name)));
for (const [name, pin] of Object.entries(sqlPins)) assert.equal(sourcePins['deploy/driver-measurements/' + name], pin);
assert.equal(sourcePins['deploy/driver-measurements/root-read-admission.mjs'], '259d53669e7f90d940a9c3c9eb8fffd964a3e2b6a364169af480631ba22fde56');
assert.equal(sourcePins['deploy/driver-measurements/read-admission-facts.mjs'], '756d25ae2ce00c9a02a6295a5d00812732a04b01ace82c347f68e58a902d0456');
assert.equal(sourcePins['scripts/fixtures/driver-read-keyring/harness.mjs'], '8992fdd14310ed9fece233ba0a3a8eea7272c4740550f9a863bede8a1a5c0c85');

const execute = promisify(execFile), env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR'].includes(k)));
const docker = async (args: string[], timeout = 30_000) => execute('docker', ['--host', 'unix:///Users/voldzi/.docker/run/docker.sock', ...args],
  { env, timeout, maxBuffer: 2 * 1024 * 1024 });
for (const id of [nodeImage, postgresImage]) {
  const info = JSON.parse((await docker(['image', 'inspect', id])).stdout)[0];
  assert.equal(info.Id, id); assert.equal(info.Os, 'linux'); assert.equal(info.Architecture, 'arm64');
}
const previousUmask = process.umask(0o077), tmp = await mkdtemp('/private/tmp/sim-driver-read-keyring-');
assert.equal(dirname(await realpath(tmp)), '/private/tmp');
const suffix = randomBytes(6).toString('hex'), containers: string[] = [], startedAt = new Date().toISOString();
let success = false, cleanupComplete = true, receipt: any;
const packagePins: Record<string, string> = {};
try {
  const tree = join(tmp, 'root-tree'); await mkdir(join(tree, 'node_modules'), { recursive: true, mode: 0o700 });
  await writeFile(join(tree, 'package.json'), '{"private":true,"type":"module"}\n', { mode: 0o600 });
  await cp(helperPath, join(tree, 'root-records.mjs'));
  for (const name of ['root-read-admission.mjs', 'read-admission-facts.mjs']) await cp(join(repo, 'deploy/driver-measurements', name), join(tree, name));
  // Copy only the already installed pg dependency closure, dereferencing pnpm
  // links into ordinary files. Never copy .env, app code, an entire checkout or
  // application-selected native addon into the privileged fixture code tree.
  const queue: Array<{ name: string; from: string; optional: boolean }> = [{ name: 'pg', from: join(repo, 'apps/situation-data-api/package.json'), optional: false }];
  const copied = new Set<string>();
  while (queue.length) {
    const item = queue.shift()!; if (copied.has(item.name)) continue;
    let entry: string;
    try { entry = createRequire(item.from).resolve(item.name); } catch (e) { if (item.optional) continue; throw e; }
    let directory = dirname(await realpath(entry)), data: any;
    for (;;) {
      try { data = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); } catch { data = undefined; }
      if (data?.name === item.name) break;
      assert.notEqual(directory, dirname(directory), 'Dependency package root must resolve.'); directory = dirname(directory);
    }
    copied.add(item.name); packagePins[item.name] = data.version;
    await cp(directory, join(tree, 'node_modules', item.name), { recursive: true, dereference: true });
    for (const name of Object.keys(data.dependencies ?? {})) queue.push({ name, from: join(directory, 'package.json'), optional: false });
    for (const name of Object.keys(data.optionalDependencies ?? {})) queue.push({ name, from: join(directory, 'package.json'), optional: true });
  }
  await mkdir(join(tmp, 'sql'), { mode: 0o700 });
  for (const name of Object.keys(sqlPins)) await cp(join(repo, 'deploy/driver-measurements', name), join(tmp, 'sql', name));
  await cp(join(repo, 'scripts/fixtures/driver-read-keyring/harness.mjs'), join(tmp, 'harness.mjs'));
  const create = async (name: string, args: string[]) => {
    const id = (await docker(['create', '--pull', 'never', '--name', name, '--label', 'csm.sim.test=driver-read-keyring-20261015', ...args])).stdout.trim();
    assert.match(id, /^[0-9a-f]{64}$/u); containers.push(id); return id;
  };
  const base = await create('sim-driver-keyring-node-' + suffix, ['--network', 'none', '--entrypoint', '/usr/local/bin/node', nodeImage, '--version']);
  const target = await create('sim-driver-keyring-root-' + suffix, ['--network', 'none', '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
    '--tmpfs', '/var/lib/postgresql:rw,nosuid,nodev,size=268435456', '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864',
    '--entrypoint', '/bin/sh', postgresImage, '-c', 'exec sleep 900']);
  // Both are newly created owned containers. No image build/pull or daemon
  // restart is necessary; source Node image is never started.
  for (const [source, name] of [['/usr/local/bin/node', 'node'], ['/usr/lib/libstdc++.so.6', 'libstdc++.so.6'], ['/usr/lib/libgcc_s.so.1', 'libgcc_s.so.1']]) {
    await docker(['cp', '-L', base + ':' + source, join(tmp, name)]);
    await docker(['cp', join(tmp, name), target + ':' + (name === 'node' ? '/usr/local/bin/node' : '/usr/lib/' + name)]);
  }
  await docker(['start', target]);
  await docker(['exec', target, 'mkdir', '-p', '/opt/cop-account-safety', '/fixture/sql']);
  await docker(['cp', tree + '/.', target + ':/opt/cop-account-safety']);
  await docker(['cp', join(tmp, 'sql') + '/.', target + ':/fixture/sql']);
  await docker(['cp', join(tmp, 'harness.mjs'), target + ':/fixture/harness.mjs']);
  // docker-cp archive metadata differs by engine. Establish the fixture's
  // intended Root custody explicitly; actual reader checks still remain on.
  await docker(['exec', target, 'chown', '-R', '0:0', '/opt/cop-account-safety', '/fixture']);
  await docker(['exec', target, 'chmod', '-R', 'go-w', '/opt/cop-account-safety', '/fixture']);
  const inspection = JSON.parse((await docker(['inspect', target])).stdout)[0];
  assert.equal(inspection.HostConfig.NetworkMode, 'none'); assert.equal(inspection.HostConfig.Privileged, false);
  assert.equal((inspection.Mounts ?? []).filter((m: any) => m.Type === 'bind').length, 0);
  assert.equal(Object.keys(inspection.HostConfig.PortBindings ?? {}).length, 0);
  const run = await docker(['exec', target, '/usr/local/bin/node', '/fixture/harness.mjs', '--run'], 120_000);
  const lines = run.stdout.trim().split('\n'), result = JSON.parse(lines.at(-1)!);
  assert.equal(result.passed, 16); assert.equal(result.cases.length, 16); assert.ok(result.cases.every((c: any) => c.passed === true));
  for (const [path, pin] of Object.entries(sourcePins)) assert.equal(hash(await readFile(join(repo, path))), pin, 'Source changed during test.');
  assert.equal(hash(await readFile(helperPath)), helperPin); assert.equal(hash(await readFile(selfPath)), selfPin);
  for (const [name, pin] of Object.entries(frozenEvidencePins))
    assert.equal(hash(await readFile(join(repo, name))), pin, 'Frozen earlier evidence changed during this revision run.');
  receipt = { status: 'SOURCE_DRIVER_READ_KEYRING_LINUX_ONLY', startedAt, completedAt: new Date().toISOString(), result,
    images: { node: nodeImage, postgres: postgresImage }, sourcePins, copRootHelperSha256: helperPin, packageVersions: packagePins,
    executingHarnessSha256: selfPin, sourceUnchangedDuringRun: true, frozenEvidencePins, priorFrozenEvidenceUnchanged: true,
    interpretation: '16 cases in a NEW keyring reader revision; the original fifteen-case receipt is unchanged and is not reattributed. Replaced-keyring negative is not a deterministic issue race test.', isolation: { externalNetwork: false, hostMounts: false, publicPorts: false,
      imagePull: false, imageBuild: false, sourceNodeContainerStarted: false, fixturePeerIsNotNativeAttestation: true },
    actual: { productionChanged: false, rootEnrollment: false, acceptedOwnerEvidence: false, nativeTransport: false,
      restoreAccepted: false, deploymentAccepted: false, realAccountDeleted: false, providerCalls: false } };
  success = true;
} finally {
  for (const id of containers.reverse()) await docker(['rm', '-f', '-v', id]).catch(() => { cleanupComplete = false; });
  process.umask(previousUmask);
  if (success && cleanupComplete) { assert.equal((await stat(tmp)).uid, process.getuid!()); await rm(tmp, { recursive: true }); }
  else console.error('Private source-only fixture retained: ' + tmp);
}
assert.ok(success && cleanupComplete, 'Owned test containers must be removed before publishing passing evidence.');
receipt.cleanup = { ownedContainersRemoved: true, ownedImplicitVolumesRemoved: true, sourceContextRemoved: true, globalPrune: false };
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ receiptPath, passed: receipt.result.passed, productionChanged: false }));
