/** Narrow preparatory env edit for the existing installer. In particular this
 * module cannot replace the Router actor secret, user-hash or encryption keys. */
import { readFileSync, lstatSync, realpathSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, chownSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
const FIELDS = ["DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET", "DRIVER_ACCOUNT_ERASURE_ISSUER", "AI_ROUTER_ACCOUNT_ERASURE_ISSUER"];
const PRESERVE = ["AI_ROUTER_COP_ACTOR_SECRET", "DRIVER_MEASUREMENTS_HASH_SECRET", "AI_ROUTER_USER_HASH_SECRET", "AI_ROUTER_CREDENTIAL_ENCRYPTION_KEY"];
const need = (value, code) => {
  if (!value) throw Error(code);
};
function selected(text, key) {
  const lines = text.split(/\r?\n/).filter((x) => x.startsWith(key + "="));
  need(lines.length <= 1, "DUPLICATE_IDENTITY_ENV_REQUIRES_REVIEW");
  if (!lines.length) return "";
  let value = lines[0].slice(key.length + 1).trim();
  if (value.startsWith('"')) {
    try {
      value = JSON.parse(value);
    } catch {
      throw Error("INVALID_IDENTITY_ENV_QUOTING");
    }
  } else if (value.startsWith("'")) {
    need(value.endsWith("'"), "INVALID_IDENTITY_ENV_QUOTING");
    value = value.slice(1, -1);
  }
  return value;
}
function issuer(value) {
  try {
    const u = new URL(value);
    return typeof value === "string" && value.length <= 512 && u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}
export function proposedIdentityEnvironment(original, input) {
  need(
    input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 3 && FIELDS.every((k) => Object.hasOwn(input, k)),
    "ONLY_THREE_REVIEWED_IDENTITY_FIELDS_ALLOWED"
  );
  need(
    /^[A-Za-z0-9_-]{32,256}$/.test(input.DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET) &&
      issuer(input.DRIVER_ACCOUNT_ERASURE_ISSUER) &&
      input.DRIVER_ACCOUNT_ERASURE_ISSUER === input.AI_ROUTER_ACCOUNT_ERASURE_ISSUER,
    "REVIEWED_MATCHING_IDENTITY_CONFIGURATION_REQUIRED"
  );
  need(
    selected(original, "AI_ROUTER_COP_ACTOR_SECRET").length >= 32 &&
      selected(original, "DRIVER_MEASUREMENTS_HASH_SECRET").length >= 32 &&
      selected(original, "AI_ROUTER_USER_HASH_SECRET").length >= 24,
    "EXISTING_IDENTITY_SECRETS_REQUIRED"
  );
  const preserved = Object.fromEntries(PRESERVE.map((k) => [k, selected(original, k)]));
  const changed = [];
  for (const key of FIELDS) {
    const existing = selected(original, key);
    need(!existing || existing === input[key], "EXISTING_IDENTITY_CONFIGURATION_MUST_NOT_ROTATE");
    if (!existing) changed.push(key);
  }
  if (!changed.length) return { text: original, changed, routerActorPreserved: true, namespaceAndEncryptionKeysPreserved: true };
  const lines = original.split(/\r?\n/).filter((line) => !changed.some((key) => line.startsWith(key + "=")));
  const text = lines.join("\n").replace(/\n*$/, "\n") + changed.map((key) => key + "=" + JSON.stringify(input[key])).join("\n") + "\n";
  for (const key of PRESERVE) need(selected(text, key) === preserved[key], "PRESERVED_IDENTITY_CHANGED");
  return { text, changed, routerActorPreserved: true, namespaceAndEncryptionKeysPreserved: true };
}
export function stageIdentity({ mode, inputPath, inputValue, syntheticRoot } = {}) {
  const synthetic = typeof syntheticRoot === "string";
  if (synthetic)
    need(realpathSync(syntheticRoot) === syntheticRoot && syntheticRoot.startsWith("/private/tmp/sim-erasure-identity-"), "OWNED_IDENTITY_FIXTURE_REQUIRED");
  const envPath = synthetic ? syntheticRoot + "/production.env" : "/srv/sim/.env";
  const envStat = lstatSync(envPath);
  need(envStat.isFile() && !envStat.isSymbolicLink() && envStat.nlink === 1 && (envStat.mode & 0o777) === 0o600, "PRIVATE_SIM_ENV_REQUIRED");
  need((inputPath !== undefined) !== (inputValue !== undefined), "ONE_IDENTITY_INPUT_REQUIRED");
  if (inputPath !== undefined) {
    const inputStat = lstatSync(inputPath);
    need(
      inputStat.isFile() &&
        !inputStat.isSymbolicLink() &&
        inputStat.nlink === 1 &&
        (inputStat.mode & 0o777) === 0o600 &&
        inputStat.uid === (synthetic ? process.getuid() : 0),
      "ROOT_PRIVATE_IDENTITY_INPUT_REQUIRED"
    );
  }
  const original = readFileSync(envPath, "utf8"),
    result = proposedIdentityEnvironment(original, inputValue ?? JSON.parse(readFileSync(inputPath, "utf8")));
  need(["check", "apply"].includes(mode), "IDENTITY_STAGE_CHECK_OR_APPLY_REQUIRED");
  if (mode === "apply" && result.changed.length) {
    need(readFileSync(envPath, "utf8") === original, "IDENTITY_ENV_CHANGED_DURING_REVIEW");
    const temporary = envPath + ".identity-stage-" + process.pid;
    let fd;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, result.text);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      if (process.getuid() === 0) chownSync(temporary, envStat.uid, envStat.gid);
      renameSync(temporary, envPath);
      const parent = openSync(dirname(envPath), "r");
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch {}
    }
  }
  return {
    mode,
    changedFields: result.changed,
    routerActorPreserved: true,
    namespaceAndEncryptionKeysPreserved: true,
    databaseContacted: false,
    servicesChanged: false,
    productionChanged: mode === "apply" && result.changed.length > 0 && !synthetic
  };
}

/** COP's server.ts uses this ONE field for both SIM adapters. Therefore the
 * already deployed Router actor is the only admissible shared actor: no new
 * random Driver actor and no rotation of the Router or identity namespaces. */
export function coordinatedIdentityProposal(sim, cop, expectedIssuer) {
  need(
    ["", "false", "0"].includes(selected(cop, "COP_ACCOUNT_ERASURE_ENABLED")) &&
      ["DRIVER_ACCOUNT_ERASURE_ENABLED", "AI_ROUTER_ACCOUNT_ERASURE_ENABLED"].every((key) => ["", "false", "0"].includes(selected(sim, key))),
    "DISABLED_ACCOUNT_ERASURE_REQUIRED"
  );
  need(selected(sim, "SIM_OIDC_ISSUER") === expectedIssuer && selected(cop, "COP_OIDC_ISSUER") === expectedIssuer, "COP_SIM_ISSUER_REVIEW_REQUIRED");
  const actor = selected(sim, "AI_ROUTER_COP_ACTOR_SECRET");
  need(/^[A-Za-z0-9_-]{32,256}$/.test(actor), "EXISTING_ROUTER_ACTOR_REQUIRED");
  const existing = selected(cop, "COP_SIM_ERASURE_ACTOR_SECRET");
  need(!existing || existing === actor, "EXISTING_COP_SIGNER_MUST_NOT_ROTATE");
  const proposal = proposedIdentityEnvironment(sim, {
    DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET: actor,
    DRIVER_ACCOUNT_ERASURE_ISSUER: expectedIssuer,
    AI_ROUTER_ACCOUNT_ERASURE_ISSUER: expectedIssuer
  });
  const copText = existing
    ? cop
    : cop
        .split(/\r?\n/)
        .filter((line) => !line.startsWith("COP_SIM_ERASURE_ACTOR_SECRET="))
        .join("\n")
        .replace(/\n*$/, "\n") +
      "COP_SIM_ERASURE_ACTOR_SECRET=" +
      JSON.stringify(actor) +
      "\n";
  return {
    simText: proposal.text,
    copText,
    inputValue: {
      DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET: actor,
      DRIVER_ACCOUNT_ERASURE_ISSUER: expectedIssuer,
      AI_ROUTER_ACCOUNT_ERASURE_ISSUER: expectedIssuer
    }
  };
}

export function stageCoordinatedIdentity({ mode, expectedIssuer, syntheticRoot } = {}) {
  const synthetic = typeof syntheticRoot === "string";
  if (synthetic)
    need(realpathSync(syntheticRoot) === syntheticRoot && syntheticRoot.startsWith("/private/tmp/sim-erasure-identity-"), "OWNED_IDENTITY_FIXTURE_REQUIRED");
  else need(process.getuid() === 0 && hostname() === "docker", "ROOT_DOCKER_HOST_REQUIRED");
  need(["check", "apply"].includes(mode), "IDENTITY_STAGE_CHECK_OR_APPLY_REQUIRED");
  const simPath = synthetic ? syntheticRoot + "/production.env" : "/srv/sim/.env";
  const copPath = synthetic ? syntheticRoot + "/cop.env" : "/srv/cop/.env";
  const stats = [simPath, copPath].map((path) => {
    const s = lstatSync(path);
    need(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && (s.mode & 0o777) === 0o600, "PRIVATE_PRODUCTION_SECRETS_REQUIRED");
    return s;
  });
  const sim = readFileSync(simPath, "utf8"),
    cop = readFileSync(copPath, "utf8");
  const p = coordinatedIdentityProposal(sim, cop, expectedIssuer);
  if (mode === "apply") {
    need(readFileSync(simPath, "utf8") === sim && readFileSync(copPath, "utf8") === cop, "PRODUCTION_SECRETS_CHANGED_DURING_REVIEW");
    stageIdentity({ mode, inputValue: p.inputValue, syntheticRoot });
    if (p.copText !== cop) {
      // A crash between these two atomic writes is safe to retry: both derive
      // the same existing Router actor, never a newly generated credential.
      need(readFileSync(copPath, "utf8") === cop, "COP_SECRETS_CHANGED_DURING_REVIEW");
      const temp = copPath + ".sim-identity-" + process.pid;
      let fd;
      try {
        fd = openSync(temp, "wx", 0o600);
        writeFileSync(fd, p.copText);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        if (process.getuid() === 0) chownSync(temp, stats[1].uid, stats[1].gid);
        renameSync(temp, copPath);
        const parent = openSync(dirname(copPath), "r");
        try {
          fsyncSync(parent);
        } finally {
          closeSync(parent);
        }
      } finally {
        if (fd !== undefined) closeSync(fd);
        try {
          unlinkSync(temp);
        } catch {}
      }
    }
  }
  return {
    mode,
    simChanged: p.simText !== sim,
    copChanged: p.copText !== cop,
    routerActorPreserved: true,
    namespaceAndEncryptionKeysPreserved: true,
    thirdSecretFileCreated: false,
    servicesChanged: false,
    databaseContacted: false
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    need(process.getuid() === 0 && hostname() === "docker", "ROOT_DOCKER_HOST_REQUIRED");
    const args = process.argv.slice(2);
    need(args.length === 3 && ["--check", "--apply"].includes(args[0]) && args[1] === "--input", "IDENTITY_STAGE_USAGE_REQUIRED");
    console.log(JSON.stringify(stageIdentity({ mode: args[0].slice(2), inputPath: args[2] }), null, 2));
  } catch (e) {
    console.error(/^[A-Z0-9_]+$/.test(e.message) ? e.message : "SIM_IDENTITY_STAGE_FAILED");
    process.exitCode = 2;
  }
}
