/** Public SOURCE, not a public API. GET-only whole12 harness adapter.
 * seed() captures already-seeded actual A/B data; it never creates or deletes.
 * It cannot produce actual Root/whole-account acceptance from component counts. */
import { createHash, createHmac } from "node:crypto";
import { readPrivateCompanionInput } from "./clean-whole12-sim-companion.mjs";
import { validateCleanWholeInput, FIXTURE_ISSUER } from "./clean-whole-sim-v1.mjs";
import { runtimeIdentityFingerprint } from "../../packages/sim-user-data/bootstrap.mjs";
const OWNER_KEYS = ["sim_measurements", "ai_router", "sim_user_data"];
const STATES = new Set(["active", "deletion_pending", "deleted", "unused"]);
const sha = (x) =>
  createHash("sha256")
    .update(typeof x === "string" ? x : JSON.stringify(x))
    .digest("hex");
const need = (v, code = "SIM_WHOLE12_READBACK_INVALID") => {
  if (!v) throw Error(code);
};
const keys = (v, wanted) =>
  v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === wanted.length && wanted.every((k) => Object.hasOwn(v, k));
const fingerprint = (x) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const count = (x) => Number.isSafeInteger(x) && x >= 0;
function total(counts) {
  need(Object.values(counts).every(count));
  const n = Object.values(counts).reduce((a, b) => a + b, 0);
  need(count(n));
  return n;
}
function component(raw, owner, lane, epoch) {
  need(
    raw &&
      !Object.hasOwn(raw, "simPreserved") &&
      raw.resetEpoch === epoch &&
      raw.scope === "cop_sim_shared_identity_v1" &&
      raw.component === lane &&
      raw.wholeAccountComplete === false &&
      raw.productionChanged === false
  );
  need(
    (raw.contractVersion === "cop-clean-whole-readback-v1" && raw.mode === "isolated-clean-lifecycle-v1") ||
      (raw.contractVersion === "cop-clean-whole-tls-component-readback-v1" && raw.mode === "production-clean-lifecycle-v1")
  );
  need(keys(raw.owners, [owner]) && raw.externalProviderAttempts === 0);
  if (lane === "driver") need(raw.applicationMode === "shadow_only");
  const x = raw.owners[owner],
    names = lane === "driver" ? ["receipts", "intervals", "eta", "revocations"] : ["keys", "audit", "requests", "billing"];
  need(keys(x.countsA, names) && keys(x.countsB, names) && STATES.has(x.stateA) && STATES.has(x.stateB) && fingerprint(x.preservedBFingerprint));
  need(x.removableA === total(x.countsA) && x.removableB === total(x.countsB));
  return {
    removableA: x.removableA,
    removableB: x.removableB,
    stateA: x.stateA,
    stateB: x.stateB,
    countsA: { ...x.countsA },
    countsB: { ...x.countsB },
    preservedBFingerprint: x.preservedBFingerprint
  };
}
/** Pure normalization seam for synthetic contract tests, not Root evidence. */
export function normalizeWhole12SimReadbacks({ driver, ai, all }, epoch) {
  need(
    all &&
      !Object.hasOwn(all, "simPreserved") &&
      all.sameCompiledProductionBootstrap === true &&
      all.actualRootAdmission === false &&
      all.wholeAccountComplete === false &&
      all.externalProviderAttempts === 0
  );
  const measurements = component(driver, "sim_measurements", "driver", epoch),
    router = component(ai, "ai_router", "ai", epoch);
  need(
    JSON.stringify(measurements) === JSON.stringify(component(all.driver, "sim_measurements", "driver", epoch)) &&
      JSON.stringify(router) === JSON.stringify(component(all.ai, "ai_router", "ai", epoch)),
    "SIM_WHOLE12_READBACK_UNSTABLE"
  );
  need(keys(all.appOwners, ["a", "b"]) && keys(all.simHistory, ["a", "b"]));
  const user = {};
  for (const name of ["a", "b"]) {
    const app = all.appOwners[name],
      history = all.simHistory[name];
    need(keys(app, ["state", "fileCount", "fingerprint"]) && STATES.has(app.state) && count(app.fileCount) && fingerprint(app.fingerprint));
    need(
      keys(history, ["requests", "billing", "state", "fingerprint"]) &&
        STATES.has(history.state) &&
        count(history.requests) &&
        count(history.billing) &&
        fingerprint(history.fingerprint)
    );
    const counts = { appFiles: app.fileCount, simHistoryRequests: history.requests, simHistoryBilling: history.billing };
    user[name] = {
      counts,
      remaining: total(counts),
      state:
        app.state === "deleted" && history.state === "deleted"
          ? "deleted"
          : app.state === "active" && history.state === "active"
            ? "active"
            : "deletion_pending",
      subcomponents: { app_store_and_audit: app.state, router_sim_history: history.state },
      fingerprint: sha({ appFiles: app.fingerprint, simHistory: history.fingerprint })
    };
  }
  const data = {
    removableA: user.a.remaining,
    removableB: user.b.remaining,
    stateA: user.a.state,
    stateB: user.b.state,
    countsA: user.a.counts,
    countsB: user.b.counts,
    preservedBFingerprint: user.b.fingerprint,
    subcomponentsA: user.a.subcomponents,
    subcomponentsB: user.b.subcomponents
  };
  return {
    contractVersion: "cop-sim-whole12-sim-readback-v1",
    scope: "cop_sim_shared_identity_v1",
    resetEpoch: epoch,
    owners: { sim_measurements: measurements, ai_router: router, sim_user_data: data },
    evidenceBoundary: {
      legacyComponentLabels: driver.contractVersion === "cop-clean-whole-readback-v1" || ai.contractVersion === "cop-clean-whole-readback-v1",
      rootAdmissionVerified: false,
      productionHaProxyVerified: false,
      wireDeletionIdentityVerified: false
    },
    wholeAccountComplete: false
  };
}
function validatePrivate(p) {
  try {
    need(p.input.contractVersion === "cop-sim-clean-whole-fixture-v2");
    validateCleanWholeInput(p.input.base);
    const b = p.input.base,
      u = p.input.userDataEnvironment;
    need(b.issuer === FIXTURE_ISSUER);
    const identity = {
      sim_user_data: { ownerSecret: u.ownerSecret, actorSecret: u.copActorSecret, routerActorSecret: u.routerActorSecret, issuer: b.issuer },
      sim_user_history: { hashSecret: b.environment.routerHashSecret, actorSecret: u.routerActorSecret, issuer: b.issuer }
    };
    for (const [name, value] of Object.entries(identity)) {
      const x = p.bindings[name];
      need(
        x.reset_epoch === b.resetEpoch &&
          x.environment_id === b.environmentId &&
          x.identity_sha256 === runtimeIdentityFingerprint(name, value) &&
          fingerprint(x.source_sha256)
      );
    }
    need(
      p.bindings.sim_user_data.guard_store_id === p.bindings.sim_user_history.guard_store_id &&
        p.bindings.sim_user_data.source_sha256 === p.bindings.sim_user_history.source_sha256
    );
    for (const a of Object.values(b.actors))
      need(
        a.routerUserId === "cop_" + createHmac("sha256", b.environment.routerHashSecret).update("cop-router-chat-v1\0").update(a.subjectId).digest("base64url")
      );
    need(p.endpoints.main === "http://127.0.0.1:4314" && p.endpoints.ai === "http://127.0.0.1:4312" && p.endpoints.driver === "http://127.0.0.1:4311");
    return b.resetEpoch;
  } catch {
    throw Error("SIM_WHOLE12_PRIVATE_BINDING_INVALID");
  }
}
async function get(port, token) {
  const r = await fetch(`http://127.0.0.1:${port}/readback`, {
    method: "GET",
    headers: { authorization: "Bearer " + token },
    redirect: "error",
    signal: AbortSignal.timeout(7000)
  });
  need(r.status === 200 && r.headers.get("cache-control") === "no-store" && r.body, "SIM_WHOLE12_SOURCE_UNAVAILABLE");
  let size = 0;
  const parts = [];
  for await (const part of r.body) {
    size += part.length;
    need(size <= 131072, "SIM_WHOLE12_RESPONSE_LIMIT");
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw Error("SIM_WHOLE12_RESPONSE_INVALID");
  }
}
export async function createWhole12SimReadbackAdapter(privateFile = "/dev/shm/cop-clean-whole/sim-private.json") {
  const privateConfig = await readPrivateCompanionInput(privateFile),
    epoch = validatePrivate(privateConfig),
    privateDigest = sha(privateConfig);
  const bindingDigest = sha({
    epoch,
    bindings: privateConfig.bindings,
    actors: Object.fromEntries(
      Object.entries(privateConfig.input.base.actors).map(([k, a]) => [k, sha({ issuer: privateConfig.input.base.issuer, subject: a.subjectId })])
    )
  });
  async function readback() {
    need(sha(await readPrivateCompanionInput(privateFile)) === privateDigest, "SIM_WHOLE12_PRIVATE_CHANGED");
    const [driver, ai, all] = await Promise.all([4321, 4322, 4324].map((port) => get(port, privateConfig.input.base.environment.copServiceToken)));
    const value = normalizeWhole12SimReadbacks({ driver, ai, all }, epoch);
    need(sha(await readPrivateCompanionInput(privateFile)) === privateDigest, "SIM_WHOLE12_PRIVATE_CHANGED");
    return { ...value, bindingDigest };
  }
  return {
    readback,
    async seed() {
      const value = await readback();
      need(
        OWNER_KEYS.every(
          (k) => value.owners[k].removableA > 0 && value.owners[k].removableB > 0 && value.owners[k].stateA === "active" && value.owners[k].stateB === "active"
        ),
        "SIM_WHOLE12_BASELINE_NOT_SEEDED"
      );
      const data = value.owners.sim_user_data;
      need(
        [data.countsA, data.countsB].every((x) => x.appFiles === 4 && x.simHistoryRequests + x.simHistoryBilling > 0),
        "SIM_WHOLE12_USER_DATA_BASELINE_INCOMPLETE"
      );
      return { ...value, contractVersion: "cop-sim-whole12-sim-baseline-v1", seedWritesPerformed: false };
    },
    async check(baseline) {
      need(
        baseline?.contractVersion === "cop-sim-whole12-sim-baseline-v1" &&
          baseline.resetEpoch === epoch &&
          baseline.bindingDigest === bindingDigest &&
          keys(baseline.owners, OWNER_KEYS) &&
          baseline.wholeAccountComplete === false &&
          !Object.hasOwn(baseline, "simPreserved"),
        "SIM_WHOLE12_BASELINE_INVALID"
      );
      const current = await readback(),
        checks = {};
      for (const owner of OWNER_KEYS) {
        const before = baseline.owners[owner],
          after = current.owners[owner];
        checks[owner] = {
          aDeleted: after.removableA === 0 && after.stateA === "deleted",
          bPreserved:
            after.removableB === before.removableB &&
            after.stateB === before.stateB &&
            JSON.stringify(after.countsB) === JSON.stringify(before.countsB) &&
            after.preservedBFingerprint === before.preservedBFingerprint
        };
      }
      const bPreserved = Object.values(checks).every((x) => x.bPreserved),
        aDeleted = Object.values(checks).every((x) => x.aDeleted);
      return { ...current, checks, aDeleted, bPreserved, status: !bPreserved ? "failed" : aDeleted ? "completed" : "pending", wholeAccountComplete: false };
    }
  };
}
