/** Reproducible pure wire/compiled-parser tests only. No Root authority,
 * enrollment, SQL, native transport, production target or provider call. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {copyFile, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

assert.deepEqual(process.argv.slice(2), ['--run']);
assert.equal(process.versions.node.split('.')[0], '24');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputs = Object.freeze({
  'deploy/account-safety/ai-owner-domain.mjs': '2f8ee0a7496451d8bb257f1252a63c2872f22ed3e043592cb5480cd8a2eaf7f7',
  'deploy/account-safety/ai-owner-domain.test.mjs': '2984b1d87a752adb88253a16baa4bf63f925b0a232a785c885daeabbed385d68',
  'deploy/account-safety/driver-owner-domain.mjs': 'ed0b8aa9543cd5daa54c53b8b22d6cc84d763c1c436833b3bb64bc3049f96651',
  'deploy/account-safety/driver-owner-domain.test.mjs': '5bdcaefe569f74c87531a69587e816dad55597579c2981359861c2c0187f708e',
  'deploy/ai-router/checkpoint-facts.mjs': 'bcc476814331e1bf4fc68e552f8f4ca28f3b61a1ca32ebf7d6fbdbc6ef8d183f',
  'apps/situation-data-api/dist/driver-account-erasure.js': 'd184e31dda5484d4d8d2382208834197247ff47a1a37437f4f0550fdd95ea999',
  'apps/situation-data-api/dist/driver-revocation-actor.js': '43116e10d8616f1320593b32a76dfdb7c15f6718f8b17e1f3b84bfc40efbe7fa',
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const verify = async () => {
  for(const [path, expected] of Object.entries(inputs)) assert.equal(digest(await readFile(join(repo, path))), expected, path);
};
await verify();
const base = await realpath('/private/tmp'), previousUmask = process.umask(0o077);
const staging = await mkdtemp(join(base, 'sim-owner-domain-proof-'));
const owned = async () => {
  assert.equal(dirname(await realpath(staging)), base);
  assert.ok(staging.startsWith(join(base, 'sim-owner-domain-proof-')));
  const info = await stat(staging); assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o777, 0o700);
};
try {
  await owned();
  // Mechanical fixture copying only. The fixed sibling layout is identical
  // to the reviewed installation layout; no runtime module selector exists.
  for(const path of Object.keys(inputs)) await copyFile(join(repo, path), join(staging, path.split('/').at(-1)));
  await writeFile(join(staging, 'package.json'), '{"private":true,"type":"module"}\n', {flag: 'wx', mode: 0o600});
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'TMPDIR', 'LANG', 'LC_ALL'].includes(key)));
  const {stdout} = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap',
    join(staging, 'ai-owner-domain.test.mjs'), join(staging, 'driver-owner-domain.test.mjs')],
  {cwd: staging, env, timeout: 30000, maxBuffer: 1024 * 1024});
  assert.match(stdout, /^# tests 30$/m); assert.match(stdout, /^# pass 30$/m); assert.match(stdout, /^# fail 0$/m);
  await verify();
  process.stdout.write('PASS 30 pure owner-domain cases against the pinned actual compiled parsers; no Root/SQL/production acceptance.\n');
} finally {
  try { await owned(); await rm(staging, {recursive: true}); }
  finally {process.umask(previousUmask);}
}
