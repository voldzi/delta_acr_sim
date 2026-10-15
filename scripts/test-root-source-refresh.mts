/** NEW isolated source-refresh gate. Main alone executes after full review.
 * Mechanically reuses a frozen bootstrap/runner, never their old cases or PASS.
 * No image pull/build, external target, host bind, production secret or network.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

assert.equal(process.argv.length, 5); assert.equal(process.argv[2], '--run'); assert.equal(process.argv[3], '--cop-source');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), cop = resolve(process.argv[4]);
const receiptPath = join(repo, 'docs/archive/2026-10-15_ROOT_SOURCE_REFRESH.json');
assert.ok(!existsSync(receiptPath), 'Never overwrite prior evidence.');
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const self = fileURLToPath(import.meta.url), fixture = join(repo, 'scripts/fixtures/root-source-refresh/harness.mjs');
const oldRunner = join(repo, 'scripts/test-root-owner-authority.mts'), oldFixture = join(repo, 'scripts/fixtures/root-owner-authority/harness.mjs');
const copCommit = '17d52541b0e8bffc7217f680714cd73f607644b6';
const safeGitEnvironment = {PATH: '/usr/bin:/bin', LANG: 'C'};
const git = async (args: string[]) => promisify(execFile)('/usr/bin/git', ['-C', cop, ...args],
  {env: safeGitEnvironment, encoding: 'buffer', maxBuffer: 3 * 1024 * 1024});
assert.equal((await git(['rev-parse', '--verify', '17d5254^{commit}'])).stdout.toString('utf8').trim(), copCommit);
const expectedRootPins = Object.freeze({
  'root-owner-authority.mjs': '34a601aec8ad8d32095c9baf778a3a829dbda6159f7c4fd1e28aa22be6d0feb0',
  'root-owner-authority-protocol.mjs': '0fab874389fdc5660241f7b26ead63a7b9003b06915a78dcbec4b744614632a3',
  'root-owner-policy-lineage.mjs': 'c918139370a8782c2605d5957d7c79e2e5cacc1e31ac9d519d11e208a4bfcd44',
  '004_source_refresh_cas.sql': '48dbf4f816af0b89c913a5361ae9ddf61b827dc61db0ce242100ea5189a958cf',
});
for (const [name, pin] of Object.entries(expectedRootPins)) assert.equal(digest(await readFile(join(repo, 'deploy/account-safety', name))), pin);
const preserved = new Map([
  [oldRunner, 'ec64cb120683e9d5b2eb7b78c287d1f7ae35989d6ef42830d9738aa8e6b05cf0'],
  [oldFixture, '8e48b668b319b1a8153809c081c4fd4066f5da8f80bdb058284a27f473f5ae46'],
  [join(repo, 'scripts/test-root-owner-policy-lineage.mts'), '497b776b480ab3b04933762aa082b8d573cf3476935927ce308408a07393f3d0'],
  [join(repo, 'scripts/fixtures/root-owner-policy-lineage/harness.mjs'), '82b3135dc85e5ba05b38fb0968e7524a73192849ec7d9d8f1ed1deb37dd253bf'],
  [join(repo, 'docs/archive/2026-10-15_ROOT_OWNER_AUTHORITY.json'), 'a88fa4788a9e0fa6fb3265310e7f3038282cfa417ce45311ce092a7413b3f49a'],
  [join(repo, 'docs/archive/2026-10-15_ROOT_OWNER_POLICY_LINEAGE.json'), '6691948fc7e2393de9147b7f9c543e030482f1eaf0c9e9af25e2ab095685e168'],
  [join(cop, 'docs/testing/account-safety-retention-producer-20261015.json'), '565d11a8ab255c91a9fc079e6b1a32851fb50ddb5a31f390e9195e27ce98e1ce'],
]);
for (const [path, pin] of preserved) assert.equal(digest(await readFile(path)), pin);
const originals = Object.fromEntries(await Promise.all([self, fixture, ...preserved.keys()].map(async path => [path, digest(await readFile(path))])));
const substitute = (source: string, before: string, after: string) => {
  assert.equal(source.split(before).length, 2, 'Frozen derivation site changed.'); return source.replace(before, after);
};
let bootstrap = await readFile(oldFixture, 'utf8');
const first = bootstrap.indexOf("import assert from 'node:assert/strict';"), last = bootstrap.indexOf('async function lockProbe(');
assert.ok(first > 0 && last > first); bootstrap = bootstrap.slice(first, last);
bootstrap = substitute(bootstrap, "['admin', 'registry', 'driver', 'ai', 'runtime']", "['admin', 'registry', 'driver', 'ai', 'runtime', 'refresher']");
bootstrap = substitute(bootstrap, "'checkpoint-acceptances', 'checkpoint-intents', 'checkpoint-dispatches'",
  "'checkpoint-acceptances', 'checkpoint-intents', 'checkpoint-dispatches', 'source-refresh-intents', 'source-refresh-dispatches'");
bootstrap = substitute(bootstrap, 'ttl = 20000} = {})', 'ttl = 29900} = {})');
bootstrap = substitute(bootstrap, 'timelineId: value.timeline}, 25000);', 'timelineId: value.timeline}, 29900);');
bootstrap = substitute(bootstrap, '  // Separate fixture-only credential/LOGIN activation;',
  "  stage = 'bootstrap.metadata-004-source-refresh';\n  await registry.query(await readFile('/fixture/sql/metadata/004_source_refresh_cas.sql', 'utf8'));\n  // Separate fixture-only credential/LOGIN activation;");
bootstrap = substitute(bootstrap,
  '  await registry.query("ALTER ROLE cop_guard_root_reader LOGIN CONNECTION LIMIT 8 PASSWORD \'" + passwords.registry + "\'");',
  '  await registry.query("ALTER ROLE cop_guard_root_reader LOGIN CONNECTION LIMIT 8 PASSWORD \'" + passwords.registry + "\'");\n' +
  '  await registry.query("ALTER ROLE cop_guard_source_refresher LOGIN CONNECTION LIMIT 8 PASSWORD \'" + passwords.refresher + "\'");');
bootstrap = substitute(bootstrap,
  "[['registry-probe', 'cop_account_safety_guard', 'cop_guard_root_reader', passwords.registry],",
  "[['registry-probe', 'cop_account_safety_guard', 'cop_guard_root_reader', passwords.registry],\n    ['registry-source-refresh', 'cop_account_safety_guard', 'cop_guard_source_refresher', passwords.refresher],");
const generatedFixture = Buffer.from(bootstrap + '\n' + await readFile(fixture, 'utf8'));
let core = await readFile(oldRunner, 'utf8');
core = substitute(core, 'cp, mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, writeFile', 'cp, mkdir, mkdtemp, readFile as readLocalFile, realpath, readdir, rm, stat, writeFile');
core = substitute(core, "const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), cop = resolve(process.argv[4]);",
  'const repo = ' + JSON.stringify(repo) + ', cop = resolve(process.argv[4]);');
const gitReader = String.raw`
// Only immutable COP source objects are read; never live actor WIP or secrets.
async function readFile(path: any, encoding?: any): Promise<any> {
  if (typeof path === 'string' && path.startsWith(join(cop, 'scripts/account-safety') + '/')) {
    const rel = relative(cop, path); assert.match(rel, /^scripts\/account-safety\/[a-z0-9][a-z0-9_-]*\.(?:mjs|sql)$/);
    const r = await promisify(execFile)('/usr/bin/git', ['-C', cop, 'show', '${copCommit}:' + rel],
      {env: {PATH: '/usr/bin:/bin', LANG: 'C'}, encoding: 'buffer', maxBuffer: 3 * 1024 * 1024});
    return encoding ? r.stdout.toString(encoding) : r.stdout;
  }
  return readLocalFile(path, encoding);
}
`;
core = substitute(core, 'assert.equal(process.argv.length, 5);', gitReader + '\nassert.equal(process.argv.length, 5);');
const candidateStart = core.indexOf("for (const entry of await readdir(join(cop, 'scripts/account-safety'), {withFileTypes: true})) {");
const candidateEnd = core.indexOf("for (const entry of await readdir(join(repo, 'deploy/account-safety')", candidateStart);
assert.ok(candidateStart > 0 && candidateEnd > candidateStart);
core = core.slice(0, candidateStart) + String.raw`const frozenCopPaths = (await promisify(execFile)('/usr/bin/git', ['-C', cop, 'ls-tree', '-r', '--name-only', '${copCommit}', 'scripts/account-safety'],
  {env: {PATH: '/usr/bin:/bin', LANG: 'C'}, maxBuffer: 3 * 1024 * 1024})).stdout.trim().split('\n');
for (const rel of frozenCopPaths) {
  const name = rel.slice('scripts/account-safety/'.length);
  if (name.includes('/') || !name.endsWith('.mjs') || name.endsWith('.test.mjs') || /^(?:test-|run-)/.test(name)) continue;
  candidates.set(name, join(cop, rel));
}
` + core.slice(candidateEnd);
core = substitute(core, "'root-owner-authority.mjs': '4842899595b9b2efa9c913057ad1978208e44042ee39d7f009faf49565921d06'",
  "'root-owner-authority.mjs': '" + expectedRootPins['root-owner-authority.mjs'] + "'");
core = substitute(core, "const sql = new Map<string, string>([['metadata/001-guard-metadata.sql', metadataSource], ['metadata/002-root-reader.sql', readerMetadataSource]]);",
  "const sql = new Map<string, string>([['metadata/001-guard-metadata.sql', metadataSource], ['metadata/002-root-reader.sql', readerMetadataSource], ['metadata/004_source_refresh_cas.sql', join(repo, 'deploy/account-safety/004_source_refresh_cas.sql')]]);");
core = substitute(core, 'for (const [name, path] of inputs) await cp(path, join(tree, name));',
  'for (const [name, path] of inputs) await writeFile(join(tree, name), await readFile(path), {mode: 0o600});');
core = substitute(core, 'await cp(path, join(fixture, \'sql\', name));', 'await writeFile(join(fixture, \'sql\', name), await readFile(path), {mode: 0o600});');
core = substitute(core, "assert.equal(result.contractVersion, 'sim-root-owner-authority-isolated-linux-v1');", "assert.equal(result.contractVersion, 'sim-root-source-refresh-isolated-linux-v1');");
core = substitute(core, 'assert.equal(result.passed, 22); assert.equal(result.cases.length, 22);', 'assert.equal(result.passed, 6); assert.equal(result.cases.length, 6);');
core = substitute(core, "status: 'SOURCE_ROOT_OWNER_AUTHORITY_LINUX_ONLY'", "status: 'SOURCE_ROOT_SOURCE_REFRESH_LINUX_ONLY'");
core = substitute(core, 'csm.sim.test=root-owner-authority-20261015', 'csm.sim.test=root-source-refresh-20261015');
core = substitute(core, 'sim-root-owner-authority-', 'sim-root-source-refresh-');
core = substitute(core, 'sim-owner-node-source-', 'sim-refresh-node-source-');
core = substitute(core, 'sim-owner-authority-', 'sim-source-refresh-');
const previousUmask = process.umask(0o077), tmp = await mkdtemp('/private/tmp/sim-source-refresh-derivation-');
let complete = false, receipt: any;
try {
  const innerFixture = join(tmp, 'harness.mjs'), innerRunner = join(tmp, 'runner.mts'), innerReceipt = join(tmp, 'result.json');
  await writeFile(innerFixture, generatedFixture, {mode: 0o600, flag: 'wx'});
  core = substitute(core, "const receiptPath = join(repo, 'docs/archive/2026-10-15_ROOT_OWNER_AUTHORITY.json');", 'const receiptPath = ' + JSON.stringify(innerReceipt) + ';');
  core = substitute(core, "const fixturePath = join(repo, 'scripts/fixtures/root-owner-authority/harness.mjs');", 'const fixturePath = ' + JSON.stringify(innerFixture) + ';');
  await writeFile(innerRunner, core, {mode: 0o600, flag: 'wx'});
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR'].includes(key)));
  // Parse the exact derived bytes before the inner runner can inspect Docker
  // or create a context/container. --check executes neither module body.
  for (const path of [innerRunner, innerFixture])
    await promisify(execFile)(process.execPath, ['--check', path], {env, timeout: 30_000, maxBuffer: 65536});
  await promisify(execFile)(process.execPath, [innerRunner, '--run', '--cop-source', cop], {env, timeout: 330000, maxBuffer: 3 * 1024 * 1024});
  receipt = JSON.parse(await readFile(innerReceipt, 'utf8'));
  assert.equal(receipt.result.contractVersion, 'sim-root-source-refresh-isolated-linux-v1'); assert.equal(receipt.result.passed, 6);
  assert.equal(receipt.result.actualSourceRefresh, true); assert.equal(receipt.result.lostCommitExercised, false); assert.equal(receipt.result.unknownTargetEndExercised, false);
  for (const [path, pin] of Object.entries(originals)) assert.equal(digest(await readFile(path)), pin);
  for (const [name, pin] of Object.entries(expectedRootPins)) assert.equal(digest(await readFile(join(repo, 'deploy/account-safety', name))), pin);
  receipt.derivation = {sourcePins: originals, expectedRootPins, copCommit, copSourceSelection: 'git-show-only-not-live-worktree',
    selectedBootstrap: 'frozen-common22 imports-through-bootstrap, shared with prior-lineage derivation',
    generatedFixtureSha256: digest(generatedFixture), generatedRunnerSha256: digest(core), generatedSourceParsedBeforeDocker: true,
    priorCasesExecuted: false, priorReceiptsChanged: false};
  complete = true;
} finally {
  process.umask(previousUmask);
  if (complete) await rm(tmp, {recursive: true}); else console.error('Private source-refresh derivation retained: ' + tmp);
}
assert.ok(complete); receipt.cleanup.derivationContextRemoved = true;
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
console.log(JSON.stringify({receiptPath, passed: 6, productionChanged: false}));
