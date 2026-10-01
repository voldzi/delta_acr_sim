import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seededTiming, seedRequestTiming } from "./seed-provider-request-timing.mjs";

const NOW = 1790841600000;

test("seed fills all feeds and never shortens an existing retry deadline", () => {
  assert.deepEqual(seededTiming({ version: 1, static: { nextAttemptAtMs: NOW + 900000 }, dynamic: { nextAttemptAtMs: NOW - 1000 } }, NOW), {
    version: 1,
    static: { nextAttemptAtMs: NOW + 900000 },
    dynamic: { nextAttemptAtMs: NOW + 300000 },
    tec: { nextAttemptAtMs: NOW + 300000 }
  });
});

test("malformed metadata and unknown keys fail closed", () => {
  for (const bad of [null, [], {}, { version: 2 }, { version: 1, token: "synthetic-not-a-secret" },
    { version: 1, static: null }, { version: 1, dynamic: [] }, { version: 1, tec: {} },
    { version: 1, static: { nextAttemptAtMs: -1 } }, { version: 1, static: { nextAttemptAtMs: 0, extra: true } },
    { version: 1, static: { nextAttemptAtMs: NaN } }, { version: 1, static: { nextAttemptAtMs: Infinity } },
    { version: 1, static: { nextAttemptAtMs: 0.5 } }, { version: 1, static: { nextAttemptAtMs: 8640000000000001 } }]) {
    assert.throws(() => seededTiming(bad, NOW));
  }
});

test("atomic private seed creates compatible metadata and preserves future gates", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sim-timing-seed-test-")));
  try {
    const output = join(directory, "provider-request-timing.json");
    const first = await seedRequestTiming(directory, () => NOW);
    assert.equal(first.uid, process.getuid());
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(output, "utf8")).static.nextAttemptAtMs, NOW + 300000);
    await seedRequestTiming(directory, () => NOW - 1000);
    assert.equal(JSON.parse(await readFile(output, "utf8")).static.nextAttemptAtMs, NOW + 300000);
    await seedRequestTiming(directory, () => NOW + 1000);
    assert.equal(JSON.parse(await readFile(output, "utf8")).dynamic.nextAttemptAtMs, NOW + 301000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("malformed existing file is untouched", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sim-timing-seed-test-")));
  try {
    const output = join(directory, "provider-request-timing.json");
    const bytes = "{broken";
    await writeFile(output, bytes, { mode: 0o600 });
    await assert.rejects(seedRequestTiming(directory, () => NOW));
    assert.equal(await readFile(output, "utf8"), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("symlink targets and directory traversal are refused", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sim-timing-seed-test-")));
  try {
    const outside = join(directory, "outside.json");
    await writeFile(outside, "sentinel", { mode: 0o600 });
    await symlink(outside, join(directory, "provider-request-timing.json"));
    await assert.rejects(seedRequestTiming(directory, () => NOW));
    await assert.rejects(seedRequestTiming(`${directory}/..`, () => NOW));
    await assert.rejects(seedRequestTiming(".", () => NOW));
    assert.equal(await readFile(outside, "utf8"), "sentinel");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
