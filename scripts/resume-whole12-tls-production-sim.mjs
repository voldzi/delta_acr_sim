/** Fixed existing synthetic namespace only. Private inputs never leave RAM. */
import assert from "node:assert/strict";
import { open, constants } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createTlsProductionSimFixture } from "./fixtures/whole12-tls-production-sim.mjs";
assert.deepEqual(process.argv.slice(2), ["--resume-owned-fixture"]);
process.umask(0o077);
async function privateJson(path) {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await f.stat();
    assert.ok(s.isFile() && s.nlink === 1 && s.uid === process.getuid() && (s.mode & 0o777) === 0o600 && s.size < 131072);
    return JSON.parse(await f.readFile("utf8"));
  } finally { await f.close(); }
}
let fixture;
try {
  const cfg = await privateJson("/dev/shm/cop-clean-whole/sim-private.json");
  const resume = await privateJson("/dev/shm/cop-clean-whole/sim-resume-private.json");
  assert.ok(["sim-whole12-owned-runner-resume-v1", "sim-whole12-owned-accepted-replay-resume-v1"].includes(resume.contractVersion));
  const replay = resume.contractVersion === "sim-whole12-owned-accepted-replay-resume-v1" ? resume.replay : undefined;
  if (replay) assert.deepEqual(replay, { mode: "same-epoch-completed-content-replay-v1", acceptedOperationId: "b6fe7a68-d7a2-49e0-a9da-6dd7bcb01a4e" });
  assert.equal(resume.configurationSha256, createHash("sha256").update(JSON.stringify(cfg)).digest("hex"));
  fixture = await createTlsProductionSimFixture({ root: "/private/tmp/sim-user-install-pg-9aff26e65b74", sourceRoot: "/fixture-clean", runtimeRoot: { "simulator-api": "/app", "ai-router-api": "/runtime/router", "situation-data-api": "/runtime/situation" } });
  const readback = await fixture.resumeExisting(cfg, resume.credentials, "http://127.0.0.1:8080/realms/cop/protocol/openid-connect/certs", replay);
  // Compare the HTTP JSON contract, not absent-vs-undefined JS-only fields.
  const actualJson = JSON.parse(JSON.stringify(readback));
  const expectedJson = structuredClone(resume.expectedReadback);
  // The original 0ded266 HTTP readback used legacy component labels even though
  // resumeExisting has checked the actual production-mode SQL enrollment.
  // Translate ONLY these exact two metadata fields; never data/state/digests.
  let metadataTranslated = false;
  for (const lane of ["ai", "driver"]) {
    if (expectedJson[lane].contractVersion === "cop-clean-whole-readback-v1") {
      assert.equal(expectedJson[lane].mode, "isolated-clean-lifecycle-v1");
      expectedJson[lane].contractVersion = "cop-clean-whole-tls-component-readback-v1";
      expectedJson[lane].mode = "production-clean-lifecycle-v1";
      metadataTranslated = true;
    } else {
      assert.equal(expectedJson[lane].contractVersion, "cop-clean-whole-tls-component-readback-v1");
      assert.equal(expectedJson[lane].mode, "production-clean-lifecycle-v1");
    }
  }
  const differences = [];
  const compare = (a, b, path = "readback") => {
    if (a && b && typeof a === "object" && typeof b === "object") {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[k], b[k], path + "." + k);
    } else if (a !== b) differences.push({ path, before: b, after: a });
  };
  compare(actualJson, expectedJson);
  if (differences.length) console.log(JSON.stringify({ error: "SANITIZED_READBACK_CHANGED", differences }));
  assert.deepEqual(actualJson, expectedJson, "EXISTING_A_B_CHANGED");
  for (const [port, path, token] of [
    [4311, "/api/v1/internal/user-lifecycle/v1/capabilities", cfg.input.base.environment.copServiceToken],
    [4312, "/api/v1/ai-router/internal/user-lifecycle/v1/capabilities", cfg.input.base.environment.copServiceToken],
    [4314, "/api/v1/internal/sim-user-data/v1/capabilities", cfg.input.userDataEnvironment.copToken]
  ]) {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(7000) });
    assert.equal(r.status, 200, "ACTUAL_RESUMED_CAPABILITY_NOT_READY");
    await r.body?.cancel();
  }
  console.log(JSON.stringify({ contractVersion: "sim-whole12-owned-runner-resume-receipt-v1", legacyReadbackMetadataTranslated: metadataTranslated, completedReplayMode: replay?.mode ?? "disabled", contentStateAndFingerprintsPreserved: true, preservedReadbackSha256: createHash("sha256").update(JSON.stringify(readback)).digest("hex"), actualCapabilities: { main: 200, ai: 200, driver: 200 }, reseeded: false, reenrolled: false, productionTouched: false, wholeAccountComplete: false }));
  await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
} catch (e) {
  const locations = [...String(e?.stack).matchAll(/(\/fixture-clean\/[^\s)]+:\d+:\d+)/g)].map(x => x[1]).slice(0, 6);
  console.error(JSON.stringify({ error: "SIM_OWNED_RESUME_FAILED", code: /^[A-Z0-9_]{1,64}$/.test(e?.code ?? "") ? e.code : "UNSPECIFIED", locations, wholeAccountComplete: false }));
  process.exitCode = 1;
} finally { await fixture?.close(); }
