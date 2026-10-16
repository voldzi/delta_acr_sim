import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPostgresFailure, verifyPostgresClient } from "./postgres-client-preflight.mjs";

const fakePassword = "synthetic-password-do-not-emit-5ef2a1";
const fakeDsn = "postgresql://synthetic-user:synthetic-password-do-not-emit-5ef2a1@private.example.invalid/synthetic_database";
const sensitiveTail = `\nFake diagnostic context: ${fakePassword} ${fakeDsn}\n`;
const wrapperStderr = "Error: You must install at least one postgresql-client-<version> package";

function fixture(t, body, mode = 0o700) {
  const directory = mkdtempSync(join(tmpdir(), "sim-postgres-client-preflight-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "psql");
  writeFileSync(path, "#!/bin/sh\n" + body + "\n", { mode });
  return { directory, path };
}

function safeFailure(work, expected) {
  assert.throws(work, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, expected);
    assert.ok(!error.message.includes(fakePassword));
    assert.ok(!error.message.includes(fakeDsn));
    assert.ok(!error.message.includes("private.example.invalid"));
    assert.ok(!error.message.includes("synthetic_database"));
    return true;
  });
}

test("actual Ubuntu pg_wrapper missing-client failure is explicit and redacted", (t) => {
  const client = fixture(
    t,
    `[ "$#" -eq 1 ] && [ "$1" = --version ] || exit 94\nprintf '%s\\n' '${wrapperStderr}' >&2\nprintf '%s\\n' '${fakePassword} ${fakeDsn}' >&2\nexit 1`
  );
  safeFailure(() => verifyPostgresClient(client.path), "POSTGRES_CLIENT_PREFLIGHT_CLIENT_NOT_INSTALLED");
});

test("a real executable version fixture accepts PostgreSQL 18.6 without SQL or inherited credentials", (t) => {
  const marker = fixture(t, "exit 0");
  const invocationPath = join(marker.directory, "invocation.txt");
  const client = fixture(
    t,
    `[ "$#" -eq 1 ] && [ "$1" = --version ] || exit 94
[ "$LC_ALL" = C ] || exit 95
[ "$PATH" = /usr/bin:/bin ] || exit 96
[ -z "\${PGPASSWORD+x}\${PGHOST+x}\${PGUSER+x}\${PGDATABASE+x}\${PGSERVICE+x}\${OPENAI_API_KEY+x}" ] || exit 97
printf '%s\\n' "$#:$1" > '${invocationPath}'
printf '%s\\n' 'psql (PostgreSQL) 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1)'`
  );
  const names = ["PGPASSWORD", "PGHOST", "PGUSER", "PGDATABASE", "PGSERVICE", "OPENAI_API_KEY"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = fakePassword;
    assert.deepEqual(verifyPostgresClient(client.path), { clientVersion: "18.6", clientMajor: 18 });
    assert.equal(readFileSync(invocationPath, "utf8"), "1:--version\n");
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("an executable older-major fixture refuses before any database connection", (t) => {
  const client = fixture(t, "[ \"$#\" -eq 1 ] && [ \"$1\" = --version ] || exit 94\nprintf '%s\\n' 'psql (PostgreSQL) 17.9'");
  safeFailure(() => verifyPostgresClient(client.path), "POSTGRES_CLIENT_VERSION_UNSUPPORTED");
});

test("a missing executable has a bounded client-missing error", (t) => {
  const client = fixture(t, "exit 0");
  safeFailure(() => verifyPostgresClient(join(client.directory, "does-not-exist")), "POSTGRES_CLIENT_PREFLIGHT_CLIENT_MISSING");
});

test("a non-executable private client has a bounded permission error", (t) => {
  const client = fixture(t, "exit 0", 0o600);
  safeFailure(() => verifyPostgresClient(client.path), "POSTGRES_CLIENT_PREFLIGHT_CLIENT_PERMISSION");
});

const cases = [
  ["Ubuntu missing versioned client", { status: 1, stderr: wrapperStderr }, "CLIENT_NOT_INSTALLED"],
  ["missing executable", { code: "ENOENT", stderr: "" }, "CLIENT_MISSING"],
  ["execution denied", { code: "EACCES", stderr: "" }, "CLIENT_PERMISSION"],
  ["process deadline", { code: "ETIMEDOUT", signal: "SIGTERM", stderr: "" }, "CLIENT_TIMEOUT"],
  ["process interrupted", { signal: "SIGINT", stderr: "" }, "CLIENT_INTERRUPTED"],
  [
    "password rejected",
    { status: 2, stderr: 'psql: error: connection failed: FATAL: password authentication failed for user "synthetic-user"' },
    "AUTH_FAILED"
  ],
  [
    "authentication policy",
    {
      status: 2,
      stderr:
        'psql: error: connection failed: FATAL: no pg_hba.conf entry for host "192.0.2.10", user "synthetic-user", database "synthetic_database", SSL encryption'
    },
    "AUTH_POLICY"
  ],
  ["certificate rejected", { status: 2, stderr: "psql: error: connection failed: SSL error: certificate verify failed" }, "TLS_CERTIFICATE_REJECTED"],
  ["root CA unreadable", { status: 2, stderr: 'psql: error: root certificate file "/private/synthetic-ca.crt" does not exist' }, "TLS_CA_UNREADABLE"],
  [
    "DNS resolution",
    { status: 2, stderr: 'psql: error: could not translate host name "private.example.invalid" to address: Name or service not known' },
    "DNS_FAILED"
  ],
  [
    "connection refused",
    { status: 2, stderr: 'psql: error: connection to server at "private.example.invalid", port 5000 failed: Connection refused' },
    "CONNECTION_REFUSED"
  ],
  [
    "connection deadline",
    { status: 2, stderr: 'psql: error: connection to server at "private.example.invalid", port 5000 failed: timeout expired' },
    "CONNECTION_TIMEOUT"
  ],
  ["approved SQLSTATE syntax", { status: 3, stderr: "ERROR: 42601" }, "SQLSTATE_42601"],
  ["approved SQLSTATE privilege", { status: 3, stderr: "ERROR: 42501" }, "SQLSTATE_42501"],
  ["unapproved pseudo SQLSTATE", { status: 3, stderr: "ERROR: Z9XYZ" }, "UNKNOWN"],
  ["unrecognized failure", { status: 1, stderr: "unrecognized synthetic provider error" }, "UNKNOWN"]
];

for (const [name, original, expected] of cases) {
  test(`classifier: ${name} never exposes a password, DSN or free stderr`, () => {
    for (const buffer of [false, true]) {
      const text = original.stderr + sensitiveTail;
      const error = { ...original, stderr: buffer ? Buffer.from(text) : text, message: `${fakePassword} ${fakeDsn}` };
      const result = classifyPostgresFailure(error);
      assert.equal(result, expected);
      assert.match(result, /^[A-Z0-9_]+$/);
      for (const secret of [fakePassword, fakeDsn, "private.example.invalid", "synthetic_database"]) assert.ok(!result.includes(secret));
    }
  });
}
