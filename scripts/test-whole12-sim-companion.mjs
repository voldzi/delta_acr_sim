/** Owned PostgreSQL + RSA issuer test. Not actual Keycloak/Root acceptance. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { createServer } from "node:http";
import { generateKeyPairSync, createSign, randomUUID, randomBytes } from "node:crypto";
import { join } from "node:path";
import { createCleanWholeDatabase, FIXTURE_CLUSTER, FIXTURE_ISSUER } from "./fixtures/clean-whole-sim-v1.mjs";
import { createWhole12SimCompanion, readPrivateCompanionInput } from "./fixtures/clean-whole12-sim-companion.mjs";
assert.deepEqual(process.argv.slice(2), ["--run"]);
const run = promisify(execFile),
  bin = "/opt/homebrew/opt/postgresql@18/bin";
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"].includes(k)));
assert.match((await run(join(bin, "postgres"), ["--version"], { env })).stdout, /18\.3/);
const umask = process.umask(0o077),
  root = await mkdtemp("/private/tmp/sim-clean-whole-pg-");
await mkdir(join(root, "s"), { mode: 0o700 });
let pg = false,
  db,
  companion,
  jwks,
  passed = false,
  checks = 0;
const check = (x) => {
  assert.ok(x);
  checks++;
};
try {
  await run(join(bin, "initdb"), ["-D", join(root, "db"), "-U", "owned_fixture_admin", "--auth-local=trust", "--auth-host=reject", "--no-locale"], { env });
  await run(
    join(bin, "pg_ctl"),
    [
      "-D",
      join(root, "db"),
      "-l",
      join(root, "pg.log"),
      "-o",
      `-k ${join(root, "s")} -c listen_addresses='' -c cluster_name=${FIXTURE_CLUSTER}`,
      "-w",
      "start"
    ],
    { env }
  );
  pg = true;
  db = await createCleanWholeDatabase({ socket: join(root, "s") });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "companion-owned-rsa", alg: "RS256", use: "sig" };
  jwks = createServer((q, r) => {
    assert.equal(q.url, "/realms/cop/protocol/openid-connect/certs");
    r.setHeader("content-type", "application/json");
    r.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((r) => jwks.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${jwks.address().port}/realms/cop/protocol/openid-connect/certs`;
  const actors = [0, 1].map(() => {
    const a = {
      subjectId: randomUUID(),
      routerUserId: "cop_" + randomBytes(32).toString("base64url"),
      contributorIdDay: randomBytes(32).toString("base64url"),
      oidcIat: Math.floor(Date.now() / 1000)
    };
    const h = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })).toString("base64url");
    const b = Buffer.from(
      JSON.stringify({
        iss: FIXTURE_ISSUER,
        sub: a.subjectId,
        iat: a.oidcIat,
        exp: a.oidcIat + 600,
        aud: "cop-web",
        azp: "cop-web",
        realm_access: { roles: ["SIM_ADMIN"] }
      })
    ).toString("base64url");
    a.jwt =
      h +
      "." +
      b +
      "." +
      createSign("RSA-SHA256")
        .update(h + "." + b)
        .end()
        .sign(privateKey)
        .toString("base64url");
    return a;
  });
  const file = join(root, "private.json");
  await writeFile(file, JSON.stringify({ synthetic: true }), { mode: 0o600 });
  check((await readPrivateCompanionInput(file)).synthetic === true);
  await chmod(file, 0o644);
  await assert.rejects(() => readPrivateCompanionInput(file));
  checks++;
  await chmod(file, 0o600);
  companion = createWhole12SimCompanion(db);
  await assert.rejects(() => companion.seed(...actors, "https://wrong.invalid/realms/cop", origin));
  checks++;
  const privateConfig = await companion.seed(...actors, FIXTURE_ISSUER, origin);
  check(privateConfig.limitations.productionContinuityAttached === false);
  check((await fetch(privateConfig.endpoints.readback)).status === 401);
  const auth = { authorization: "Bearer " + privateConfig.input.base.environment.copServiceToken };
  check((await fetch(privateConfig.endpoints.readback, { headers: auth })).status === 200);
  const before = await companion.read();
  check(before.app.actors.a.counts.scenarios === 1 && before.app.actors.b.counts.scenarios === 1);
  check(before.simHistory.a.requests === 1 && before.simHistory.b.requests === 1);
  await companion.outage("main");
  await assert.rejects(() => fetch("http://127.0.0.1:4314/health/ready"));
  checks++;
  check((await fetch(privateConfig.endpoints.readback, { headers: auth })).status === 503);
  await companion.recover("main");
  const after = await companion.read();
  check(after.simHistory.b.fingerprint === before.simHistory.b.fingerprint);
  check(after.app.actors.b.counts.scenarios === 1);
  check(after.wholeAccountComplete === false && after.productionContinuityAttached === false);
  check(before.ai.externalProviderAttempts === 0 && before.driver.externalProviderAttempts === 0);
  console.log(
    JSON.stringify({
      contractVersion: "whole12-sim-companion-source-test-v1",
      checks,
      actualPostgres: true,
      actualCompiledHttp: true,
      actualRsaVerification: true,
      actualKeycloak: false,
      productionContinuityAttached: false,
      wholeAccountComplete: false,
      productionWrites: 0
    })
  );
  passed = true;
} finally {
  await companion?.close();
  await db?.close();
  if (jwks) await new Promise((r) => jwks.close(r));
  if (pg) await run(join(bin, "pg_ctl"), ["-D", join(root, "db"), "-m", "fast", "-w", "stop"], { env });
  if (passed) await rm(root, { recursive: true, force: true });
  process.umask(umask);
}
