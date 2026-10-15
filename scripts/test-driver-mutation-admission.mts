/** NEW source-only dedicated mutation-admission gate; main alone executes.
 * Reuses frozen packaging/bootstrap/helpers, never their cases or receipts.
 * Fixed local images/no pulls/builds/network/binds/ports. No production state.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

assert.equal(process.argv.length, 5); assert.equal(process.argv[2], '--run'); assert.equal(process.argv[3], '--cop-source');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), cop = resolve(process.argv[4]);
const self = fileURLToPath(import.meta.url), fixture = join(repo, 'scripts/fixtures/driver-mutation-admission/harness.mjs');
const receiptPath = join(repo, 'docs/archive/2026-10-15_DRIVER_MUTATION_ADMISSION_ROOT.json');
assert.ok(!existsSync(receiptPath), 'Never overwrite previous evidence.');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const factsRunner = join(repo, 'scripts/test-driver-mutation-facts.mts'), factsFixture = join(repo, 'scripts/fixtures/driver-mutation-facts/harness.mjs');
const frozen = new Map([
  [factsRunner, '3120dac5729ec8671f057929eccbd59d2886e122d399e4dc71bbb4b30986748d'],
  [factsFixture, '2162f54f229d7333f13787b3b0f63e11fcc0dc03851662297e6ac7f86f58b9b9'],
  [join(repo, 'docs/archive/2026-10-15_DRIVER_MUTATION_FACTS_ROOT.json'), 'a75d5ef96937321a2f19617a884482edf95cb451f23b2f34b3fb95650384b06d'],
]);
for (const [path, pin] of frozen) assert.equal(hash(await readFile(path)), pin);
const commonPath = join(repo, 'deploy/account-safety/root-owner-authority.mjs');
const commonPin = '09457545a9fa57ffd95507637efdde11c768a9561e42851b543b3f5406ee8f72';
assert.equal(hash(await readFile(commonPath)), commonPin);
const newPins = {[self]: hash(await readFile(self)), [fixture]: hash(await readFile(fixture)), [commonPath]: commonPin};
const replace = (source: string, before: string, after: string) => {assert.equal(source.split(before).length, 2, 'Frozen derivation site changed.'); return source.replace(before, after);};
// Only the frozen facts fixture's SQL/crypto/context helpers, before its first
// case function, are reused. Its eight groups/run()/result/cleanup never enter.
const helperSource = await readFile(factsFixture, 'utf8');
const helperStart = helperSource.indexOf('const mutOperation='), helperEnd = helperSource.indexOf('async function mutHeldSessionCase(){');
assert.ok(helperStart > 0 && helperEnd > helperStart);
const helpers = replace(helperSource.slice(helperStart, helperEnd), 'let mutationCommon,mutationResult,mutationFailure;', 'let mutationCommon;');
let core = await readFile(factsRunner, 'utf8');
core = replace(core, "const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), cop = resolve(process.argv[4]);\nconst finalReceipt = join(repo, 'docs/archive/2026-10-15_DRIVER_MUTATION_FACTS_ROOT.json');",
  'const repo = ' + JSON.stringify(repo) + ", cop = resolve(process.argv[4]);\nconst finalReceipt = join(repo, 'docs/archive/2026-10-15_DRIVER_MUTATION_FACTS_ROOT.json');");
core = replace(core, "const self = fileURLToPath(import.meta.url), fixture = join(repo, 'scripts/fixtures/driver-mutation-facts/harness.mjs');",
  'const self = fileURLToPath(import.meta.url), fixture = ' + JSON.stringify(fixture) + ';');
core = replace(core, "'root-owner-authority.mjs': '501d8a638b442250d64905f66a182de6a82296cd2324a4e63ac888eee209b4f4'", "'root-owner-authority.mjs': '" + commonPin + "'");
core = replace(core, "const generatedFixture = Buffer.from(bootstrap + '\\n' + await readFile(fixture, 'utf8'));",
  "bootstrap = substitute(bootstrap, \"['owner-authority', 'runtime-observations', 'read-evidence', 'read-permits', 'ai-read-permits']\", \"['owner-authority', 'runtime-observations', 'read-evidence', 'read-permits', 'ai-read-permits', 'mutation-scopes']\");\n" +
  "const generatedFixture = Buffer.from(bootstrap + '\\n' + " + JSON.stringify(helpers) + " + '\\n' + await readFile(fixture, 'utf8'));");
core = replace(core, 'assert.equal(result.passed, 8); assert.equal(result.cases.length, 8);', 'assert.equal(result.passed, 9); assert.equal(result.cases.length, 9);');
core = replace(core, 'assert.equal(receipt.result.passed, 8);', 'assert.equal(receipt.result.passed, 9);');
core = replace(core, 'passed: 8, productionChanged: false', 'passed: 9, productionChanged: false');
core = core.replaceAll('sim-driver-mutation-facts-root-v1', 'sim-driver-mutation-admission-root-v1')
  .replaceAll('SOURCE_DRIVER_MUTATION_FACTS_ROOT_ONLY', 'SOURCE_DRIVER_MUTATION_ADMISSION_ROOT_ONLY')
  .replaceAll('csm.sim.test=driver-mutation-facts-20261015', 'csm.sim.test=driver-mutation-admission-20261015')
  .replaceAll('sim-driver-mutation-facts-', 'sim-driver-mutation-admission-')
  .replaceAll('sim-mutation-node-source-', 'sim-admission-node-source-');
const umask = process.umask(0o077), tmp = await mkdtemp('/private/tmp/sim-mutation-admission-source-');
let complete = false, receipt: any;
try {
  const inner = join(tmp, 'runner.mts'), temporaryReceipt = join(tmp, 'result.json');
  core = replace(core, "const finalReceipt = join(repo, 'docs/archive/2026-10-15_DRIVER_MUTATION_FACTS_ROOT.json');", 'const finalReceipt = ' + JSON.stringify(temporaryReceipt) + ';');
  await writeFile(inner, core, {mode: 0o600, flag: 'wx'});
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR'].includes(key)));
  // Future main run only: check generated source before any Docker operation.
  await promisify(execFile)(process.execPath, ['--check', inner], {env, timeout: 30000, maxBuffer: 65536});
  await promisify(execFile)(process.execPath, [inner, '--run', '--cop-source', cop], {env, timeout: 360000, maxBuffer: 3 * 1024 * 1024});
  receipt = JSON.parse(await readFile(temporaryReceipt, 'utf8'));
  assert.equal(receipt.result.contractVersion, 'sim-driver-mutation-admission-root-v1'); assert.equal(receipt.result.passed, 9);
  assert.equal(receipt.result.actualDedicatedSigner, true); assert.equal(receipt.result.actualCopIntentProducerExecuted, false);
  assert.equal(receipt.result.mutationScopeSynthetic, true); assert.equal(receipt.result.rootKeeperExercised, false);
  for (const [path, pin] of [...frozen, ...Object.entries(newPins)]) assert.equal(hash(await readFile(path)), pin);
  receipt.admissionGate = {newSourcePins: newPins, frozenFactsPins: Object.fromEntries(frozen), commonPin,
    packagingSource: 'frozen facts runner mechanics; common22 bootstrap only; frozen facts helper prefix only',
    helperPrefixSha256: hash(helpers), generatedRunnerSha256: hash(core), priorCasesExecuted: false, priorReceiptsChanged: false};
  complete = true;
} finally {
  process.umask(umask); if (complete) await rm(tmp, {recursive: true}); else console.error('Private admission source derivation retained: ' + tmp);
}
assert.ok(complete); receipt.cleanup.admissionDerivationRemoved = true;
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
console.log(JSON.stringify({receiptPath, passed: 9, productionChanged: false}));
