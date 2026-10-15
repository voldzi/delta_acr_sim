/** NEW source-only policy-lineage integration runner. Main alone executes it.
 * Reuses selected frozen harness mechanics, never its old cases or receipt.
 * No image pull/build, host bind, external network, production secret or target.
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
const finalReceipt = join(repo, 'docs/archive/2026-10-15_ROOT_OWNER_POLICY_LINEAGE.json');
assert.ok(!existsSync(finalReceipt), 'Never overwrite previous evidence.');
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const self = fileURLToPath(import.meta.url), fixture = join(repo, 'scripts/fixtures/root-owner-policy-lineage/harness.mjs');
const oldRunner = join(repo, 'scripts/test-root-owner-authority.mts');
const oldFixture = join(repo, 'scripts/fixtures/root-owner-authority/harness.mjs');
const frozenRunnerPin = 'ec64cb120683e9d5b2eb7b78c287d1f7ae35989d6ef42830d9738aa8e6b05cf0';
const frozenFixturePin = '8e48b668b319b1a8153809c081c4fd4066f5da8f80bdb058284a27f473f5ae46';
const expectedRootPins = Object.freeze({
  // Main fills these only after reviewing the actual COP-approved composition.
  // Placeholders are hard failures before any container/context is created.
  'root-owner-authority.mjs': 'b592e1e26768d70c8fca1d699caba6007e5b40a071fe8326beccf51df8a0b7ca',
  'root-owner-authority-protocol.mjs': '0fab874389fdc5660241f7b26ead63a7b9003b06915a78dcbec4b744614632a3',
  'root-owner-checkpoint.mjs': '1ed0946027261d7111a84b7f2e8633e424301f5b34f9cc210f9866a634017304',
  'root-owner-policy-lineage.mjs': 'c918139370a8782c2605d5957d7c79e2e5cacc1e31ac9d519d11e208a4bfcd44',
});
for (const [name, pin] of Object.entries(expectedRootPins)) {
  assert.match(pin, /^[0-9a-f]{64}$/, 'Actual reviewed Root composition pin required.');
  assert.equal(digest(await readFile(join(repo, 'deploy/account-safety', name))), pin);
}
const originals = Object.fromEntries(await Promise.all([self, fixture, oldRunner, oldFixture].map(async path => [path, digest(await readFile(path))])));
assert.equal(originals[oldRunner], frozenRunnerPin); assert.equal(originals[oldFixture], frozenFixturePin);
const substitute = (source: string, before: string, after: string) => {
  assert.equal(source.split(before).length, 2, 'Frozen derivation site changed.'); return source.replace(before, after);
};
let bootstrap = await readFile(oldFixture, 'utf8');
const first = bootstrap.indexOf("import assert from 'node:assert/strict';"), last = bootstrap.indexOf('async function lockProbe(');
assert.ok(first > 0 && last > first); bootstrap = bootstrap.slice(first, last);
// Preserve all actual crypto, SQL, TLS, peer SELF and custody mechanics. Only
// the explicit synthetic enrollment inputs/lifetime change for this new test.
bootstrap = substitute(bootstrap, "'checkpoint-acceptances', 'checkpoint-intents', 'checkpoint-dispatches'",
  "'checkpoint-acceptances', 'checkpoint-intents', 'checkpoint-dispatches', 'owner-policy-history'");
bootstrap = substitute(bootstrap, 'ttl = 20000} = {})', 'ttl = 29900} = {})');
bootstrap = substitute(bootstrap, 'timelineId: value.timeline}, 25000);', 'timelineId: value.timeline}, 29900);');
const transitionStart = bootstrap.indexOf('    let initialTransition;'), transitionEnd = bootstrap.indexOf("    stage = 'bootstrap.' + owner + '.root-policy-seed';", transitionStart);
assert.ok(transitionStart > 0 && transitionEnd > transitionStart);
bootstrap = bootstrap.slice(0, transitionStart) + '    const initialTransition = await lineageInitialTransition(owner);\n' + bootstrap.slice(transitionEnd);
const newFixtureBytes = Buffer.from(bootstrap + '\n' + await readFile(fixture, 'utf8'));
const previousUmask = process.umask(0o077), tmp = await mkdtemp('/private/tmp/sim-owner-lineage-source-');
let complete = false, receipt: any;
try {
  const generatedFixture = join(tmp, 'harness.mjs'), generatedRunner = join(tmp, 'runner.mts'), temporaryReceipt = join(tmp, 'result.json');
  await writeFile(generatedFixture, newFixtureBytes, {mode: 0o600, flag: 'wx'});
  let core = await readFile(oldRunner, 'utf8');
  core = substitute(core, "const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), cop = resolve(process.argv[4]);",
    'const repo = ' + JSON.stringify(repo) + ', cop = resolve(process.argv[4]);');
  core = substitute(core, "const receiptPath = join(repo, 'docs/archive/2026-10-15_ROOT_OWNER_AUTHORITY.json');", 'const receiptPath = ' + JSON.stringify(temporaryReceipt) + ';');
  core = substitute(core, "const fixturePath = join(repo, 'scripts/fixtures/root-owner-authority/harness.mjs');", 'const fixturePath = ' + JSON.stringify(generatedFixture) + ';');
  core = substitute(core, "pending = ['root-owner-authority.mjs', 'root-owner-read.mjs'];",
    "pending = ['root-owner-authority.mjs', 'root-owner-read.mjs', 'root-owner-checkpoint.mjs', 'root-owner-policy-lineage.mjs'];");
  core = substitute(core, "'root-owner-authority.mjs': '4842899595b9b2efa9c913057ad1978208e44042ee39d7f009faf49565921d06'",
    "'root-owner-authority.mjs': '" + expectedRootPins['root-owner-authority.mjs'] + "'");
  core = substitute(core, "assert.equal(result.contractVersion, 'sim-root-owner-authority-isolated-linux-v1');",
    "assert.equal(result.contractVersion, 'sim-root-owner-policy-lineage-isolated-linux-v1');");
  core = substitute(core, 'assert.equal(result.passed, 22); assert.equal(result.cases.length, 22);',
    'assert.equal(result.passed, 8); assert.equal(result.cases.length, 8);');
  core = substitute(core, "status: 'SOURCE_ROOT_OWNER_AUTHORITY_LINUX_ONLY'", "status: 'SOURCE_ROOT_OWNER_POLICY_LINEAGE_LINUX_ONLY'");
  await writeFile(generatedRunner, core, {mode: 0o600, flag: 'wx'});
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR'].includes(key)));
  await promisify(execFile)(process.execPath, [generatedRunner, '--run', '--cop-source', cop], {env, timeout: 330000, maxBuffer: 3 * 1024 * 1024});
  receipt = JSON.parse(await readFile(temporaryReceipt, 'utf8'));
  assert.equal(receipt.result.contractVersion, 'sim-root-owner-policy-lineage-isolated-linux-v1'); assert.equal(receipt.result.passed, 8);
  for (const [path, pin] of Object.entries(originals)) assert.equal(digest(await readFile(path)), pin);
  for (const [name, pin] of Object.entries(expectedRootPins)) assert.equal(digest(await readFile(join(repo, 'deploy/account-safety', name))), pin);
  receipt.derivation = {sourcePins: originals, expectedRootPins, frozenRunnerPin, frozenFixturePin,
    selectedBootstrap: 'imports-through-bootstrap-before-lockProbe', generatedFixtureSha256: digest(newFixtureBytes), generatedRunnerSha256: digest(core),
    oldCasesExecuted: false, frozenFilesChanged: false};
  complete = true;
} finally {
  process.umask(previousUmask);
  if (complete) await rm(tmp, {recursive: true});
  else console.error('Private source-only lineage derivation retained: ' + tmp);
}
assert.ok(complete); receipt.cleanup.derivationContextRemoved = true;
await writeFile(finalReceipt, JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
console.log(JSON.stringify({receiptPath: finalReceipt, passed: 8, productionChanged: false}));
