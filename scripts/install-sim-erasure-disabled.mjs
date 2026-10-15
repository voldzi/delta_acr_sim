/** Fixed disabled-only SIM install, composing the already tested provisioner
 * and explicit Docker steps. No global framework, no whole-account activation. */
import { readFileSync, lstatSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { provision } from "./provision-sim-erasure-production.mjs";
import { stageCoordinatedIdentity } from "./stage-sim-erasure-identity.mjs";
import { SOURCE_REVISION, EXPECTED_CLEANUP_HASH, verifyInventorySource } from "./inspect-sim-root-inventory.mjs";
import { reportInventory } from "./driver-report-inventory.mjs";
const need = (v, c) => {
  if (!v) throw Error(c);
};
const sha = (v) => createHash("sha256").update(v).digest("hex");
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  directory = "/srv/sim/.sim-erasure-cutover";
const stateFile = directory + "/state.json",
  planFile = directory + "/runtime-plan.json",
  enrollmentFile = directory + "/enrollment.json",
  receiptFile = directory + "/post-stop-inventory.json";
const ISSUER = "https://login.zeleznalady.cz/realms/cop",
  CA = "/etc/vcode-cop-pgbouncer/postgres-ca.crt";
const IMAGES = {
  "situation-data-api": "sha256:ff8e60608936d4c97cba01e8d96ad064ce3950c6e2a9a115df88dd75fb8fb23d",
  "ai-router-api": "sha256:d4176d79106315d8fe8df1649c7755d1bc2b5189f390fca796a4dbd23778cd2e"
};
function selected(text, key) {
  const lines = text.split(/\r?\n/).filter((x) => x.startsWith(key + "="));
  need(lines.length <= 1, "DUPLICATE_SIM_CONFIGURATION");
  if (!lines.length) return "";
  let v = lines[0].slice(key.length + 1).trim();
  if (v.startsWith('"')) v = JSON.parse(v);
  else if (v.startsWith("'")) {
    need(v.endsWith("'"), "INVALID_SIM_ENV");
    v = v.slice(1, -1);
  }
  return v;
}
export function verifyPreservedIdentity(envText, driverEnv, routerEnv) {
  const list = {
    ...Object.fromEntries(["DRIVER_MEASUREMENTS_HASH_SECRET"].map((k) => [k, driverEnv[k]])),
    ...Object.fromEntries(["AI_ROUTER_COP_ACTOR_SECRET", "AI_ROUTER_USER_HASH_SECRET", "AI_ROUTER_CREDENTIAL_ENCRYPTION_KEY"].map((k) => [k, routerEnv[k]]))
  };
  for (const [key, value] of Object.entries(list)) {
    const actual = value ?? "";
    need(
      typeof actual === "string" && (key === "AI_ROUTER_CREDENTIAL_ENCRYPTION_KEY" || actual.length > 0) && selected(envText, key) === actual,
      "RUNNING_IDENTITY_DIFFERS_FROM_SIM_SECRETS"
    );
  }
  need(selected(envText, "SIM_OIDC_ISSUER") === ISSUER, "ACTUAL_SIM_ISSUER_REVIEW_REQUIRED");
  return { routerActorPreserved: true, namespaceAndEncryptionKeysPreserved: true, issuer: ISSUER };
}
export function verifyEnrolledIdentity(checked, enrollment, stage) {
  need(
    stage.simChanged === false &&
      stage.copChanged === false &&
      checked.configurationFingerprint === enrollment.configurationFingerprint &&
      checked.identityFingerprints?.driver === enrollment.driverIdentityFingerprint &&
      checked.identityFingerprints?.router === enrollment.routerIdentityFingerprint,
    "ENROLLED_IDENTITY_CHANGED_BEFORE_RETRY"
  );
}
export function bindPostStopEnrollment(enrollment, original, post) {
  need(
    original.sourceRevision === SOURCE_REVISION &&
      original.readOnly === true &&
      original.productionEnrollmentAccepted === false &&
      original.reportInventory?.inventoryDigest === "12e5f824e2aa9f8f740cc4fded7589743902243c0ba641c943b14ab4054ec705" &&
      original.legacyCleanupCron?.expectedSha256 === EXPECTED_CLEANUP_HASH,
    "ORIGINAL_HUMAN_ROOT_INVENTORY_REQUIRED"
  );
  need(
    post.sourceRevision === SOURCE_REVISION &&
      post.originalInventoryDigest === original.reportInventory.inventoryDigest &&
      post.requiresEnrollmentReview === true &&
      post.otherProducerSourcesUnchanged === true &&
      post.retiredCronSha256 === EXPECTED_CLEANUP_HASH &&
      /^[a-f0-9]{64}$/.test(post.reportInventory?.inventoryDigest) &&
      post.reportInventory.fileCount === 0 &&
      post.reportInventory.bytes === 0 &&
      post.reportInventory.lockPresent === false &&
      post.reportInventory.activeProducerCount === 0 &&
      post.reportInventory.producerMatches.length === 0,
    "ACTUAL_CLEAR_POSTSTOP_INVENTORY_REQUIRED"
  );
  need(enrollment.identityReviewed === true && /^[a-f0-9]{64}$/.test(enrollment.identityReviewEvidenceDigest), "EXPLICIT_IDENTITY_ENROLLMENT_REQUIRED");
  return {
    ...enrollment,
    reportPublication: { policy: "shared_generation_fence-v1", externalProducersReviewed: true, inventoryDigest: post.reportInventory.inventoryDigest }
  };
}
function readPrivate(path) {
  const s = lstatSync(path);
  need(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === 0 && (s.mode & 0o777) === 0o600, "PRIVATE_ROOT_INSTALL_STATE_REQUIRED");
  return JSON.parse(readFileSync(path, "utf8"));
}
function save(path, value) {
  const temporary = path + ".next-" + process.pid;
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {}
  }
}
function inspectEnv(name) {
  const x = JSON.parse(execFileSync("/usr/bin/docker", ["inspect", name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
  return Object.fromEntries(
    x.Config.Env.map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    })
  );
}
function runtime(args) {
  try {
    return JSON.parse(
      execFileSync("/usr/bin/node", [root + "/scripts/sim-erasure-runtime-step.mjs", ...args], {
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 180000,
        maxBuffer: 4 * 1024 * 1024
      })
    );
  } catch (e) {
    let code;
    try {
      code = JSON.parse(String(e.stderr)).code;
    } catch {}
    throw Error(/^[A-Z0-9_]+$/.test(code) ? code : "SIM_RUNTIME_CUTOVER_FAILED");
  }
}
function ensureDirectory(path) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const s = lstatSync(path);
  need(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && (s.mode & 0o777) === 0o700, "PRIVATE_ROOT_INSTALL_DIRECTORY_REQUIRED");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let phase = "preflight";
  try {
    const mode = process.argv[2];
    need(
      process.argv.length === 3 && ["--apply", "--verify", "--rollback-disabled"].includes(mode) && process.getuid() === 0 && hostname() === "docker",
      "EXACT_ROOT_DISABLED_INSTALL_REQUIRED"
    );
    verifyInventorySource(root);
    need(
      sha(readFileSync(root + "/scripts/provision-sim-erasure-production.mjs")) === "6f7a27942469ce98feda3c50959b4d1bc07cc7ca3c711a8990eee0a69e0efc05",
      "APPROVED_PROVISIONER_BYTES_REQUIRED"
    );
    ensureDirectory(directory);
    let state;
    try {
      state = readPrivate(stateFile);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (mode !== "--apply") {
      need(state?.provisioned === true, "PROVISIONED_COMPATIBLE_RUNTIME_REQUIRED");
      console.log(JSON.stringify(runtime([mode === "--verify" ? "--verify" : "--rollback-disabled", "--plan-file", planFile]), null, 2));
    } else {
      need(process.env.PGPASSWORD, "HIDDEN_POSTGRES_PASSWORD_REQUIRED");
      process.env.SIM_ERASURE_PG_ROOT_CERT_FILE = CA;
      need(sha(readFileSync(CA)) === "7a3f9d9373cd63361148230e6c2804c6fb76dc204e18d5039aad7c7838d7a14a", "APPROVED_POSTGRES_CA_REQUIRED");
      const identityStage = stageCoordinatedIdentity({ mode: "check", expectedIssuer: ISSUER });
      if (state?.enrollment) need(identityStage.simChanged === false && identityStage.copChanged === false, "ENROLLED_IDENTITY_CHANGED_BEFORE_RETRY");
      if (state?.complete === true) {
        console.log(JSON.stringify(runtime(["--verify", "--plan-file", planFile]), null, 2));
        process.exit(0);
      }
      // Administrator credentials and schema state are checked BEFORE stopping.
      const checked = provision({ mode: "check", user: process.env.PGUSER ?? "postgres", password: process.env.PGPASSWORD });
      if (state?.enrollment) verifyEnrolledIdentity(checked, state.enrollment, identityStage);
      if (!state) {
        need(!checked.driver.erasure && !checked.driver.binding && !checked.ai.erasure && !checked.ai.binding, "UNADOPTED_EXISTING_SCHEMA_REQUIRES_REVIEW");
        const original = JSON.parse(readFileSync(root + "/deploy/account-safety/20261015-root-inventory.json", "utf8"));
        need(reportInventory().inventoryDigest === original.reportInventory.inventoryDigest, "HUMAN_ROOT_INVENTORY_DRIFT");
        const preserved = verifyPreservedIdentity(
          readFileSync("/srv/sim/.env", "utf8"),
          inspectEnv("csm-sim-situation-data-api"),
          inspectEnv("csm-sim-ai-router-api")
        );
        const plan = runtime(["--plan", "--driver-image", IMAGES["situation-data-api"], "--router-image", IMAGES["ai-router-api"]]);
        save(planFile, plan);
        state = {
          sourceRevision: SOURCE_REVISION,
          originalInventory: original,
          preservedIdentity: preserved,
          phase: "planned",
          provisioned: false,
          complete: false
        };
        save(stateFile, state);
      }
      need(state.sourceRevision === SOURCE_REVISION, "OTHER_INSTALL_STATE_REQUIRES_REVIEW");
      if (!state.enrollment) {
        stageCoordinatedIdentity({ mode: "apply", expectedIssuer: ISSUER });
        const identity = provision({ mode: "check", user: process.env.PGUSER ?? "postgres", password: process.env.PGPASSWORD });
        need(identity.configurationFingerprint && identity.identityFingerprints, "ACTUAL_IDENTITY_FINGERPRINTS_REQUIRED");
        const binding = () => ({ storeId: randomUUID(), incarnationId: randomUUID(), checkpointId: randomUUID(), restoreGeneration: 1 });
        const evidence = {
          sourceRevision: SOURCE_REVISION,
          approvedScope: "disabled_cop_jizda_preserve_shared_identity_sim_izs",
          reviewedByRootUid: process.getuid(),
          issuer: ISSUER,
          preservedIdentity: state.preservedIdentity,
          identityFingerprints: identity.identityFingerprints,
          configurationFingerprint: identity.configurationFingerprint,
          reviewKind: "explicitly-approved administrator configuration enrollment; not COP joint acceptance"
        };
        save(directory + "/identity-configuration-review.json", evidence);
        state.enrollment = {
          contractVersion: "sim-erasure-production-enrollment-v2",
          guardStoreId: randomUUID(),
          configurationFingerprint: identity.configurationFingerprint,
          driverIdentityFingerprint: identity.identityFingerprints.driver,
          routerIdentityFingerprint: identity.identityFingerprints.router,
          identityReviewed: true,
          identityReviewEvidenceDigest: sha(JSON.stringify(evidence)),
          postgresCaSha256: identity.postgresCaSha256,
          retentionPolicy: "driver-7-days-v1",
          costPolicy: "aggregate-costs-current-month-v1",
          driver: binding(),
          router: binding()
        };
        save(stateFile, state);
      }
      if (!state.provisioned) {
        phase = "stop_and_reinventory";
        let input = directory + "/original-inventory.json";
        save(input, state.originalInventory);
        try {
          readPrivate(receiptFile);
          input = receiptFile;
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        state.phase = "stopping";
        save(stateFile, state);
        const post = runtime(["--stop-and-inventory", "--plan-file", planFile, "--inventory-file", input]);
        save(receiptFile, post);
        const enrollment = bindPostStopEnrollment(state.enrollment, state.originalInventory, post);
        save(enrollmentFile, enrollment);
        save(directory + "/inventory-transition.json", {
          sourceRevision: SOURCE_REVISION,
          original: state.originalInventory.reportInventory,
          resulting: post.reportInventory,
          expectedRetiredCronSha256: EXPECTED_CLEANUP_HASH,
          otherProducerSourcesUnchanged: post.otherProducerSourcesUnchanged,
          wholeAccountComplete: false
        });
        phase = "existing_provisioner";
        state.phase = "migrations_attempted";
        save(stateFile, state);
        const installed = provision({
          mode: "apply",
          enrollmentPath: enrollmentFile,
          user: process.env.PGUSER ?? "postgres",
          password: process.env.PGPASSWORD
        });
        need(installed.erasureEnabled === false && installed.driverPublicationVerified === true, "DISABLED_REPORT_BOUND_ENROLLMENT_REQUIRED");
        state.provisioned = true;
        state.phase = "provisioned";
        save(stateFile, state);
      }
      phase = "start_compatible_disabled";
      const result = runtime(["--start-disabled", "--plan-file", planFile]);
      state.complete = true;
      state.phase = "complete_disabled";
      save(stateFile, state);
      console.log(
        JSON.stringify(
          {
            sourceRevision: SOURCE_REVISION,
            phase: state.phase,
            result,
            inventoryTransitionRecorded: true,
            routerActorPreserved: true,
            erasureEnabled: false,
            wholeAccountComplete: false,
            oldImageFallback: false
          },
          null,
          2
        )
      );
    }
  } catch (e) {
    console.error(
      JSON.stringify({
        phase,
        code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : "SIM_DISABLED_INSTALL_FAILED",
        wholeAccountComplete: false,
        oldImageFallback: false
      })
    );
    process.exitCode = 2;
  }
}
