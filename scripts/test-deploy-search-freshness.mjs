#!/usr/bin/env node
// Synthetic file-only release-guard tests. No production paths are opened.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertEffectiveEnvironment, imagePinPatchPlan, parseArguments, replaceImagePinInPlace, runtimeEnvironmentMap } from "./deploy-search-freshness.mjs";

const revision = "90e1d8d0cc50236429b32476e3fd2f31899cf03c";
const oldImageId = "sha256:2f3aa1659d03c5eaf014353071e38f6abc1d2da1419a9ac2205a05b5873a5965";
const oldPin = "sim-situation-data-api:routing-location-03b842e005f1";
const newPin = "sim-situation-data-api:search-freshness-90e1d8d0cc50";
const sourceHash = "698e3dd4d978db08cd8ddbc484082327b3743392913ad37b53244cab3a327aaa";
const distHash = "3060a86a481496e701f9f3c1523bb2c95f68825348a285fe7979a090fe4aad1b";
const recordDir = "/srv/sim/.deploy-search-freshness-backups/synthetic-record-only";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validArgs = (mode = "--check") => [
  mode,
  "--image", newPin,
  "--revision", revision,
  "--expected-old-image-id", oldImageId,
  "--expected-source-sha256", sourceHash,
  "--expected-dist-sha256", distHash,
  ...(mode === "--rollback" ? ["--record-dir", recordDir] : [])
];

function replaceArg(argv, name, value) {
  const changed = [...argv];
  changed[changed.indexOf(name) + 1] = value;
  return changed;
}

const bytesFor = (pin = oldPin) => Buffer.from([
  "# Syntetický komentář: zachovat UTF-8 bajty",
  "SYNTHETIC_FLAG=true",
  `DRIVER_MEASUREMENTS_IMAGE=${pin}`,
  "# DRIVER_MEASUREMENTS_IMAGE=ignored-comment",
  "SYNTHETIC_PLACEHOLDER=not-a-secret",
  ""
].join("\r\n"));

function metadataFor(path) {
  const stat = lstatSync(path);
  return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777, dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size };
}

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "sim-freshness-guard-test-"));
  const path = join(dir, "fake-config");
  const original = bytesFor();
  writeFileSync(path, original, { mode: 0o600 });
  try {
    await run({ dir, path, original, metadata: metadataFor(path), next: imagePinPatchPlan(original, oldPin, newPin).nextBytes });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("import is side-effect-free and parses only complete pinned identities", () => {
  const parsed = parseArguments(validArgs());
  assert.deepEqual(parsed, { mode: "check", image: newPin, revision, expectedOld: oldImageId, sourceHash, distHash });
  assert.deepEqual(parseArguments(validArgs("--preflight")), { ...parsed, mode: "preflight" });
  assert.equal(parseArguments(validArgs("--apply")).mode, "apply");
  assert.deepEqual(parseArguments(validArgs("--rollback")), { ...parsed, mode: "rollback", recordDir });
});

test("argument validation rejects unknown, duplicate, missing and conflicting flags", () => {
  const malformed = [
    [],
    validArgs().slice(1),
    [...validArgs(), "--unknown", "synthetic"],
    [...validArgs(), "--image", newPin],
    [...validArgs(), "--apply"],
    ["--check", "--check", ...validArgs().slice(1)],
    ["--rollback", ...validArgs().slice(1)],
    [...validArgs(), "--record-dir", recordDir],
    [...validArgs("--preflight"), "--record-dir", recordDir],
    [...validArgs("--preflight"), "--check"],
    validArgs().slice(0, -1),
    ["--check", "--image", "--revision", revision],
    [...validArgs(), "synthetic-positional-value"]
  ];
  for (const argv of malformed) assert.throws(() => parseArguments(argv));
  for (const flag of ["--image", "--revision", "--expected-old-image-id", "--expected-source-sha256", "--expected-dist-sha256"]) {
    const argv = validArgs();
    const offset = argv.indexOf(flag);
    argv.splice(offset, 2);
    assert.throws(() => parseArguments(argv));
  }
});

test("argument validation rejects identity drift instead of accepting syntactically valid substitutes", () => {
  for (const [name, value] of [
    ["--image", oldPin],
    ["--image", "sim-situation-data-api:search-freshness-90e1d8d0cc5"],
    ["--image", `${newPin}-other`],
    ["--revision", "03b842e005f103bb02d622bb4fc95f27fbea9572"],
    ["--revision", "a".repeat(40)],
    ["--expected-old-image-id", `sha256:${"b".repeat(64)}`],
    ["--expected-source-sha256", "c".repeat(64)],
    ["--expected-dist-sha256", "d".repeat(64)],
    ["--revision", "INVALID"],
    ["--expected-source-sha256", sourceHash.toUpperCase()]
  ]) assert.throws(() => parseArguments(replaceArg(validArgs(), name, value)));
});

test("rollback accepts only an unambiguous record directory under the exact backup root", () => {
  for (const path of [
    "relative-record",
    "/srv/sim/.deploy-search-freshness-backups",
    "/srv/sim/.deploy-search-freshness-backups/",
    "/srv/sim/.deploy-search-freshness-backups-other/synthetic",
    "/srv/sim/.deploy-search-freshness-backups/../foreign",
    "/srv/sim/.deploy-search-freshness-backups//synthetic",
    "/srv/sim/.deploy-search-freshness-backups/synthetic/../foreign",
    "/private/tmp/synthetic"
  ]) assert.throws(() => parseArguments(replaceArg(validArgs("--rollback"), "--record-dir", path)));
  assert.throws(() => parseArguments([...validArgs("--rollback"), "--record-dir", recordDir]));
});

test("pure environment mapping retains every unique synthetic key and the exact complete values", () => {
  assert.deepEqual(runtimeEnvironmentMap([
    "SYNTHETIC_Z=last",
    "SYNTHETIC_A=first",
    "SYNTHETIC_EMPTY=",
    "SYNTHETIC_EQUALS=left=middle=right"
  ]), {
    SYNTHETIC_A: "first",
    SYNTHETIC_EMPTY: "",
    SYNTHETIC_EQUALS: "left=middle=right",
    SYNTHETIC_Z: "last"
  });
  assert.deepEqual(runtimeEnvironmentMap([]), {});
});

test("pure environment mapping rejects duplicate keys and malformed entries", () => {
  for (const entries of [
    ["SYNTHETIC_KEY=one", "SYNTHETIC_KEY=one"],
    ["SYNTHETIC_KEY=one", "SYNTHETIC_KEY=two"],
    ["=synthetic-value"],
    ["SYNTHETIC_KEY"],
    [""],
    [null],
    [42],
    null,
    { SYNTHETIC_KEY: "synthetic-value" }
  ]) assert.throws(() => runtimeEnvironmentMap(entries));
});

test("effective environment compares all merged image defaults and Compose overrides and removes null keys", () => {
  const image = ["SYNTHETIC_DEFAULT=image-default", "SYNTHETIC_OVERRIDE=image-value", "SYNTHETIC_REMOVE=image-value"],
    compose = { SYNTHETIC_OVERRIDE: "compose-value", SYNTHETIC_COMPOSE_ONLY: "not-a-real-secret", SYNTHETIC_REMOVE: null },
    runtime = ["SYNTHETIC_COMPOSE_ONLY=not-a-real-secret", "SYNTHETIC_DEFAULT=image-default", "SYNTHETIC_OVERRIDE=compose-value"];
  assert.equal(assertEffectiveEnvironment(image, compose, runtime), true);
  assert.equal(assertEffectiveEnvironment([], {}, []), true);
  assert.equal(assertEffectiveEnvironment(["SYNTHETIC_EMPTY=image-default"], { SYNTHETIC_EMPTY: "" }, ["SYNTHETIC_EMPTY="]), true);
});

test("effective environment rejects extra, missing, removed or changed runtime values without accepting a selected-key subset", () => {
  const image = ["SYNTHETIC_DEFAULT=image-default", "SYNTHETIC_OVERRIDE=image-value", "SYNTHETIC_REMOVE=image-value"],
    compose = { SYNTHETIC_OVERRIDE: "compose-value", SYNTHETIC_COMPOSE_ONLY: "not-a-real-secret", SYNTHETIC_REMOVE: null },
    runtime = ["SYNTHETIC_DEFAULT=image-default", "SYNTHETIC_OVERRIDE=compose-value", "SYNTHETIC_COMPOSE_ONLY=not-a-real-secret"];
  for (const incorrectRuntime of [
    runtime.slice(1),
    runtime.slice(0, -1),
    [...runtime, "SYNTHETIC_UNEXPECTED=unexpected-value"],
    [...runtime, "SYNTHETIC_REMOVE=image-value"],
    [...runtime, "SYNTHETIC_COMPOSE_ONLY=not-a-real-secret"],
    ["SYNTHETIC_DEFAULT=changed-value", ...runtime.slice(1)],
    [runtime[0], "SYNTHETIC_OVERRIDE=image-value", runtime[2]],
    [...runtime.slice(0, -1), "SYNTHETIC_COMPOSE_ONLY=changed-placeholder"]
  ]) assert.throws(() => assertEffectiveEnvironment(image, compose, incorrectRuntime));
  assert.throws(() => assertEffectiveEnvironment(image, { SYNTHETIC_OVERRIDE: "compose-value", SYNTHETIC_REMOVE: null }, runtime));
});

test("effective environment rejects duplicate image keys, malformed runtime entries and nonstring Compose overrides", () => {
  assert.throws(() => assertEffectiveEnvironment(["SYNTHETIC_KEY=one", "SYNTHETIC_KEY=one"], {}, ["SYNTHETIC_KEY=one"]));
  assert.throws(() => assertEffectiveEnvironment([], {}, ["SYNTHETIC_KEY"]));
  assert.throws(() => assertEffectiveEnvironment([], { SYNTHETIC_KEY: 42 }, ["SYNTHETIC_KEY=42"]));
  assert.throws(() => assertEffectiveEnvironment([], { SYNTHETIC_KEY: undefined }, []));
});

test("image patch plan changes only the single ASCII value and preserves UTF-8 comments and CRLF bytes", () => {
  const original = bytesFor();
  const before = Buffer.from(original);
  const plan = imagePinPatchPlan(original, oldPin, newPin);
  const offset = original.indexOf(Buffer.from(oldPin));
  assert.equal(Buffer.byteLength(oldPin), Buffer.byteLength(newPin));
  assert.equal(plan.offset, offset);
  assert.equal(plan.length, Buffer.byteLength(oldPin));
  assert.deepEqual(plan.beforeValueBytes, Buffer.from(oldPin));
  assert.deepEqual(plan.afterValueBytes, Buffer.from(newPin));
  assert.deepEqual(plan.nextBytes, bytesFor(newPin));
  assert.deepEqual(plan.nextBytes.subarray(0, offset), original.subarray(0, offset));
  assert.deepEqual(plan.nextBytes.subarray(offset + plan.length), original.subarray(offset + plan.length));
  assert.equal(plan.originalSha256, hash(original));
  assert.equal(plan.nextSha256, hash(plan.nextBytes));
  assert.match(plan.nonImageSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(original, before);
  assert.equal(imagePinPatchPlan(plan.nextBytes, newPin, oldPin).nonImageSha256, plan.nonImageSha256);
});

test("image patch planning rejects ambiguous lines, invalid bytes and pins rather than rewriting them", () => {
  for (const raw of [
    "SYNTHETIC_FLAG=true\n",
    `DRIVER_MEASUREMENTS_IMAGE=${oldPin}\nDRIVER_MEASUREMENTS_IMAGE=${oldPin}\n`,
    `DRIVER_MEASUREMENTS_IMAGE='${oldPin}'\n`,
    `DRIVER_MEASUREMENTS_IMAGE="${oldPin}"\n`,
    `export DRIVER_MEASUREMENTS_IMAGE=${oldPin}\n`,
    ` DRIVER_MEASUREMENTS_IMAGE=${oldPin}\n`,
    `DRIVER_MEASUREMENTS_IMAGE =${oldPin}\n`,
    `DRIVER_MEASUREMENTS_IMAGE=${oldPin} \n`,
    `DRIVER_MEASUREMENTS_IMAGE=${oldPin} # ambiguous\n`,
    `DRIVER_MEASUREMENTS_IMAGE=${newPin}\n`
  ]) assert.throws(() => imagePinPatchPlan(Buffer.from(raw), oldPin, newPin));
  assert.throws(() => imagePinPatchPlan(Buffer.from([0xc3, 0x28]), oldPin, newPin));
  assert.throws(() => imagePinPatchPlan(bytesFor(), oldPin, `${newPin}-longer`));
  assert.throws(() => imagePinPatchPlan(bytesFor(), oldPin, `${newPin.slice(0, -1)}é`));
});

test("forward and reverse in-place writes preserve inode, ownership, mode, size and all non-image bytes", async () => {
  await fixture(async ({ dir, path, original, metadata, next }) => {
    let locks = 0;
    const lock = (fd) => { assert.equal(typeof fd, "number"); locks += 1; };
    const forward = await replaceImagePinInPlace(path, original, next, metadata, lock);
    assert.equal(forward.verified, true);
    assert.equal(forward.previousSha256, hash(original));
    assert.equal(forward.nextSha256, hash(next));
    assert.deepEqual(readFileSync(path), next);
    assert.deepEqual(metadataFor(path), metadata);
    assert.deepEqual(readdirSync(dir), ["fake-config"]);
    const backward = await replaceImagePinInPlace(path, next, original, metadata, lock);
    assert.equal(backward.verified, true);
    assert.equal(backward.nonImageSha256, forward.nonImageSha256);
    assert.deepEqual(readFileSync(path), original);
    assert.deepEqual(metadataFor(path), metadata);
    assert.equal(locks, 2);
    assert.deepEqual(readdirSync(dir), ["fake-config"]);
  });
});

test("foreign whole-config drift and non-image writes are rejected before any write", async () => {
  await fixture(async ({ path, original, metadata, next }) => {
    const foreign = Buffer.from(original);
    foreign[0] = "!".charCodeAt(0);
    writeFileSync(path, foreign);
    await assert.rejects(async () => replaceImagePinInPlace(path, original, next, metadata, () => {}));
    assert.deepEqual(readFileSync(path), foreign);
    writeFileSync(path, original);
    const unsafeNext = Buffer.from(next);
    unsafeNext[0] = "!".charCodeAt(0);
    await assert.rejects(async () => replaceImagePinInPlace(path, original, unsafeNext, metadata, () => {}));
    assert.deepEqual(readFileSync(path), original);
    await assert.rejects(async () => replaceImagePinInPlace(path, original, Buffer.concat([next, Buffer.from("\n")]), metadata, () => {}));
    assert.deepEqual(readFileSync(path), original);
  });
});

test("mismatched mode, owner and file identity metadata cannot authorize a write", async () => {
  await fixture(async ({ path, original, metadata, next }) => {
    for (const wrong of [
      { ...metadata, uid: metadata.uid + 1 },
      { ...metadata, gid: metadata.gid + 1 },
      { ...metadata, mode: 0o644 },
      { ...metadata, dev: metadata.dev + 1 },
      { ...metadata, ino: metadata.ino + 1 },
      { ...metadata, nlink: 2 },
      { ...metadata, size: metadata.size + 1 }
    ]) {
      await assert.rejects(async () => replaceImagePinInPlace(path, original, next, wrong, () => {}));
      assert.deepEqual(readFileSync(path), original);
    }
    chmodSync(path, 0o644);
    await assert.rejects(async () => replaceImagePinInPlace(path, original, next, metadataFor(path), () => {}));
    assert.deepEqual(readFileSync(path), original);
  });
});

test("symlinks and hardlinked config files cannot be patched", async () => {
  await fixture(async ({ dir, path, original, metadata, next }) => {
    const symlink = join(dir, "fake-symlink");
    symlinkSync(path, symlink);
    await assert.rejects(async () => replaceImagePinInPlace(symlink, original, next, metadata, () => {}));
    assert.deepEqual(readFileSync(path), original);
    linkSync(path, join(dir, "fake-hardlink"));
    await assert.rejects(async () => replaceImagePinInPlace(path, original, next, metadataFor(path), () => {}));
    assert.deepEqual(readFileSync(path), original);
  });
});

test("a lock failure does not change any bytes or metadata", async () => {
  await fixture(async ({ dir, path, original, metadata, next }) => {
    await assert.rejects(async () => replaceImagePinInPlace(path, original, next, metadata, () => { throw new Error("synthetic lock failed"); }));
    assert.deepEqual(readFileSync(path), original);
    assert.deepEqual(metadataFor(path), metadata);
    assert.deepEqual(readdirSync(dir), ["fake-config"]);
  });
});

test("whole-config drift during lock acquisition is rejected before the image pin write", async () => {
  await fixture(async ({ path, original, metadata, next }) => {
    const foreign = Buffer.from(original);
    foreign[0] = "!".charCodeAt(0);
    await assert.rejects(async () => replaceImagePinInPlace(path, original, next, metadata, () => {
      writeFileSync(path, foreign);
    }));
    assert.deepEqual(readFileSync(path), foreign);
    assert.deepEqual(metadataFor(path), metadata);
  });
});

test("a path inode race after opening is rejected before writing either retained or replacement file", async () => {
  await fixture(async ({ dir, path, original, metadata, next }) => {
    const retainedPath = join(dir, "synthetic-raced-original");
    await assert.rejects(async () => replaceImagePinInPlace(path, original, next, metadata, () => {
      renameSync(path, retainedPath);
      writeFileSync(path, original, { mode: 0o600 });
    }));
    assert.notEqual(lstatSync(path).ino, metadata.ino);
    assert.deepEqual(readFileSync(path), original);
    assert.deepEqual(readFileSync(retainedPath), original);
  });
});
