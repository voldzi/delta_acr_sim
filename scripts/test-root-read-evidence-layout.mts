/** NEW layout evidence only. Uses reviewed mechanical derivation of the frozen
 * Driver/AI TLS/PG bootstraps; does not run/alter/relabel their previous cases.
 * Main is the sole runner. No external target, credential or host bind mount. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deriveLayoutHarness, LAYOUT_SPECS } from './fixtures/root-read-evidence-layout/derive-harness.mjs';

assert.equal(process.argv.length, 5);
assert.equal(process.argv[2], '--run'); assert.equal(process.argv[3], '--cop-source');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), cop = resolve(process.argv[4]);
const receiptPath = join(repo, 'docs/archive/2026-10-15_ROOT_READ_EVIDENCE_LAYOUT.json');
assert.ok(!existsSync(receiptPath), 'Existing evidence must not be overwritten.');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const selfPath = fileURLToPath(import.meta.url), selfPin = hash(await readFile(selfPath));
const deriverPath = join(repo, 'scripts/fixtures/root-read-evidence-layout/derive-harness.mjs');
const deriverPin = hash(await readFile(deriverPath));
const nodeImage = 'sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf';
const postgresImage = 'sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
const helperPath = join(cop, 'scripts/account-safety/root-records.mjs');
const helperPin = 'ad203b1a1858bea7f8f799a6147720d1d0d6df790bfc1d4c866a12c45d6bb7fd';
assert.equal(hash(await readFile(helperPath)), helperPin);
const frozenPins: Record<string, string> = {}, sourcePins: Record<string, string> = {};
for (const spec of Object.values(LAYOUT_SPECS)) {
  for (const [path, pin] of [[spec.frozenRunner, spec.runnerPin], [spec.frozenFixture, spec.fixturePin], [spec.frozenReceipt, spec.receiptPin]]) frozenPins[path] = pin;
  sourcePins[spec.directory + '/' + spec.reader] = spec.readerPin;
  sourcePins[spec.directory + '/' + spec.facts] = spec.factsPin;
  for (const [name, pin] of Object.entries(spec.sql)) sourcePins[spec.directory + '/' + name] = pin;
}
async function verifyInputs() {
  for (const [path, pin] of Object.entries({ ...frozenPins, ...sourcePins })) assert.equal(hash(await readFile(join(repo, path))), pin, 'Reviewed/frozen input changed: ' + path);
  assert.equal(hash(await readFile(helperPath)), helperPin);
  assert.equal(hash(await readFile(deriverPath)), deriverPin);
  assert.equal(hash(await readFile(selfPath)), selfPin);
}
await verifyInputs();
const appDirectory = join(repo, 'apps/ai-router-api/dist');
async function filePins(root: string, prefix = ''): Promise<Record<string, string>> {
  const pins: Record<string, string> = {};
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    assert.ok(!entry.isSymbolicLink()); const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) Object.assign(pins, await filePins(root, path));
    else { assert.ok(entry.isFile() && !entry.name.startsWith('.env')); pins[path] = hash(await readFile(join(root, path))); }
  }
  return pins;
}
const appPins = await filePins(appDirectory); assert.ok(appPins['app.js'] && appPins['account-erasure.js']);
const execute = promisify(execFile);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR'].includes(key)));
const docker = async (args: string[], timeout = 30_000) => execute('docker', ['--host', 'unix:///Users/voldzi/.docker/run/docker.sock', ...args], { env, timeout, maxBuffer: 3 * 1024 * 1024 });
for (const id of [nodeImage, postgresImage]) {
  const info = JSON.parse((await docker(['image', 'inspect', id])).stdout)[0];
  assert.equal(info.Id, id); assert.equal(info.Os, 'linux'); assert.equal(info.Architecture, 'arm64');
}
const previousUmask = process.umask(0o077), tmp = await mkdtemp('/private/tmp/sim-root-read-layout-');
assert.equal(dirname(await realpath(tmp)), '/private/tmp');
const suffix = randomBytes(6).toString('hex'), containers: string[] = [], startedAt = new Date().toISOString();
const results: any[] = [], derivations: Record<string, unknown> = {}, packagePins: Record<string, Record<string, string>> = {};
let success = false, cleanupComplete = true, receipt: any;
try {
  const create = async (name: string, args: string[]) => {
    const id = (await docker(['create', '--pull', 'never', '--name', name, '--label', 'csm.sim.test=root-read-evidence-layout-20261015', ...args])).stdout.trim();
    assert.match(id, /^[0-9a-f]{64}$/); containers.push(id); return id;
  };
  const base = await create('sim-read-layout-node-' + suffix, ['--network', 'none', '--entrypoint', '/usr/local/bin/node', nodeImage, '--version']);
  for (const [source, name] of [['/usr/local/bin/node', 'node'], ['/usr/lib/libstdc++.so.6', 'libstdc++.so.6'], ['/usr/lib/libgcc_s.so.1', 'libgcc_s.so.1']])
    await docker(['cp', '-L', base + ':' + source, join(tmp, name)]);
  for (const owner of ['driver', 'ai'] as const) {
    const spec = LAYOUT_SPECS[owner], context = join(tmp, owner), tree = join(context, 'root-tree');
    await mkdir(join(tree, 'node_modules'), { recursive: true, mode: 0o700 });
    await writeFile(join(tree, 'package.json'), '{"private":true,"type":"module"}\n', { mode: 0o600 });
    await cp(helperPath, join(tree, 'root-records.mjs'));
    for (const name of [spec.reader, spec.facts]) await cp(join(repo, spec.directory, name), join(tree, name));
    if (owner === 'ai') {
      await cp(appDirectory, join(tree, 'router-app'), { recursive: true });
      await writeFile(join(tree, 'router-app/package.json'), '{"private":true,"type":"module"}\n', { mode: 0o600 });
    }
    // Mechanical dependency-copy pattern from the frozen AI runner: preserve
    // nearest-package versions, ordinary files, no pnpm links/checkout/secrets.
    const dependencies: Record<string, string> = {};
    const queue = (owner === 'ai' ? ['pg', 'express'] : ['pg']).map(name => ({ name, from: join(repo, 'apps', owner === 'ai' ? 'ai-router-api' : 'situation-data-api', 'package.json'), optional: false, parent: tree }));
    while (queue.length) {
      const item = queue.shift()!; let directory: string | undefined, data: any;
      for (const parent of createRequire(item.from).resolve.paths(item.name) ?? []) {
        const candidate = join(parent, item.name, 'package.json'); if (!existsSync(candidate)) continue;
        directory = await realpath(dirname(candidate)); data = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); assert.equal(data.name, item.name); break;
      }
      if (!directory) { if (item.optional) continue; throw new Error('Installed dependency metadata is missing: ' + item.name); }
      let foundVersion: string | undefined;
      for (let parent = item.parent;; parent = dirname(parent)) {
        const candidate = join(parent, 'node_modules', item.name, 'package.json');
        if (existsSync(candidate)) { foundVersion = JSON.parse(await readFile(candidate, 'utf8')).version; break; }
        if (parent === tree) break; assert.ok(parent.startsWith(tree + '/'));
      }
      if (foundVersion === data.version) continue;
      const target = join(item.parent, 'node_modules', item.name); assert.ok(!existsSync(target));
      dependencies[relative(tree, target)] = data.version;
      await cp(directory, target, { recursive: true, dereference: true,
        filter: path => !path.split('/').slice(directory!.split('/').length).some(part => part === 'node_modules' || part === '.git' || part.startsWith('.env')) });
      for (const name of Object.keys(data.dependencies ?? {})) queue.push({ name, from: join(directory, 'package.json'), optional: false, parent: target });
      for (const name of Object.keys(data.optionalDependencies ?? {})) queue.push({ name, from: join(directory, 'package.json'), optional: true, parent: target });
    }
    packagePins[owner] = dependencies;
    const derived = deriveLayoutHarness(owner, await readFile(join(repo, spec.frozenFixture), 'utf8'));
    derivations[owner] = { frozenSourceSha256: derived.frozenSha256, generatedSourceSha256: derived.sha256, edits: derived.edits };
    await writeFile(join(context, 'harness.mjs'), derived.source, { mode: 0o600 });
    await writeFile(join(context, 'harness.sha256'), derived.sha256 + '\n', { mode: 0o600 });
    await mkdir(join(context, 'sql'), { mode: 0o700 });
    for (const name of Object.keys(spec.sql)) await cp(join(repo, spec.directory, name), join(context, 'sql', name));
    const target = await create('sim-read-layout-' + owner + '-' + suffix, ['--network', 'none', '--memory', '640m', '--cpus', '1', '--pids-limit', '128',
      '--tmpfs', '/var/lib/postgresql:rw,nosuid,nodev,size=335544320', '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864',
      '--tmpfs', '/run/cop-account-safety/private:rw,nosuid,nodev,mode=0700,size=16777216',
      '--entrypoint', '/bin/sh', postgresImage, '-c', 'exec sleep 900']);
    for (const name of ['node', 'libstdc++.so.6', 'libgcc_s.so.1']) await docker(['cp', join(tmp, name), target + ':' + (name === 'node' ? '/usr/local/bin/node' : '/usr/lib/' + name)]);
    await docker(['start', target]); await docker(['exec', target, 'mkdir', '-p', '/opt/cop-account-safety', '/fixture/sql']);
    await docker(['cp', tree + '/.', target + ':/opt/cop-account-safety']);
    await docker(['cp', join(context, 'sql') + '/.', target + ':/fixture/sql']);
    for (const name of ['harness.mjs', 'harness.sha256']) await docker(['cp', join(context, name), target + ':/fixture/' + name]);
    await docker(['exec', target, 'chown', '-R', '0:0', '/opt/cop-account-safety', '/fixture']);
    await docker(['exec', target, 'chmod', '-R', 'go-w', '/opt/cop-account-safety', '/fixture']);
    const inspection = JSON.parse((await docker(['inspect', target])).stdout)[0];
    assert.equal(inspection.HostConfig.NetworkMode, 'none'); assert.equal(inspection.HostConfig.Privileged, false);
    assert.equal((inspection.Mounts ?? []).filter((mount: any) => mount.Type === 'bind').length, 0);
    assert.equal((inspection.Mounts ?? []).filter((mount: any) => mount.Type === 'volume').length, 0);
    assert.equal(Object.keys(inspection.HostConfig.PortBindings ?? {}).length, 0);
    assert.match(inspection.HostConfig.Tmpfs['/run/cop-account-safety/private'], /mode=0?700(?:,|$)/);
    const run = await docker(['exec', target, '/usr/local/bin/node', '/fixture/harness.mjs', '--run'], 180_000);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!);
    assert.equal(result.contractVersion, 'sim-root-read-evidence-layout-linux-v1'); assert.equal(result.owner, owner);
    assert.equal(result.passed, 5); assert.equal(result.cases.length, 5); assert.ok(result.cases.every((item: any) => item.passed === true));
    assert.equal(result.providerCalls, 0); assert.equal(result.actualMutationAckPathsRetested, false);
    assert.equal(hash(await readFile(join(context, 'harness.mjs'))), derived.sha256);
    results.push(result);
  }
  await verifyInputs(); assert.deepEqual(await filePins(appDirectory), appPins);
  receipt = { status: 'SOURCE_ROOT_READ_EVIDENCE_LAYOUT_LINUX_ONLY', startedAt, completedAt: new Date().toISOString(),
    passed: 10, results, derivations, executingRunnerSha256: selfPin, deriverSha256: deriverPin, sourcePins,
    frozenPins, frozenInputsUnchangedBeforeAndAfter: true, compiledAppPins: appPins, packageVersions: packagePins, copRootHelperSha256: helperPin,
    images: { node: nodeImage, postgres: postgresImage },
    interpretation: 'Ten NEW layout groups only; frozen sixteen-case Driver and fourteen-case AI receipts remain untouched. Their original groups are not rerun or reattributed. Durable namespace sentinel does not test mutation/ACK execution.',
    isolation: { externalNetwork: false, hostBindMounts: false, volumes: false, privateTmpfs: true, publicPorts: false,
      imagePull: false, imageBuild: false, sourceNodeContainerStarted: false, fixturePeerIsNotNativeAttestation: true },
    actual: { productionChanged: false, rootEnrollment: false, acceptedOwnerEvidence: false, nativeTransport: false,
      restoreAccepted: false, deploymentAccepted: false, realAccountDeleted: false, externalProviderCalls: false, mutationAckAcceptance: false } };
  success = true;
} finally {
  for (const id of containers.reverse()) await docker(['rm', '-f', '-v', id]).catch(() => { cleanupComplete = false; });
  process.umask(previousUmask);
  if (success && cleanupComplete) { assert.equal((await stat(tmp)).uid, process.getuid!()); await rm(tmp, { recursive: true }); }
  else console.error('Private source-only layout fixture retained: ' + tmp);
}
assert.ok(success && cleanupComplete, 'Owned test containers must be removed before publishing passing evidence.');
receipt.cleanup = { ownedContainersRemoved: true, ownedImplicitVolumesRemoved: true, sourceContextRemoved: true, globalPrune: false };
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ receiptPath, passed: receipt.passed, productionChanged: false }));
