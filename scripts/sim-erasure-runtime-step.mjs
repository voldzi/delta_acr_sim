/** Fixed SIM cutover steps, not a general deployment or authorization service.
 * Provisioning remains in provision-sim-erasure-production.sh. No SQL here. */
import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync, readdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_REVISION, EXPECTED_CLEANUP_HASH, reviewCleanupCron, verifyInventorySource } from "./inspect-sim-root-inventory.mjs";
import { reportInventory } from "./driver-report-inventory.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (v) => createHash("sha256").update(v).digest("hex");
const need = (v, c) => {
  if (!v) throw Error(c);
};
const ENV = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
export const SERVICES = {
  "situation-data-api": {
    container: "csm-sim-situation-data-api",
    port: 4020,
    token: "DRIVER_MEASUREMENTS_COP_TOKEN",
    flag: "DRIVER_ACCOUNT_ERASURE_ENABLED",
    capability: "/api/v1/internal/driver-measurements/v1/account-erasure-operations/capability"
  },
  "ai-router-api": {
    container: "csm-sim-ai-router-api",
    port: 4050,
    token: "AI_ROUTER_COP_TOKEN",
    flag: "AI_ROUTER_ACCOUNT_ERASURE_ENABLED",
    capability: "/api/v1/ai-router/cop/users/me/erasure-operations/capability"
  }
};
const BASE_ENV = new Set(["PATH", "NODE_VERSION", "YARN_VERSION", "PNPM_HOME", "COREPACK_HOME", "HOME"]);
const erasureKey = (k) =>
  /^(SIM_ACCOUNT_ERASURE_|DRIVER_ACCOUNT_ERASURE_|AI_ROUTER_ACCOUNT_ERASURE_)/.test(k) || ["DRIVER_MEASUREMENT_REPORTS_DIR"].includes(k);
export function nonErasureEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([k]) => !erasureKey(k) && !BASE_ENV.has(k))
      .map(([k, v]) => {
        if (["DRIVER_MEASUREMENTS_DATABASE_URL", "AI_ROUTER_DATABASE_URL"].includes(k)) {
          const u = new URL(v);
          u.searchParams.delete("sslmode");
          u.searchParams.delete("sslrootcert");
          v = u.toString();
        }
        return [k, String(v)];
      })
      .sort(([a], [b]) => a.localeCompare(b))
  );
}
export function retireExactCleanup(text, expected = EXPECTED_CLEANUP_HASH) {
  reviewCleanupCron(text, expected);
  const lines = text.split("\n");
  let changed = false;
  const next = lines
    .filter((line) => {
      if (line.trim() && !line.trim().startsWith("#") && sha(line) === expected) {
        changed = true;
        return false;
      }
      return true;
    })
    .join("\n");
  return { text: changed && next && !next.endsWith("\n") ? next + "\n" : next, changed };
}
export function verifyStopResume(intent, plan, receipt, currentCron, sources) {
  need(
    intent.sourceRevision === SOURCE_REVISION &&
      intent.planDigest === sha(JSON.stringify(plan)) &&
      [intent.originalInventoryDigest, intent.postInventoryDigest].includes(receipt.reportInventory?.inventoryDigest) &&
      [intent.beforeCronDigest, intent.afterCronDigest].includes(sha(currentCron)),
    "EXACT_STOP_TRANSITION_REQUIRED"
  );
  verifyOnlyOwnedCronChanged(intent.beforeSources, sources);
  need(intent.fileCount === receipt.reportInventory.fileCount && intent.bytes === receipt.reportInventory.bytes, "STOP_TRANSITION_REPORT_DRIFT");
}
export function producerSourceDigests() {
  const result = {};
  const scan = (path, depth = 0) => {
    need(depth <= 8 && Object.keys(result).length <= 10000, "PRODUCER_SNAPSHOT_LIMIT");
    let s;
    try {
      s = lstatSync(path);
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    if (s.isSymbolicLink()) return;
    if (s.isDirectory()) {
      for (const name of readdirSync(path).sort()) scan(path + "/" + name, depth + 1);
    } else {
      need(s.isFile() && s.size <= 1024 * 1024, "PRODUCER_SOURCE_REQUIRES_REVIEW");
      result[path] = sha(readFileSync(path));
    }
  };
  for (const path of ["/etc/crontab", "/etc/cron.d", "/var/spool/cron/crontabs", "/etc/systemd/system", "/usr/lib/systemd/system"]) scan(path);
  return result;
}
export function verifyOnlyOwnedCronChanged(before, after) {
  const key = "/var/spool/cron/crontabs/voldzi";
  const strip = (value) =>
    Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== key)
        .sort(([a], [b]) => a.localeCompare(b))
    );
  need(JSON.stringify(strip(before)) === JSON.stringify(strip(after)), "OTHER_PRODUCER_CONFIGURATION_CHANGED");
}
export function composeArguments(files, source, service, action) {
  need(
    Object.hasOwn(SERVICES, service) &&
      Array.isArray(files) &&
      files.length > 0 &&
      files.every((p) => typeof p === "string" && /^\/srv\/sim\/docker-compose(?:\.[a-z0-9-]+)?\.yml$/.test(p)),
    "EXACT_EXISTING_COMPOSE_FILES_REQUIRED"
  );
  const overlay = source + "/deploy/account-safety/database-v2.prepare.compose.yml";
  const args = ["compose", "--project-name", "sim", "--project-directory", "/srv/sim", "--env-file", "/srv/sim/.env"];
  if (action === "config") args.push("--profile", "*");
  for (const path of [...new Set(files)]) args.push("-f", path);
  args.push("-f", overlay);
  if (action === "config") args.push("config", "--format", "json");
  else {
    need(action === "start", "FIXED_COMPOSE_ACTION_REQUIRED");
    args.push("up", "--detach", "--no-deps", "--no-build", "--pull", "never", service);
  }
  return args;
}
function docker(args, input, env = ENV) {
  try {
    return execFileSync("/usr/bin/docker", args, {
      input,
      env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024
    });
  } catch {
    throw Error("SIM_DOCKER_STEP_FAILED");
  }
}
function inspect(name) {
  return JSON.parse(docker(["inspect", name]))[0];
}
function envMap(list) {
  return Object.fromEntries(
    list.map((x) => {
      const at = x.indexOf("=");
      return [x.slice(0, at), x.slice(at + 1)];
    })
  );
}
function facts(value) {
  const labels = value.Config.Labels ?? {};
  need(labels["com.docker.compose.project"] === "sim", "EXACT_SIM_COMPOSE_PROJECT_REQUIRED");
  return {
    containerId: value.Id,
    imageId: value.Image,
    composeFiles: (labels["com.docker.compose.project.config_files"] ?? "")
      .split(",")
      .filter((x) => !x.endsWith("/deploy/account-safety/database-v2.prepare.compose.yml")),
    networkNames: Object.keys(value.NetworkSettings.Networks).sort(),
    networkAliases: Object.fromEntries(Object.entries(value.NetworkSettings.Networks).map(([k, v]) => [k, [...(v.Aliases ?? [])].sort()])),
    portBindings: value.HostConfig.PortBindings ?? {},
    existingMounts: value.Mounts.filter((x) => !["/etc/csm-sim/postgresql-ca.pem", "/driver-measurement-reports"].includes(x.Destination))
      .map((x) => ({ source: x.Source, target: x.Destination, type: x.Type, rw: x.RW }))
      .sort((a, b) => a.target.localeCompare(b.target)),
    nonErasureEnvironmentDigest: sha(JSON.stringify(nonErasureEnvironment(envMap(value.Config.Env))))
  };
}
function candidate(id, service) {
  need(/^sha256:[a-f0-9]{64}$/.test(id), "EXACT_CANDIDATE_IMAGE_ID_REQUIRED");
  const image = JSON.parse(docker(["image", "inspect", id]))[0];
  need(image.Id === id && image.Config.Labels?.["org.opencontainers.image.revision"] === SOURCE_REVISION, "REVIEWED_CANDIDATE_REVISION_REQUIRED");
  const code = `const fs=require('node:fs'),c=require('node:crypto');for(const [p,h]of Object.entries({'deploy/account-safety/database-erasure-guard.mjs':'d0b2a47ef42ecac6f9ba9fb46a50540dc3d1ea1c2e6fb03143f51215156ee77a','deploy/account-safety/driver-report-files.mjs':'7c749eb4cfe8748ed7c84671c825e3c3f691fa4a455375694d220fe85ff9416c'}))if(c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==h)throw Error('SOURCE_MISMATCH');import('./apps/${service}/dist/database-erasure.js').then(()=>console.log('CANDIDATE_IMPORT_OK')).catch(()=>process.exit(2));`;
  need(
    docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "128m",
      "--pids-limit",
      "64",
      "--entrypoint",
      "/usr/local/bin/node",
      id,
      "-e",
      code
    ]).trim() === "CANDIDATE_IMPORT_OK",
    "ACTUAL_CANDIDATE_IMPORT_FAILED"
  );
}
function privateJson(path) {
  const s = lstatSync(path);
  need(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === 0 && (s.mode & 0o777) === 0o600, "ROOT_PRIVATE_DEPLOYMENT_INPUT_REQUIRED");
  return JSON.parse(readFileSync(path, "utf8"));
}
function savePrivate(path, value) {
  const temp = path + ".next-" + process.pid;
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    const parent = openSync(dirname(path), "r");
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
function readCron() {
  try {
    return execFileSync("/usr/bin/crontab", ["-u", "voldzi", "-l"], { encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (e.status === 1 && /no crontab for voldzi/i.test(String(e.stderr))) return "";
    throw Error("OWNED_CRON_UNAVAILABLE");
  }
}
function validatePlan(plan) {
  need(
    plan.sourceRevision === SOURCE_REVISION &&
      Object.keys(plan.images ?? {}).length === 2 &&
      Object.keys(SERVICES).every((k) => /^sha256:[a-f0-9]{64}$/.test(plan.images[k]) && /^[a-f0-9]{64}$/.test(plan.before?.[k]?.containerId)),
    "EXACT_SIM_RUNTIME_PLAN_REQUIRED"
  );
}
function verifySource() {
  verifyInventorySource(root);
  need(
    sha(readFileSync(root + "/deploy/account-safety/database-v2.prepare.compose.yml")) === "ac882dcf898153df596952263f897a21d960ffb12705285649fb3daa2a6aeeb4",
    "PINNED_PREPARATION_OVERLAY_REQUIRED"
  );
}
function verifyBaseEnvironment(before, service) {
  const args = composeArguments(before.composeFiles, root, service, "config"),
    at = args.indexOf(root + "/deploy/account-safety/database-v2.prepare.compose.yml");
  args.splice(at - 1, 2);
  const config = JSON.parse(docker(args));
  need(
    sha(JSON.stringify(nonErasureEnvironment(config.services[service].environment))) === before.nonErasureEnvironmentDigest,
    "NON_ERASURE_BASE_CONFIG_DRIFT_BEFORE_STOP"
  );
}
function validateCurrent(plan, service) {
  const value = inspect(SERVICES[service].container),
    f = facts(value);
  need(value.Id === plan.before[service].containerId || value.Image === plan.images[service], "UNEXPECTED_CURRENT_SIM_CONTAINER");
  need(f.nonErasureEnvironmentDigest === plan.before[service].nonErasureEnvironmentDigest, "NON_ERASURE_CONFIGURATION_CHANGED");
  return value;
}
function runtimeEnv(plan) {
  return { ...ENV, SIM_ERASURE_DRIVER_IMAGE: plan.images["situation-data-api"], SIM_ERASURE_ROUTER_IMAGE: plan.images["ai-router-api"] };
}
function verifyConfigured(plan, service) {
  const config = JSON.parse(docker(composeArguments(plan.before[service].composeFiles, root, service, "config"), undefined, runtimeEnv(plan))),
    s = config.services[service];
  need(
    s.image === plan.images[service] &&
      s.environment[SERVICES[service].flag] === "false" &&
      s.environment.SIM_ACCOUNT_ERASURE_AUTHORITY_MODE === "database_v2" &&
      (s.ports ?? []).length === 0,
    "DISABLED_COMPATIBLE_CONFIGURATION_REQUIRED"
  );
  need(sha(JSON.stringify(nonErasureEnvironment(s.environment))) === plan.before[service].nonErasureEnvironmentDigest, "NON_ERASURE_COMPOSE_ENV_DRIFT");
  const networks = Object.keys(s.networks ?? {})
    .map((k) => config.networks[k].name)
    .sort();
  need(JSON.stringify(networks) === JSON.stringify(plan.before[service].networkNames), "SIM_NETWORK_CONFIGURATION_CHANGED");
  const mounts = (s.volumes ?? []).filter((x) => !["/etc/csm-sim/postgresql-ca.pem", "/driver-measurement-reports"].includes(x.target));
  need(mounts.length === plan.before[service].existingMounts.length, "SIM_EXISTING_MOUNT_COUNT_CHANGED");
  for (const mount of mounts) {
    const previous = plan.before[service].existingMounts.find((x) => x.target === mount.target);
    let source = mount.source;
    if (mount.type === "volume") source = "/var/lib/docker/volumes/" + config.volumes[mount.source].name + "/_data";
    need(
      previous && previous.source === source && previous.type === mount.type && previous.rw === (mount.read_only !== true),
      "SIM_EXISTING_MOUNT_CONFIGURATION_CHANGED"
    );
  }
}
async function verifyRuntime(plan) {
  const result = {};
  for (const [service, s] of Object.entries(SERVICES)) {
    const value = validateCurrent(plan, service),
      f = facts(value);
    need(value.Image === plan.images[service] && value.State.Running === true && value.State.Health?.Status === "healthy", "COMPATIBLE_RUNTIME_NOT_HEALTHY");
    need(
      JSON.stringify(f.networkNames) === JSON.stringify(plan.before[service].networkNames) &&
        JSON.stringify(f.networkAliases) === JSON.stringify(plan.before[service].networkAliases) &&
        JSON.stringify(f.portBindings) === JSON.stringify(plan.before[service].portBindings) &&
        JSON.stringify(f.existingMounts) === JSON.stringify(plan.before[service].existingMounts),
      "SIM_NETWORK_PORT_OR_EXISTING_MOUNT_CHANGED"
    );
    const env = envMap(value.Config.Env);
    need(env[s.flag] === "false" && env.SIM_ACCOUNT_ERASURE_AUTHORITY_MODE === "database_v2", "ERASURE_FLAG_OR_MODE_MISMATCH");
    const ca = value.Mounts.find((x) => x.Destination === "/etc/csm-sim/postgresql-ca.pem");
    need(ca?.Type === "bind" && ca.Source === "/etc/vcode-cop-pgbouncer/postgres-ca.crt" && ca.RW === false, "EXACT_READ_ONLY_POSTGRES_CA_MOUNT_REQUIRED");
    const reports = value.Mounts.find((x) => x.Destination === "/driver-measurement-reports");
    need(
      service === "situation-data-api"
        ? reports?.Type === "bind" && reports.Source === "/srv/x5-production/cache/csm-sim/driver-measurement-reports" && reports.RW === true
        : !reports,
      "EXACT_PRIVATE_REPORT_MOUNT_REQUIRED"
    );
    const code = `const token=process.env[${JSON.stringify(s.token)}];if(!token)throw Error('TOKEN_MISSING');fetch('http://127.0.0.1:${s.port}${s.capability}',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)}).then(async r=>{if(r.status!==200)throw Error('CAPABILITY_HTTP');const b=await r.json();if(b.enabled!==false||b.ready!==false||!b.checks||!Object.values(b.checks).every(x=>x===true)||b.wholeAccountComplete!==false)throw Error('CAPABILITY_CHECKS');console.log(JSON.stringify({enabled:false,ready:false,checks:b.checks,wholeAccountComplete:false}));}).catch(()=>process.exit(2));`;
    result[service] = { imageId: value.Image, containerId: value.Id, capability: JSON.parse(docker(["exec", s.container, "/usr/local/bin/node", "-e", code])) };
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let mode,
    started = false,
    activePlan;
  try {
    const args = process.argv.slice(2);
    mode = args[0];
    need(hostname() === "docker" && !process.env.NODE_OPTIONS && !process.env.NODE_PATH, "FIXED_DOCKER_HOST_ENV_REQUIRED");
    verifySource();
    need(docker(["info", "--format", "{{.DockerRootDir}}"]).trim() === "/var/lib/docker", "EXPECTED_DOCKER_STORE_REQUIRED");
    if (mode === "--plan") {
      need(args.length === 5 && args[1] === "--driver-image" && args[3] === "--router-image", "RUNTIME_PLAN_USAGE_REQUIRED");
      const images = { "situation-data-api": args[2], "ai-router-api": args[4] },
        before = {};
      for (const service of Object.keys(SERVICES)) {
        candidate(images[service], service);
        const current = inspect(SERVICES[service].container);
        need(current.State.Running === true, "CURRENT_SIM_RUNTIME_MUST_BE_RUNNING");
        before[service] = facts(current);
        verifyBaseEnvironment(before[service], service);
      }
      console.log(JSON.stringify({ sourceRevision: SOURCE_REVISION, images, before, erasureEnabled: false, wholeAccountComplete: false }, null, 2));
    } else {
      need(
        process.getuid() === 0 && ["--stop-and-inventory", "--start-disabled", "--verify", "--rollback-disabled"].includes(mode) && args[1] === "--plan-file",
        "ROOT_FIXED_RUNTIME_STEP_REQUIRED"
      );
      need(
        args.length === (mode === "--stop-and-inventory" ? 5 : 3) && (mode !== "--stop-and-inventory" || args[3] === "--inventory-file"),
        "RUNTIME_STEP_USAGE_REQUIRED"
      );
      const plan = privateJson(args[2]);
      validatePlan(plan);
      for (const service of Object.keys(SERVICES)) {
        validateCurrent(plan, service);
        if (mode !== "--verify") candidate(plan.images[service], service);
      }
      activePlan = plan;
      if (mode === "--stop-and-inventory") {
        const receipt = privateJson(args[4]);
        need(
          receipt.sourceRevision === SOURCE_REVISION &&
            ((receipt.readOnly === true && receipt.productionEnrollmentAccepted === false) ||
              (receipt.requiresEnrollmentReview === true && JSON.stringify(receipt.stoppedServices) === JSON.stringify(Object.keys(SERVICES)))),
          "ACTUAL_PRESTOP_INVENTORY_REQUIRED"
        );
        const beforeSources = producerSourceDigests(),
          old = readCron(),
          retired = retireExactCleanup(old),
          transitionPath = args[2] + ".stop-transition.json";
        let transition;
        try {
          transition = privateJson(transitionPath);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        if (transition) verifyStopResume(transition, plan, receipt, old, beforeSources);
        else {
          need(receipt.reportInventory?.inventoryDigest === reportInventory().inventoryDigest, "ACTUAL_PRESTOP_INVENTORY_REQUIRED");
          transition = {
            sourceRevision: SOURCE_REVISION,
            planDigest: sha(JSON.stringify(plan)),
            originalInventoryDigest: receipt.reportInventory.inventoryDigest,
            beforeCronDigest: sha(old),
            afterCronDigest: sha(retired.text),
            beforeSources,
            fileCount: receipt.reportInventory.fileCount,
            bytes: receipt.reportInventory.bytes
          };
          savePrivate(transitionPath, transition);
        }
        for (const service of Object.keys(SERVICES)) {
          const value = validateCurrent(plan, service);
          if (value.State.Running) docker(["stop", SERVICES[service].container]);
        }
        if (retired.changed) {
          need(readCron() === old, "CRON_CHANGED_DURING_MAINTENANCE");
          execFileSync("/usr/bin/crontab", ["-u", "voldzi", "-"], { input: retired.text, env: ENV, stdio: ["pipe", "pipe", "pipe"] });
          need(readCron() === retired.text, "CRON_RETIREMENT_READBACK_FAILED");
        }
        const inventory = reportInventory();
        need(inventory.activeProducerCount === 0 && inventory.producerMatches.length === 0 && !inventory.lockPresent, "POSTSTOP_REPORT_INVENTORY_NOT_CLEAR");
        verifyOnlyOwnedCronChanged(transition.beforeSources, producerSourceDigests());
        need(inventory.fileCount === transition.fileCount && inventory.bytes === transition.bytes, "REPORT_FILES_CHANGED_DURING_CUTOVER");
        need(sha(readCron()) === transition.afterCronDigest, "CRON_FINAL_DIGEST_MISMATCH");
        transition.postInventoryDigest = inventory.inventoryDigest;
        savePrivate(transitionPath, transition);
        console.log(
          JSON.stringify(
            {
              sourceRevision: SOURCE_REVISION,
              stoppedServices: Object.keys(SERVICES),
              legacyCleanupRetired: true,
              retiredCronSha256: EXPECTED_CLEANUP_HASH,
              originalInventoryDigest: transition.originalInventoryDigest,
              otherProducerSourcesUnchanged: true,
              reportInventory: inventory,
              requiresEnrollmentReview: true,
              databaseContacted: false,
              erasureEnabled: false
            },
            null,
            2
          )
        );
      } else {
        if (mode !== "--verify") {
          // Same compatible images and the source-owned literal false overlay for
          // both initial start and rollback. Never return an old image after SQL003.
          for (const service of Object.keys(SERVICES)) verifyConfigured(plan, service);
          started = true;
          for (const service of Object.keys(SERVICES))
            docker(composeArguments(plan.before[service].composeFiles, root, service, "start"), undefined, runtimeEnv(plan));
          for (let i = 0; i < 18; i++) {
            if (Object.values(SERVICES).every((s) => inspect(s.container).State.Health?.Status === "healthy")) break;
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
        console.log(
          JSON.stringify(
            {
              sourceRevision: SOURCE_REVISION,
              mode,
              runtimes: await verifyRuntime(plan),
              erasureEnabled: false,
              wholeAccountComplete: false,
              oldImageFallback: false
            },
            null,
            2
          )
        );
      }
    }
  } catch (e) {
    if (started && activePlan)
      for (const service of Object.keys(SERVICES)) {
        try {
          if (inspect(SERVICES[service].container).Image === activePlan.images[service]) docker(["stop", SERVICES[service].container]);
        } catch {}
      }
    console.error(
      JSON.stringify({
        mode,
        code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : "SIM_RUNTIME_STEP_FAILED",
        wholeAccountComplete: false,
        oldImageFallback: false
      })
    );
    process.exitCode = 2;
  }
}
