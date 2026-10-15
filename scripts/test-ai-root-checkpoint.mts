/** Disposable source-only Linux fixture: real Root records/TLS/PostgreSQL and
 * compiled AI app; provider responses only are synthetic. No production input. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

assert.equal(process.argv.length, 5);
assert.equal(process.argv[2], '--run'); assert.equal(process.argv[3], '--cop-source');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), cop = resolve(process.argv[4]);
const receiptPath = join(repo, 'docs/archive/2026-10-15_AI_ROOT_CHECKPOINT.json');
assert.ok(!existsSync(receiptPath), 'Existing evidence must not be overwritten.');
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const selfPath = fileURLToPath(import.meta.url), selfPin = hash(await readFile(selfPath));
const nodeImage = 'sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf';
const postgresImage = 'sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
const helperPath = join(cop, 'scripts/account-safety/root-records.mjs');
const helperPin = 'ad203b1a1858bea7f8f799a6147720d1d0d6df790bfc1d4c866a12c45d6bb7fd';
assert.equal(hash(await readFile(helperPath)), helperPin);
const sqlNames = ['001_schema.sql', '002_separate_billing.sql', '003_account_erasure.sql',
  '004_root_checkpoint_facts.sql', '005_root_checkpoint.sql'];
const sourcePins: Record<string, string> = {};
const ownInputs = ['deploy/ai-router/root-checkpoint-read.mjs', 'deploy/ai-router/checkpoint-facts.mjs',
  'scripts/fixtures/ai-checkpoint-root/harness.mjs', ...sqlNames.map(n => 'deploy/ai-router/' + n)];
for (const name of ownInputs) sourcePins[name] = hash(await readFile(join(repo, name)));
const appDirectory = join(repo, 'apps/ai-router-api/dist');
async function filePins(root: string, prefix = ''): Promise<Record<string, string>> {
  const pins: Record<string, string> = {};
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    assert.ok(!entry.isSymbolicLink(), 'Compiled app must contain ordinary files only.');
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) Object.assign(pins, await filePins(root, path));
    else { assert.ok(entry.isFile()); assert.ok(!entry.name.startsWith('.env')); pins[path] = hash(await readFile(join(root, path))); }
  }
  return pins;
}
const appPins = await filePins(appDirectory); assert.ok(appPins['app.js'] && appPins['account-erasure.js']);
const execute = promisify(execFile);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR'].includes(k)));
const docker = async (args: string[], timeout = 30_000) => execute('docker', ['--host', 'unix:///Users/voldzi/.docker/run/docker.sock', ...args],
  { env, timeout, maxBuffer: 3 * 1024 * 1024 });
for (const id of [nodeImage, postgresImage]) {
  const info = JSON.parse((await docker(['image', 'inspect', id])).stdout)[0];
  assert.equal(info.Id, id); assert.equal(info.Os, 'linux'); assert.equal(info.Architecture, 'arm64');
}
const previousUmask = process.umask(0o077), tmp = await mkdtemp('/private/tmp/sim-ai-root-checkpoint-');
assert.equal(dirname(await realpath(tmp)), '/private/tmp');
const suffix = randomBytes(6).toString('hex'), containers: string[] = [], startedAt = new Date().toISOString();
let success = false, cleanupComplete = true, receipt: any;
const packagePins: Record<string, string> = {};
try {
  const tree = join(tmp, 'root-tree'); await mkdir(join(tree, 'node_modules'), { recursive: true, mode: 0o700 });
  await writeFile(join(tree, 'package.json'), '{"private":true,"type":"module"}\n', { mode: 0o600 });
  await cp(helperPath, join(tree, 'root-records.mjs'));
  for (const name of ['root-checkpoint-read.mjs', 'checkpoint-facts.mjs']) await cp(join(repo, 'deploy/ai-router', name), join(tree, name));
  await cp(appDirectory, join(tree, 'router-app'), { recursive: true });
  await writeFile(join(tree, 'router-app/package.json'), '{"private":true,"type":"module"}\n', { mode: 0o600 });
  // Preserve Node's nearest-package resolution. Express has legitimate
  // different versions of transitive packages: a flat copy would substitute
  // one of them. Copies are ordinary files, never pnpm symlinks or whole trees.
  const queue = ['pg', 'express'].map(name => ({ name, from: join(repo, 'apps/ai-router-api/package.json'), optional: false, parent: tree }));
  while (queue.length) {
    const item = queue.shift()!; let directory: string | undefined, data: any;
    // Some dependencies export only subpaths, not ".". Locate the package
    // metadata using Node's ordered lookup paths without importing its code.
    for (const parent of createRequire(item.from).resolve.paths(item.name) ?? []) {
      const candidate = join(parent, item.name, 'package.json');
      if (!existsSync(candidate)) continue;
      directory = await realpath(dirname(candidate)); data = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      assert.equal(data.name, item.name); break;
    }
    if (!directory) { if (item.optional) continue; throw new Error('Installed dependency metadata is missing: ' + item.name); }
    let foundVersion: string | undefined;
    for (let parent = item.parent; ; parent = dirname(parent)) {
      const candidate = join(parent, 'node_modules', item.name, 'package.json');
      if (existsSync(candidate)) { foundVersion = JSON.parse(await readFile(candidate, 'utf8')).version; break; }
      if (parent === tree) break;
      assert.ok(parent.startsWith(tree + '/'), 'Dependency lookup must remain in the owned tree.');
    }
    if (foundVersion === data.version) continue;
    const target = join(item.parent, 'node_modules', item.name);
    assert.ok(!existsSync(target), 'A single package may not resolve two versions of one direct dependency.');
    packagePins[relative(tree, target)] = data.version;
    await cp(directory, target, { recursive: true, dereference: true,
      filter: path => !path.split('/').slice(directory.split('/').length).some(part => part === 'node_modules' || part === '.git' || part.startsWith('.env')) });
    for (const name of Object.keys(data.dependencies ?? {})) queue.push({ name, from: join(directory, 'package.json'), optional: false, parent: target });
    for (const name of Object.keys(data.optionalDependencies ?? {})) queue.push({ name, from: join(directory, 'package.json'), optional: true, parent: target });
  }
  await mkdir(join(tmp, 'sql'), { mode: 0o700 });
  for (const name of sqlNames) await cp(join(repo, 'deploy/ai-router', name), join(tmp, 'sql', name));
  await cp(join(repo, 'scripts/fixtures/ai-checkpoint-root/harness.mjs'), join(tmp, 'harness.mjs'));
  const create = async (name: string, args: string[]) => {
    const id = (await docker(['create', '--pull', 'never', '--name', name, '--label', 'csm.sim.test=ai-root-checkpoint-20261015', ...args])).stdout.trim();
    assert.match(id, /^[0-9a-f]{64}$/u); containers.push(id); return id;
  };
  const base = await create('sim-ai-root-node-' + suffix, ['--network', 'none', '--entrypoint', '/usr/local/bin/node', nodeImage, '--version']);
  const target = await create('sim-ai-root-pg-' + suffix, ['--network', 'none', '--memory', '640m', '--cpus', '1', '--pids-limit', '128',
    '--tmpfs', '/var/lib/postgresql:rw,nosuid,nodev,size=335544320', '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864',
    '--entrypoint', '/bin/sh', postgresImage, '-c', 'exec sleep 900']);
  for (const [source, name] of [['/usr/local/bin/node', 'node'], ['/usr/lib/libstdc++.so.6', 'libstdc++.so.6'], ['/usr/lib/libgcc_s.so.1', 'libgcc_s.so.1']]) {
    await docker(['cp', '-L', base + ':' + source, join(tmp, name)]);
    await docker(['cp', join(tmp, name), target + ':' + (name === 'node' ? '/usr/local/bin/node' : '/usr/lib/' + name)]);
  }
  await docker(['start', target]);
  await docker(['exec', target, 'mkdir', '-p', '/opt/cop-account-safety', '/fixture/sql']);
  await docker(['cp', tree + '/.', target + ':/opt/cop-account-safety']);
  await docker(['cp', join(tmp, 'sql') + '/.', target + ':/fixture/sql']);
  await docker(['cp', join(tmp, 'harness.mjs'), target + ':/fixture/harness.mjs']);
  await docker(['exec', target, 'chown', '-R', '0:0', '/opt/cop-account-safety', '/fixture']);
  await docker(['exec', target, 'chmod', '-R', 'go-w', '/opt/cop-account-safety', '/fixture']);
  const inspection = JSON.parse((await docker(['inspect', target])).stdout)[0];
  assert.equal(inspection.HostConfig.NetworkMode, 'none'); assert.equal(inspection.HostConfig.Privileged, false);
  assert.equal((inspection.Mounts ?? []).filter((m: any) => m.Type === 'bind').length, 0);
  assert.equal(Object.keys(inspection.HostConfig.PortBindings ?? {}).length, 0);
  const run = await docker(['exec', target, '/usr/local/bin/node', '/fixture/harness.mjs', '--run'], 180_000);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!);
  assert.equal(result.passed, 14); assert.equal(result.cases.length, 14); assert.ok(result.cases.every((c: any) => c.passed === true));
  for (const [path, pin] of Object.entries(sourcePins)) assert.equal(hash(await readFile(join(repo, path))), pin, 'Source changed during test.');
  assert.deepEqual(await filePins(appDirectory), appPins); assert.equal(hash(await readFile(helperPath)), helperPin);
  assert.equal(hash(await readFile(selfPath)), selfPin);
  receipt = { status: 'SOURCE_AI_ROOT_CHECKPOINT_LINUX_ONLY', startedAt, completedAt: new Date().toISOString(), result,
    images: { node: nodeImage, postgres: postgresImage }, sourcePins, compiledAppPins: appPins, copRootHelperSha256: helperPin,
    packageVersions: packagePins, executingHarnessSha256: selfPin, sourceUnchangedDuringRun: true,
    isolation: { externalNetwork: false, hostMounts: false, publicPorts: false, imagePull: false, imageBuild: false,
      sourceNodeContainerStarted: false, fixturePeerIsNotNativeAttestation: true, providerResponsesSynthetic: true },
    actual: { productionChanged: false, rootEnrollment: false, acceptedOwnerEvidence: false, nativeTransport: false,
      restoreAccepted: false, deploymentAccepted: false, realAccountDeleted: false, externalProviderCalls: false } };
  success = true;
} finally {
  for (const id of containers.reverse()) await docker(['rm', '-f', '-v', id]).catch(() => { cleanupComplete = false; });
  process.umask(previousUmask);
  if (success && cleanupComplete) { assert.equal((await stat(tmp)).uid, process.getuid!()); await rm(tmp, { recursive: true }); }
  else console.error('Private source-only fixture retained: ' + tmp);
}
assert.ok(success && cleanupComplete, 'Owned test containers must be removed before publishing evidence.');
receipt.cleanup = { ownedContainersRemoved: true, ownedImplicitVolumesRemoved: true, sourceContextRemoved: true, globalPrune: false };
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ receiptPath, passed: receipt.result.passed, productionChanged: false }));
