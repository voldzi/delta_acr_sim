import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { proposedIdentityEnvironment, stageIdentity, coordinatedIdentityProposal, stageCoordinatedIdentity } from "./stage-sim-erasure-identity.mjs";
const original =
  [
    "AI_ROUTER_COP_ACTOR_SECRET=synthetic-existing-router-actor-32-characters",
    "DRIVER_MEASUREMENTS_HASH_SECRET=synthetic-existing-driver-hash-32-characters",
    "AI_ROUTER_USER_HASH_SECRET=synthetic-existing-router-hash-32-characters",
    "AI_ROUTER_CREDENTIAL_ENCRYPTION_KEY=synthetic-preserved-encryption-key",
    "UNRELATED_SENTINEL=preserved",
    "DRIVER_ACCOUNT_ERASURE_ISSUER="
  ].join("\n") + "\n";
const input = {
  DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET: "synthetic_new_driver_actor_32_characters",
  DRIVER_ACCOUNT_ERASURE_ISSUER: "https://issuer.example.invalid/realm",
  AI_ROUTER_ACCOUNT_ERASURE_ISSUER: "https://issuer.example.invalid/realm"
};
test("append only missing reviewed fields and preserve all existing secrets", () => {
  const p = proposedIdentityEnvironment(original, input);
  for (const key of [
    "AI_ROUTER_COP_ACTOR_SECRET",
    "DRIVER_MEASUREMENTS_HASH_SECRET",
    "AI_ROUTER_USER_HASH_SECRET",
    "AI_ROUTER_CREDENTIAL_ENCRYPTION_KEY",
    "UNRELATED_SENTINEL"
  ])
    assert.equal(
      p.text.split("\n").find((x) => x.startsWith(key + "=")),
      original.split("\n").find((x) => x.startsWith(key + "="))
    );
  assert.equal(p.changed.length, 3);
  assert.deepEqual(proposedIdentityEnvironment(p.text, input).changed, []);
});
const issuer = "https://issuer.example.invalid/realm";
const coordinatedSim = original + "SIM_OIDC_ISSUER=" + issuer + "\n";
const coordinatedCop =
  "COP_OIDC_ISSUER=" +
  issuer +
  "\nCOP_SIM_ERASURE_ACTOR_SECRET=\nCOP_ACCOUNT_ERASURE_ENABLED=false\nCOP_AI_CHAT_ROUTER_USER_ID_SECRET=synthetic-original-namespace\n";
test("actual COP single signer field reuses the existing Router actor without rotation", () => {
  const p = coordinatedIdentityProposal(coordinatedSim, coordinatedCop, issuer);
  assert.equal(p.inputValue.DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET, "synthetic-existing-router-actor-32-characters");
  assert.ok(p.copText.includes('COP_SIM_ERASURE_ACTOR_SECRET="synthetic-existing-router-actor-32-characters"'));
  assert.ok(p.copText.includes("COP_ACCOUNT_ERASURE_ENABLED=false\n"));
  assert.ok(p.copText.includes("COP_AI_CHAT_ROUTER_USER_ID_SECRET=synthetic-original-namespace\n"));
  assert.equal(coordinatedIdentityProposal(p.simText, p.copText, issuer).copText, p.copText);
});
test("mismatched COP signer, Driver actor, issuer and duplicate fields refuse", () => {
  for (const cop of [
    coordinatedCop.replace("COP_SIM_ERASURE_ACTOR_SECRET=", "COP_SIM_ERASURE_ACTOR_SECRET=synthetic-other-actor-32-characters"),
    coordinatedCop.replace(issuer, "https://other.example.invalid/realm"),
    coordinatedCop + "COP_SIM_ERASURE_ACTOR_SECRET=duplicate\n"
  ])
    assert.throws(() => coordinatedIdentityProposal(coordinatedSim, cop, issuer));
  assert.throws(() =>
    coordinatedIdentityProposal(coordinatedSim + "DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET=synthetic-other-driver-32-characters\n", coordinatedCop, issuer)
  );
});
test("two private fixture files synchronize in memory, retry preserves bytes, no third secret file", () => {
  const root = mkdtempSync("/private/tmp/sim-erasure-identity-");
  try {
    writeFileSync(root + "/production.env", coordinatedSim, { mode: 0o600 });
    writeFileSync(root + "/cop.env", coordinatedCop, { mode: 0o600 });
    assert.equal(stageCoordinatedIdentity({ mode: "check", expectedIssuer: issuer, syntheticRoot: root }).thirdSecretFileCreated, false);
    assert.equal(readFileSync(root + "/production.env", "utf8"), coordinatedSim);
    const first = stageCoordinatedIdentity({ mode: "apply", expectedIssuer: issuer, syntheticRoot: root });
    assert.equal(first.simChanged, true);
    assert.equal(first.copChanged, true);
    const sim = readFileSync(root + "/production.env", "utf8"),
      cop = readFileSync(root + "/cop.env", "utf8");
    const retry = stageCoordinatedIdentity({ mode: "apply", expectedIssuer: issuer, syntheticRoot: root });
    assert.equal(retry.simChanged, false);
    assert.equal(retry.copChanged, false);
    assert.equal(readFileSync(root + "/production.env", "utf8"), sim);
    assert.equal(readFileSync(root + "/cop.env", "utf8"), cop);
    assert.ok(!JSON.stringify(retry).includes("synthetic-existing-router-actor"));
    // Simulate a crash after the first atomic file write, before COP write.
    writeFileSync(root + "/cop.env", coordinatedCop, { mode: 0o600 });
    const partial = stageCoordinatedIdentity({ mode: "apply", expectedIssuer: issuer, syntheticRoot: root });
    assert.equal(partial.simChanged, false);
    assert.equal(partial.copChanged, true);
    assert.equal(readFileSync(root + "/cop.env", "utf8"), cop);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("Router actor secret and unknown credentials are forbidden input even if equal", () => {
  for (const key of ["AI_ROUTER_COP_ACTOR_SECRET", "AI_ROUTER_USER_HASH_SECRET", "OPENAI_API_KEY"])
    assert.throws(() => proposedIdentityEnvironment(original, { ...input, [key]: "synthetic" }));
});
test("existing Driver actor and either issuer cannot be rotated", () => {
  const p = proposedIdentityEnvironment(original, input);
  for (const key of Object.keys(input))
    assert.throws(() =>
      proposedIdentityEnvironment(p.text, {
        ...input,
        [key]: key.includes("ISSUER") ? "https://other.example.invalid/realm" : "another_synthetic_actor_32_characters"
      })
    );
});
test("duplicate existing identity declarations require explicit review", () => {
  assert.throws(() => proposedIdentityEnvironment(original + "AI_ROUTER_COP_ACTOR_SECRET=duplicate\n", input));
});
test("mismatched issuer and interpolation-bearing actor refuse before writes", () => {
  assert.throws(() => proposedIdentityEnvironment(original, { ...input, AI_ROUTER_ACCOUNT_ERASURE_ISSUER: "https://other.example.invalid/realm" }));
  assert.throws(() => proposedIdentityEnvironment(original, { ...input, DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET: "${SYNTHETIC_UNSAFE_INTERPOLATION}".repeat(2) }));
});
test("actual private fixture check is read-only and apply is byte-idempotent", () => {
  const root = mkdtempSync("/private/tmp/sim-erasure-identity-");
  try {
    const env = root + "/production.env",
      path = root + "/input.json";
    writeFileSync(env, original, { mode: 0o600 });
    writeFileSync(path, JSON.stringify(input), { mode: 0o600 });
    const checked = stageIdentity({ mode: "check", inputPath: path, syntheticRoot: root });
    assert.equal(readFileSync(env, "utf8"), original);
    assert.equal(checked.productionChanged, false);
    stageIdentity({ mode: "apply", inputPath: path, syntheticRoot: root });
    const first = readFileSync(env, "utf8");
    const second = stageIdentity({ mode: "apply", inputPath: path, syntheticRoot: root });
    assert.equal(readFileSync(env, "utf8"), first);
    assert.deepEqual(second.changedFields, []);
    assert.ok(!JSON.stringify(second).includes(input.DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET));
    chmodSync(path, 0o644);
    assert.throws(() => stageIdentity({ mode: "apply", inputPath: path, syntheticRoot: root }));
    assert.equal(readFileSync(env, "utf8"), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
