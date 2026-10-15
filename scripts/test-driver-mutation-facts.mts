/** NEW immutable Driver mutation-facts integration gate (no admission signer).
 * Source only until main reviews and runs. Reuses ONLY frozen common22 bootstrap
 * mechanics, never old cases/receipts. No production state, pull/build or binds.
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
const finalReceipt = join(repo, 'docs/archive/2026-10-15_DRIVER_MUTATION_FACTS_ROOT.json');
assert.ok(!existsSync(finalReceipt), 'Never overwrite previous evidence.');
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const self = fileURLToPath(import.meta.url), fixture = join(repo, 'scripts/fixtures/driver-mutation-facts/harness.mjs');
const oldRunner = join(repo, 'scripts/test-root-owner-authority.mts'), oldFixture = join(repo, 'scripts/fixtures/root-owner-authority/harness.mjs');
const copCommit = '17d52541b0e8bffc7217f680714cd73f607644b6';
const expectedRootPins = Object.freeze({
  'root-owner-authority.mjs': '501d8a638b442250d64905f66a182de6a82296cd2324a4e63ac888eee209b4f4',
  'root-owner-authority-protocol.mjs': '0fab874389fdc5660241f7b26ead63a7b9003b06915a78dcbec4b744614632a3',
  'root-owner-policy-lineage.mjs': 'c918139370a8782c2605d5957d7c79e2e5cacc1e31ac9d519d11e208a4bfcd44',
});
for (const [name, pin] of Object.entries(expectedRootPins)) {
  assert.match(pin, /^[0-9a-f]{64}$/, 'Final reviewed common pin required before any context/container.');
  assert.equal(digest(await readFile(join(repo, 'deploy/account-safety', name))), pin);
}
const preserved = new Map([
  [oldRunner, 'ec64cb120683e9d5b2eb7b78c287d1f7ae35989d6ef42830d9738aa8e6b05cf0'],
  [oldFixture, '8e48b668b319b1a8153809c081c4fd4066f5da8f80bdb058284a27f473f5ae46'],
  [join(repo, 'docs/archive/2026-10-15_ROOT_OWNER_AUTHORITY.json'), 'a88fa4788a9e0fa6fb3265310e7f3038282cfa417ce45311ce092a7413b3f49a'],
  [join(repo, 'docs/archive/2026-10-15_ROOT_OWNER_POLICY_LINEAGE.json'), '6691948fc7e2393de9147b7f9c543e030482f1eaf0c9e9af25e2ab095685e168'],
  [join(repo, 'docs/archive/2026-10-15_ROOT_SOURCE_REFRESH.json'), '07c417f025ecdf6583ecc29ee2140c8de7a3e20c8f42c8fd2cb8d9215d7b4710'],
  [join(repo, 'docs/archive/2026-10-15_DRIVER_ETA_CONTRIBUTOR_BINDING_SQL.json'), '0e496c825ccb40e48e3a8c7ee4d10000fd72b018ed4b71b36cc7e168ab551d99'],
]);
for (const [path, pin] of preserved) assert.equal(digest(await readFile(path)), pin);
const etaPath = join(repo, 'deploy/driver-measurements/007_eta_contributor_binding.sql');
assert.equal(digest(await readFile(etaPath)), '135acb29c58734e232891aa9b61fac3e6520b6dd7209a57dbd5dc8240fbc5942');
const originals = Object.fromEntries(await Promise.all([self, fixture, etaPath, ...preserved.keys()].map(async path => [path, digest(await readFile(path))])));
const substitute = (source: string, before: string, after: string) => {
  assert.equal(source.split(before).length, 2, 'Frozen derivation site changed.'); return source.replace(before, after);
};
let bootstrap = await readFile(oldFixture, 'utf8');
const first = bootstrap.indexOf("import assert from 'node:assert/strict';"), last = bootstrap.indexOf('async function lockProbe(');
assert.ok(first > 0 && last > first); bootstrap = bootstrap.slice(first, last);
bootstrap = substitute(bootstrap, "['005_root_checkpoint.sql', '006_inventory_candidates.sql']",
  "['005_root_checkpoint.sql', '006_inventory_candidates.sql', '007_eta_contributor_binding.sql']");
const generatedFixture = Buffer.from(bootstrap + '\n' + await readFile(fixture, 'utf8'));
let core = await readFile(oldRunner, 'utf8');
core = substitute(core, 'cp, mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, writeFile', 'cp, mkdir, mkdtemp, readFile as readLocalFile, realpath, readdir, rm, stat, writeFile');
core = substitute(core, "const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), cop = resolve(process.argv[4]);",
  'const repo = ' + JSON.stringify(repo) + ', cop = resolve(process.argv[4]);');
const gitReader = String.raw`
// Immutable COP helper source objects only; no live producer WIP or credentials.
async function readFile(path: any, encoding?: any): Promise<any> {
  if (typeof path === 'string' && path.startsWith(join(cop, 'scripts/account-safety') + '/')) {
    const rel = relative(cop, path); assert.match(rel, /^scripts\/account-safety\/[a-z0-9][a-z0-9_-]*\.(?:mjs|sql)$/);
    const value = await promisify(execFile)('/usr/bin/git', ['-C', cop, 'show', '${copCommit}:' + rel],
      {env: {PATH: '/usr/bin:/bin', LANG: 'C'}, encoding: 'buffer', maxBuffer: 3 * 1024 * 1024});
    return encoding ? value.stdout.toString(encoding) : value.stdout;
  }
  return readLocalFile(path, encoding);
}
`;
core = substitute(core, 'assert.equal(process.argv.length, 5);', gitReader + '\nassert.equal(process.argv.length, 5);');
const startCandidates = core.indexOf("for (const entry of await readdir(join(cop, 'scripts/account-safety'), {withFileTypes: true})) {");
const endCandidates = core.indexOf("for (const entry of await readdir(join(repo, 'deploy/account-safety')", startCandidates);
assert.ok(startCandidates > 0 && endCandidates > startCandidates);
core = core.slice(0, startCandidates) + String.raw`const frozenCopPaths = (await promisify(execFile)('/usr/bin/git', ['-C', cop, 'ls-tree', '-r', '--name-only', '${copCommit}', 'scripts/account-safety'],
  {env: {PATH: '/usr/bin:/bin', LANG: 'C'}, maxBuffer: 3 * 1024 * 1024})).stdout.trim().split('\n');
for (const rel of frozenCopPaths) {
  const name = rel.slice('scripts/account-safety/'.length);
  if (name.includes('/') || !name.endsWith('.mjs') || name.endsWith('.test.mjs') || /^(?:test-|run-)/.test(name)) continue;
  candidates.set(name, join(cop, rel));
}
` + core.slice(endCandidates);
core = substitute(core, "'root-owner-authority.mjs': '4842899595b9b2efa9c913057ad1978208e44042ee39d7f009faf49565921d06'",
  "'root-owner-authority.mjs': '" + expectedRootPins['root-owner-authority.mjs'] + "'");
core = substitute(core, "'005_root_checkpoint.sql', '006_inventory_candidates.sql']",
  "'005_root_checkpoint.sql', '006_inventory_candidates.sql', '007_eta_contributor_binding.sql']");
core = substitute(core, 'for (const [name, path] of inputs) await cp(path, join(tree, name));',
  'for (const [name, path] of inputs) await writeFile(join(tree, name), await readFile(path), {mode: 0o600});');
core = substitute(core, "await cp(path, join(fixture, 'sql', name));", "await writeFile(join(fixture, 'sql', name), await readFile(path), {mode: 0o600});");
core = substitute(core, "assert.equal(result.contractVersion, 'sim-root-owner-authority-isolated-linux-v1');", "assert.equal(result.contractVersion, 'sim-driver-mutation-facts-root-v1');");
core = substitute(core, 'assert.equal(result.passed, 22); assert.equal(result.cases.length, 22);', 'assert.equal(result.passed, 8); assert.equal(result.cases.length, 8);');
core = substitute(core, "status: 'SOURCE_ROOT_OWNER_AUTHORITY_LINUX_ONLY'", "status: 'SOURCE_DRIVER_MUTATION_FACTS_ROOT_ONLY'");
core = substitute(core, 'csm.sim.test=root-owner-authority-20261015', 'csm.sim.test=driver-mutation-facts-20261015');
core = substitute(core, 'sim-root-owner-authority-', 'sim-driver-mutation-facts-');
core = substitute(core, 'sim-owner-node-source-', 'sim-mutation-node-source-');
core = substitute(core, 'sim-owner-authority-', 'sim-driver-mutation-');
const previousUmask = process.umask(0o077), tmp = await mkdtemp('/private/tmp/sim-driver-mutation-derivation-');
let complete = false, receipt: any;
try {
  const innerFixture = join(tmp, 'harness.mjs'), innerRunner = join(tmp, 'runner.mts'), innerReceipt = join(tmp, 'result.json');
  await writeFile(innerFixture, generatedFixture, {mode: 0o600, flag: 'wx'});
  core = substitute(core, "const receiptPath = join(repo, 'docs/archive/2026-10-15_ROOT_OWNER_AUTHORITY.json');", 'const receiptPath = ' + JSON.stringify(innerReceipt) + ';');
  core = substitute(core, "const fixturePath = join(repo, 'scripts/fixtures/root-owner-authority/harness.mjs');", 'const fixturePath = ' + JSON.stringify(innerFixture) + ';');
  await writeFile(innerRunner, core, {mode: 0o600, flag: 'wx'});
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR'].includes(key)));
  // Main's future run parses generated bytes before Docker; this source-writing
  // task neither invokes --check nor executes a container/module body.
  for (const path of [innerRunner, innerFixture]) await promisify(execFile)(process.execPath, ['--check', path], {env, timeout: 30000, maxBuffer: 65536});
  await promisify(execFile)(process.execPath, [innerRunner, '--run', '--cop-source', cop], {env, timeout: 330000, maxBuffer: 3 * 1024 * 1024});
  receipt = JSON.parse(await readFile(innerReceipt, 'utf8'));
  assert.equal(receipt.result.contractVersion, 'sim-driver-mutation-facts-root-v1'); assert.equal(receipt.result.passed, 8);
  assert.equal(receipt.result.actualCopIntentProducerExecuted, false); assert.equal(receipt.result.firstPostAnchorRejected, true);
  assert.equal(receipt.result.unknownTargetEndExercised, false); assert.equal(receipt.result.actualTargetDisconnectHold, true);
  for (const [path, pin] of Object.entries(originals)) assert.equal(digest(await readFile(path)), pin);
  for (const [name, pin] of Object.entries(expectedRootPins)) assert.equal(digest(await readFile(join(repo, 'deploy/account-safety', name))), pin);
  receipt.derivation = {sourcePins: originals, expectedRootPins, copCommit, copSourceSelection: 'git-show-only-not-live-worktree',
    selectedBootstrap: 'frozen-common22 imports-through-bootstrap-only', generatedFixtureSha256: digest(generatedFixture), generatedRunnerSha256: digest(core),
    generatedSourceParsedBeforeDocker: true, priorCasesExecuted: false, priorReceiptsChanged: false};
  complete = true;
} finally {
  process.umask(previousUmask); if (complete) await rm(tmp, {recursive: true}); else console.error('Private mutation-facts derivation retained: ' + tmp);
}
assert.ok(complete); receipt.cleanup.derivationContextRemoved = true;
await writeFile(finalReceipt, JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
console.log(JSON.stringify({receiptPath: finalReceipt, passed: 8, productionChanged: false}));
