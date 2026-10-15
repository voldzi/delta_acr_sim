import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bindPostStopEnrollment, verifyPreservedIdentity } from "./install-sim-erasure-disabled.mjs";
import { SOURCE_REVISION, EXPECTED_CLEANUP_HASH } from "./inspect-sim-root-inventory.mjs";
const original = JSON.parse(readFileSync(new URL("../deploy/account-safety/20261015-root-inventory.json", import.meta.url)));
const enrollment = {
  identityReviewed: true,
  identityReviewEvidenceDigest: "b".repeat(64),
  guardStoreId: "synthetic-unchanged-guard",
  driver: { storeId: "synthetic-driver" },
  router: { storeId: "synthetic-router" },
  configurationFingerprint: "c".repeat(64)
};
const post = {
  sourceRevision: SOURCE_REVISION,
  originalInventoryDigest: original.reportInventory.inventoryDigest,
  requiresEnrollmentReview: true,
  otherProducerSourcesUnchanged: true,
  retiredCronSha256: EXPECTED_CLEANUP_HASH,
  reportInventory: { inventoryDigest: "d".repeat(64), fileCount: 0, bytes: 0, lockPresent: false, activeProducerCount: 0, producerMatches: [] }
};
test("post-stop actual digest replaces only publication proof, never identity or database bindings", () => {
  const result = bindPostStopEnrollment(enrollment, original, post);
  const { reportPublication, ...rest } = result;
  assert.deepEqual(rest, enrollment);
  assert.deepEqual(reportPublication, { policy: "shared_generation_fence-v1", externalProducersReviewed: true, inventoryDigest: "d".repeat(64) });
  assert.notEqual(reportPublication.inventoryDigest, original.reportInventory.inventoryDigest);
});
test("unexpected source, original digest, cron and producer/report drift refuse", () => {
  for (const delta of [
    { sourceRevision: "wrong" },
    { originalInventoryDigest: "e".repeat(64) },
    { retiredCronSha256: "e".repeat(64) },
    { otherProducerSourcesUnchanged: false },
    { requiresEnrollmentReview: false }
  ])
    assert.throws(() => bindPostStopEnrollment(enrollment, original, { ...post, ...delta }));
  for (const delta of [
    { fileCount: 1 },
    { bytes: 1 },
    { lockPresent: true },
    { activeProducerCount: 1 },
    { producerMatches: [{ path: "unreviewed" }] },
    { inventoryDigest: "bad" }
  ])
    assert.throws(() => bindPostStopEnrollment(enrollment, original, { ...post, reportInventory: { ...post.reportInventory, ...delta } }));
  assert.throws(() => bindPostStopEnrollment({ ...enrollment, identityReviewed: false }, original, post));
});
test("actual running actor, namespace and encryption keys must match production secrets", () => {
  const driver = { DRIVER_MEASUREMENTS_HASH_SECRET: "synthetic-driver-hash" };
  const router = {
    AI_ROUTER_COP_ACTOR_SECRET: "synthetic-router-actor",
    AI_ROUTER_USER_HASH_SECRET: "synthetic-router-hash",
    AI_ROUTER_CREDENTIAL_ENCRYPTION_KEY: "synthetic-encryption"
  };
  const env = Object.entries({ ...driver, ...router, SIM_OIDC_ISSUER: "https://login.zeleznalady.cz/realms/cop" })
    .map(([k, v]) => k + "=" + v)
    .join("\n");
  assert.equal(verifyPreservedIdentity(env, driver, router).routerActorPreserved, true);
  for (const key of Object.keys(router)) assert.throws(() => verifyPreservedIdentity(env, driver, { ...router, [key]: "synthetic-changed" }));
  assert.throws(() => verifyPreservedIdentity(env, { DRIVER_MEASUREMENTS_HASH_SECRET: "changed" }, router));
});
test("root entrypoint and rollback remain disabled-only, no secret-input JSON or legacy image fallback", () => {
  const shell = readFileSync(new URL("./install-sim-erasure-disabled.sh", import.meta.url), "utf8"),
    main = readFileSync(new URL("./install-sim-erasure-disabled.mjs", import.meta.url), "utf8");
  assert.ok(shell.includes("read -r -s PGPASSWORD"));
  assert.ok(shell.includes("flock -n 9"));
  assert.ok(!main.includes("identity-input.json"));
  assert.ok(main.includes("stageCoordinatedIdentity"));
  assert.match(main, /oldImageFallback:\s*false/);
  assert.match(main, /wholeAccountComplete:\s*false/);
});
