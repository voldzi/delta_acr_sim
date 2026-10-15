/** Offline control-flow test: every psql call is intercepted; no real DB/secret. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repo, "scripts/provision-driver-measurements-postgres.sh");
const parent = realpathSync("/private/tmp");
const root = await mkdtemp(join(parent, "sim-driver-provision-mock-"));
await chmod(root, 0o700);
const log = join(root, "queries.jsonl"), credentials = join(root, "never-created.env");
const execute = promisify(execFile);
const mock = `#!/usr/bin/env node
import {appendFileSync} from "node:fs";
const args=process.argv.slice(2), q=args[args.indexOf("-Atc")+1];
appendFileSync(process.env.SIM_TEST_QUERY_LOG,JSON.stringify(args)+"\\n");
if(args.includes("-f")){console.log(process.env.SIM_TEST_VERIFIED);process.exit(0);}
if(q?.includes("SELECT rolsuper")){console.log("t");process.exit(0);}
if(q?.includes("count(*) FROM pg_roles")){console.log("3");process.exit(0);}
if(q?.includes("to_regnamespace")){console.log(process.env.SIM_TEST_GUARDED);process.exit(0);}
console.error("Unexpected SQL in offline mock");process.exit(90);
`;
await writeFile(join(root, "psql"), mock, { mode: 0o700, flag: "wx" });
const checks = [];
try {
  for (const [name, mode, guarded, verified, expected] of [
    ["guarded recover cannot rotate secrets or restore legacy DML", "--recover", "t", "t", 1],
    ["guarded apply cannot regrant legacy DML", "--apply", "t", "t", 1],
    ["guarded check verifies source profile without activation", "--check", "t", "t", 0],
    ["failed guarded verification does not fall back to legacy grants", "--check", "t", "f", 1],
    ["legacy check remains a read-only compatibility path", "--check", "f", "f", 0],
  ]) {
    await writeFile(log, "", { mode: 0o600 });
    const env = { PATH: `${root}:${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: root, PGUSER: "synthetic_admin", PGPASSWORD: "synthetic-never-used-password",
      DRIVER_MEASUREMENTS_CREDENTIALS_FILE: credentials, SIM_TEST_QUERY_LOG: log,
      SIM_TEST_GUARDED: guarded, SIM_TEST_VERIFIED: verified };
    let result;
    try { result = { ...(await execute("/bin/bash", [script, mode], { env, timeout: 5000 })), code: 0 }; }
    catch (error) { result = error; }
    assert.equal(result.code, expected, name);
    assert.equal(existsSync(credentials), false, "No credentials file may be written");
    const calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(calls.length, mode === "--check" && guarded === "t" ? 4 : 3);
    for (const args of calls) {
      assert.ok(!args.includes("-c"), "Only fixed readonly -Atc/-f checks");
      if (args.includes("-Atc")) {
        const sql = args[args.indexOf("-Atc") + 1];
        assert.match(sql, /^SELECT /u);
        assert.ok(!/\b(?:CREATE|ALTER|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE)\b/u.test(sql));
      } else {
        assert.equal(resolve(args[args.indexOf("-f") + 1]), join(repo, "deploy/driver-measurements/guarded-runtime-verification.sql"));
      }
    }
    assert.ok(!`${result.stdout ?? ""}${result.stderr ?? ""}`.includes(env.PGPASSWORD));
    if (mode === "--check" && guarded === "t" && verified === "t") assert.match(result.stdout, /not restore\/Root readiness or activation/u);
    checks.push({ name, passed: true });
  }
  console.log(JSON.stringify({ scope: "offline_psql_interception_only", passed: checks.length, checks,
    realDatabaseCalls: 0, credentialsWritten: false, productionChanged: false }));
} finally {
  assert.equal(dirname(realpathSync(root)), parent);
  assert.equal((await stat(root)).uid, process.getuid());
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  await rm(root, { recursive: true });
}
