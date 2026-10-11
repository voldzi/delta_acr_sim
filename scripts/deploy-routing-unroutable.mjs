#!/usr/bin/env node
// Image-only SDA release guard. All subprocess output and secret material stay private.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { posix } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = "/srv/sim";
const ENV_FILE = `${ROOT}/.env`;
const IMAGE_KEY = "DRIVER_MEASUREMENTS_IMAGE";
const SERVICE = "situation-data-api";
const CONTAINER = "csm-sim-situation-data-api";
const BASE_REVISION = "20a0d961ba4cdb1f100998d7f8e07787dad03327";
const BASE_IMAGE_ID = "sha256:60d66a8083e4df55ea5eb8d8713c1846556a96162cd4fce1b70600ffecf89fc4";
const X5 = "/srv/x5-production";
const X5_UUID = "2f93f595-b61b-4eea-9054-7afa9b275b5b";
const LOCK = `${ROOT}/.deploy-routing-unroutable.lock`;
const BACKUPS = `${ROOT}/.deploy-routing-unroutable-backups`;
const FILES = [`${ROOT}/docker-compose.yml`, `${ROOT}/docker-compose.x5.yml`, `${ROOT}/docker-compose.driver-measurements.yml`];
const MIN_DISK_BYTES = 8n * 1024n ** 3n;
const MIN_AVAILABLE_MEMORY_KIB = 2 * 1024 ** 2;
const temporaryFiles = new Set();
const hash = (value) =>
  createHash("sha256")
    .update(Buffer.isBuffer(value) || typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const sortedObject = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
const safeError = () => new Error("Deployment command failed; captured diagnostics suppressed.");

function parseArguments(argv) {
  const accepted = new Set(["--image", "--revision", "--expected-old-image-id", "--expected-routing-source-sha256", "--expected-routing-dist-sha256"]);
  const values = {};
  let mode;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--check" || name === "--apply") {
      assert.equal(mode, undefined, "Exactly one mode is required");
      mode = name.slice(2);
    } else {
      assert.ok(accepted.has(name) && values[name] === undefined, "Unknown or duplicate argument");
      const value = argv[++index];
      assert.ok(typeof value === "string" && !value.startsWith("--"), "Missing argument value");
      values[name] = value;
    }
  }
  assert.ok(mode && Object.keys(values).length === accepted.size, "Incomplete arguments");
  assert.match(values["--image"], /^sim-situation-data-api:[A-Za-z0-9][A-Za-z0-9_.-]{0,160}$/);
  assert.match(values["--revision"], /^[0-9a-f]{40}$/);
  assert.notEqual(values["--revision"], BASE_REVISION, "A distinct hotfix revision is required");
  assert.equal(values["--expected-old-image-id"], BASE_IMAGE_ID, "Unexpected deployed base identity");
  for (const name of ["--expected-routing-source-sha256", "--expected-routing-dist-sha256"]) {
    assert.match(values[name], /^[0-9a-f]{64}$/);
  }
  return {
    mode,
    image: values["--image"],
    revision: values["--revision"],
    expectedOld: values["--expected-old-image-id"],
    sourceHash: values["--expected-routing-source-sha256"],
    distHash: values["--expected-routing-dist-sha256"]
  };
}

function command(bin, args, env = process.env, timeout = 45_000) {
  try {
    return execFileSync(bin, args, {
      cwd: ROOT,
      env,
      timeout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024
    });
  } catch {
    throw safeError();
  }
}
const inspect = (name = CONTAINER, timeout) => JSON.parse(command("docker", ["inspect", name], process.env, timeout))[0];
const inspectImage = (name) => JSON.parse(command("docker", ["image", "inspect", name]))[0];
const compose = (args, image, timeout) =>
  command("docker", ["compose", "--project-name", "sim", ...FILES.flatMap((file) => ["-f", file]), ...args], { ...process.env, [IMAGE_KEY]: image }, timeout);
const resolvedConfig = (image) => JSON.parse(compose(["config", "--format", "json"], image));
const fileHashes = () => Object.fromEntries(FILES.map((file) => [file, hash(readFileSync(file))]));

function environmentMap(container) {
  const entries = container.Config.Env.map((entry) => {
    const index = entry.indexOf("=");
    assert.ok(index > 0, "Invalid runtime environment");
    return [entry.slice(0, index), entry.slice(index + 1)];
  });
  assert.equal(new Set(entries.map(([key]) => key)).size, entries.length, "Duplicate runtime environment");
  return sortedObject(Object.fromEntries(entries));
}

function normalizeHostConfig(config) {
  const result = structuredClone(config);
  if (Array.isArray(result.Mounts)) {
    const targets = result.Mounts.map((mount) => mount.Target);
    assert.ok(
      targets.every(
        (target) => typeof target === "string" && target.startsWith("/") && target !== "/" && posix.normalize(target) === target && !target.endsWith("/")
      )
    );
    assert.equal(new Set(targets).size, targets.length, "Ambiguous mount targets");
    result.Mounts.sort((a, b) => a.Target.localeCompare(b.Target));
  }
  if (Array.isArray(result.Binds)) result.Binds.sort();
  return result;
}

function runtimeInvariant(container) {
  return {
    runtimeConfigHash: hash(
      Object.fromEntries(
        ["Cmd", "Entrypoint", "WorkingDir", "User", "Healthcheck", "ExposedPorts", "Volumes"].map((key) => [key, container.Config[key] ?? null])
      )
    ),
    environmentHash: hash(environmentMap(container)),
    hostConfigHash: hash(normalizeHostConfig(container.HostConfig)),
    mountsHash: hash([...container.Mounts].sort((a, b) => a.Destination.localeCompare(b.Destination))),
    networks: sortedObject(
      Object.fromEntries(
        Object.entries(container.NetworkSettings.Networks).map(([name, network]) => [
          name,
          {
            id: network.NetworkID,
            aliases: (network.Aliases ?? []).filter((alias) => alias !== container.Id && alias !== container.Id.slice(0, 12)).sort()
          }
        ])
      )
    )
  };
}

function otherContainers() {
  return sortedObject(
    Object.fromEntries(
      command("docker", ["ps", "-a", "--format", "{{.Names}} {{.ID}}"])
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" "))
        .filter(([name]) => name !== CONTAINER)
    )
  );
}

function validateResources() {
  assert.equal(command("findmnt", ["-n", "-o", "UUID", "--mountpoint", X5]).trim(), X5_UUID, "X5 mount mismatch");
  const dockerRoot = JSON.parse(command("docker", ["info", "--format", "{{json .DockerRootDir}}"]));
  assert.ok(typeof dockerRoot === "string" && dockerRoot.startsWith("/") && dockerRoot !== "/", "Invalid Docker storage path");
  for (const path of [ROOT, X5, dockerRoot]) {
    const stat = statfsSync(path, { bigint: true });
    assert.ok(stat.bavail * stat.bsize >= MIN_DISK_BYTES, "Insufficient activation disk headroom");
  }
  const match = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  assert.ok(match && Number(match[1]) >= MIN_AVAILABLE_MEMORY_KIB, "Insufficient available memory");
}

function envFileMetadata() {
  const stat = lstatSync(ENV_FILE);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Secrets file must be a regular file");
  assert.equal(stat.mode & 0o777, 0o600, "Secrets file mode mismatch");
  assert.equal(stat.uid, process.getuid(), "Secrets file ownership mismatch");
  return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
}

function privateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Backup directory must not be a symlink");
  assert.equal(stat.uid, process.getuid(), "Backup directory ownership mismatch");
  assert.equal(stat.mode & 0o777, 0o700, "Backup directory mode mismatch");
}

function privateWrite(path, bytes) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function replaceEnvironment(bytes, metadata, suffix) {
  const temporary = `${ENV_FILE}.routing-unroutable-${suffix}-${process.pid}`;
  const fd = openSync(temporary, "wx", 0o600);
  temporaryFiles.add(temporary);
  try {
    fchownSync(fd, metadata.uid, metadata.gid);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, ENV_FILE);
  temporaryFiles.delete(temporary);
  const directory = openSync(ROOT, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function validateComposeRuntime(config, before) {
  const service = config.services[SERVICE];
  assert.ok(service, "SDA service is missing");
  assert.equal(service.image, before.Config.Image, "Current Compose image differs from runtime");
  const env = environmentMap(before);
  for (const [key, value] of Object.entries(service.environment ?? {})) {
    assert.equal(env[key], value === null ? undefined : String(value), "Current Compose environment differs from runtime");
  }
  for (const key of [
    "DRIVER_MEASUREMENTS_ENABLED",
    "DRIVER_MEASUREMENTS_REVOCATION_ENABLED",
    "ROUTING_STRICT_TRIPS_ENABLED",
    "ROUTING_KNOWN_CLOSURES_ENABLED"
  ]) {
    assert.ok(env[key] === "true" || env[key] === "false", "Invalid existing pilot flag");
  }
  if (env.DRIVER_MEASUREMENTS_ENABLED === "true" || env.DRIVER_MEASUREMENTS_REVOCATION_ENABLED === "true") {
    for (const key of ["DRIVER_MEASUREMENTS_DATABASE_URL", "DRIVER_MEASUREMENTS_COP_TOKEN", "DRIVER_MEASUREMENTS_HASH_SECRET"]) {
      assert.ok(typeof env[key] === "string" && env[key].length > 0, "Existing measurement authentication is incomplete");
    }
  }
  const configuredMounts = service.volumes ?? [];
  assert.equal(configuredMounts.length, before.Mounts.length, "Current Compose mount count differs from runtime");
  for (const mount of configuredMounts) {
    const current = before.Mounts.find((item) => item.Destination === mount.target);
    assert.ok(current && current.Type === mount.type, "Current Compose mount differs from runtime");
    assert.equal(current.RW, !mount.read_only, "Current mount access differs from runtime");
    if (mount.type === "bind") assert.equal(current.Source, mount.source, "Current bind source differs from runtime");
    else {
      assert.equal(mount.type, "volume", "Unsupported existing mount type");
      assert.equal(current.Name, config.volumes[mount.source].name, "Current volume identity differs from runtime");
    }
  }
  const configuredNetworks = Object.keys(service.networks ?? {})
    .map((key) => config.networks[key].name)
    .sort();
  assert.deepEqual(configuredNetworks, Object.keys(before.NetworkSettings.Networks).sort(), "Current Compose networks differ from runtime");
  assert.equal((service.ports ?? []).length, 0, "SDA must not gain a published port");
  assert.equal(Object.keys(before.HostConfig.PortBindings ?? {}).length, 0, "Unexpected SDA published port");
}

// Hash only immutable code/config. No env, provider cache, data, URLs or payloads are read.
const imageManifestScript = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const excluded=new Set(['apps/situation-data-api/src/routing-service.ts','apps/situation-data-api/dist/routing-service.js']);
const records=[];
function walk(relative){
  const absolute=path.join('/app',relative),stat=fs.lstatSync(absolute);
  if(stat.isSymbolicLink())throw Error('Unexpected immutable code symlink');
  if(stat.isDirectory()){for(const name of fs.readdirSync(absolute).sort())walk(relative+'/'+name);return;}
  if(!stat.isFile())throw Error('Unexpected immutable code file');
  if(!excluded.has(relative))records.push([relative,sha(fs.readFileSync(absolute))]);
}
for(const relative of ['apps/situation-data-api/src','apps/situation-data-api/dist','packages/observability/src','packages/observability/dist','openapi'])walk(relative);
for(const relative of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.npmrc','apps/situation-data-api/package.json','apps/situation-data-api/tsconfig.json','packages/observability/package.json'])walk(relative);
records.sort((a,b)=>a[0].localeCompare(b[0]));
console.log(JSON.stringify({treeHash:sha(JSON.stringify(records)),fileCount:records.length,nodeVersion:process.version,
routingSourceHash:sha(fs.readFileSync('/app/apps/situation-data-api/src/routing-service.ts')),
routingDistHash:sha(fs.readFileSync('/app/apps/situation-data-api/dist/routing-service.js'))}));
`;

function verifyCandidate(options, before) {
  const oldImage = inspectImage(before.Image);
  const candidate = inspectImage(options.image);
  assert.equal(oldImage.Id, options.expectedOld, "Unexpected old image");
  assert.equal(inspectImage(before.Config.Image).Id, before.Image, "Original rollback image pin changed");
  assert.equal(oldImage.Config.Labels?.["org.opencontainers.image.revision"], BASE_REVISION, "Old image is not the exact base revision");
  assert.equal(candidate.Config.Labels?.["org.opencontainers.image.revision"], options.revision, "Candidate revision mismatch");
  assert.notEqual(candidate.Id, oldImage.Id, "Candidate must be a new image");
  assert.equal(candidate.Os, oldImage.Os);
  assert.equal(candidate.Architecture, oldImage.Architecture);
  for (const key of ["Cmd", "Entrypoint", "WorkingDir", "User", "Env", "Healthcheck", "ExposedPorts", "Volumes"]) {
    assert.deepEqual(candidate.Config[key] ?? null, oldImage.Config[key] ?? null, "Image runtime configuration changed");
  }
  const original = JSON.parse(command("docker", ["exec", CONTAINER, "node", "-e", imageManifestScript]));
  const next = JSON.parse(
    command("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--memory",
      "256m",
      "--cpus",
      "0.5",
      "--pids-limit",
      "32",
      "--security-opt",
      "no-new-privileges",
      "--entrypoint",
      "node",
      candidate.Id,
      "-e",
      imageManifestScript
    ])
  );
  assert.equal(next.treeHash, original.treeHash, "Unrelated immutable runtime files changed");
  assert.equal(next.fileCount, original.fileCount, "Unrelated immutable runtime file count changed");
  assert.equal(next.nodeVersion, original.nodeVersion, "Node runtime changed");
  assert.equal(next.routingSourceHash, options.sourceHash, "Candidate routing source mismatch");
  assert.equal(next.routingDistHash, options.distHash, "Candidate routing dist mismatch");
  assert.notEqual(next.routingSourceHash, original.routingSourceHash, "Hotfix source is not changed");
  assert.notEqual(next.routingDistHash, original.routingDistHash, "Hotfix runtime is not changed");
  return { candidate, original, next };
}

async function healthyImage(expectedImage) {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    const remaining = Math.max(1, deadline - performance.now());
    const current = inspect(CONTAINER, Math.min(10_000, Math.floor(remaining)));
    assert.equal(current.Image, expectedImage, "Unexpected SDA identity during readiness");
    assert.ok(current.State.Running && !current.State.OOMKilled, "SDA stopped or OOM-killed");
    if (current.State.Health?.Status === "healthy") return current;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - performance.now()))));
  }
  throw new Error("SDA health deadline exceeded.");
}

async function main() {
  let phase = "arguments",
    lockFd,
    lockIdentity,
    backup,
    changed = false,
    before,
    originalEnv,
    nextEnv,
    metadata,
    configs,
    otherBefore,
    invariants,
    candidateId,
    options;
  try {
    options = parseArguments(process.argv.slice(2));
    phase = "resource_preflight";
    assert.equal(process.env[IMAGE_KEY], undefined, "Inherited image override is not allowed");
    validateResources();
    if (options.mode === "apply") {
      lockFd = openSync(LOCK, "wx", 0o600);
      const lockStat = fstatSync(lockFd);
      lockIdentity = { dev: lockStat.dev, ino: lockStat.ino };
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fsyncSync(lockFd);
    } else assert.ok(!existsSync(LOCK), "Another SDA release owns the lock");
    phase = "runtime_preflight";
    before = inspect();
    assert.equal(before.Image, options.expectedOld, "SDA changed before deployment");
    assert.ok(before.State.Running && before.State.Health?.Status === "healthy" && !before.State.OOMKilled, "SDA is not healthy");
    assert.deepEqual(before.Config.Labels?.["com.docker.compose.project.config_files"]?.split(","), FILES, "Compose overlays changed");
    metadata = envFileMetadata();
    originalEnv = readFileSync(ENV_FILE);
    const originalText = originalEnv.toString("utf8");
    assert.equal(Buffer.from(originalText).compare(originalEnv), 0, "Secrets file is not valid UTF-8");
    const imageLines = originalText.split("\n").filter((line) => line.startsWith(`${IMAGE_KEY}=`));
    assert.equal(imageLines.length, 1, "Ambiguous authoritative image selection");
    assert.equal(imageLines[0].slice(IMAGE_KEY.length + 1), before.Config.Image, "Authoritative image pin differs from runtime");
    otherBefore = otherContainers();
    invariants = runtimeInvariant(before);
    configs = fileHashes();
    phase = "compose_preflight";
    const currentConfig = resolvedConfig(before.Config.Image);
    validateComposeRuntime(currentConfig, before);
    const candidateConfig = resolvedConfig(options.image);
    assert.equal(candidateConfig.services[SERVICE].image, options.image, "Candidate image override was not selected");
    candidateConfig.services[SERVICE].image = currentConfig.services[SERVICE].image;
    assert.deepEqual(candidateConfig, currentConfig, "Candidate would change more than the image");
    phase = "candidate_identity";
    const identity = verifyCandidate(options, before);
    candidateId = identity.candidate.Id;
    nextEnv = Buffer.from(originalText.replace(new RegExp(`^${IMAGE_KEY}=.*$`, "m"), `${IMAGE_KEY}=${options.image}`));
    const stripImage = (bytes) =>
      bytes
        .toString("utf8")
        .split("\n")
        .filter((line) => !line.startsWith(`${IMAGE_KEY}=`))
        .join("\n");
    assert.equal(hash(stripImage(nextEnv)), hash(stripImage(originalEnv)), "Unrelated environment change");
    if (options.mode === "check") {
      assert.equal(hash(readFileSync(ENV_FILE)), hash(originalEnv), "Environment changed during check");
      assert.deepEqual(fileHashes(), configs, "Compose changed during check");
      assert.equal(inspect().Id, before.Id, "SDA changed during check");
      assert.deepEqual(otherContainers(), otherBefore, "Another container changed during check");
      console.log(
        JSON.stringify({
          status: "checked",
          applied: false,
          revision: options.revision,
          imageId: candidateId,
          baseRevision: BASE_REVISION,
          singleService: SERVICE,
          runtimeFilesExceptRoutingUnchanged: true,
          productionFlagsPreserved: true,
          routeAcceptance: "separate_authenticated_acceptance_required"
        })
      );
      return;
    }
    phase = "private_backup";
    privateDirectory(BACKUPS);
    backup = `${BACKUPS}/${new Date().toISOString().replaceAll(":", "-")}-${options.revision.slice(0, 12)}-${process.pid}`;
    privateDirectory(backup);
    privateWrite(`${backup}/before.env`, originalEnv);
    const record = {
      schemaVersion: "sim-sda-image-only-rollback/v1",
      service: SERVICE,
      container: CONTAINER,
      baseRevision: BASE_REVISION,
      revision: options.revision,
      oldImage: before.Config.Image,
      oldImageId: before.Image,
      candidateImage: options.image,
      candidateImageId: candidateId,
      originalEnvironmentSha256: hash(originalEnv),
      candidateEnvironmentSha256: hash(nextEnv),
      environmentFileMetadata: metadata,
      configHashes: configs,
      invariants,
      otherContainers: otherBefore,
      codeIdentity: { original: identity.original, candidate: identity.next }
    };
    privateWrite(`${backup}/before.json`, JSON.stringify(record, null, 2));
    privateWrite(
      `${backup}/ROLLBACK.txt`,
      [
        "PRIVATE crash-recovery instructions; never print before.env or inspect environment.",
        "Do not remove another process lock. Confirm the recorded deploy is no longer running.",
        "Before any restore, verify current SDA image is the recorded candidate or old image,",
        "current .env SHA-256 equals candidateEnvironmentSha256 (or originalEnvironmentSha256),",
        "and every recorded Compose hash is unchanged. Otherwise stop for manual coordination.",
        "Atomically restore private before.env with its recorded uid/gid and mode 600.",
        `Use the exact three recorded Compose files and project sim. Set ${IMAGE_KEY} to oldImage explicitly.`,
        `Run compose up -d --no-deps --no-build ${SERVICE}; never build, prune or recreate dependencies.`,
        "Verify healthy SDA at oldImageId, original runtime invariants, original .env hash,",
        "and no other container identity changed. Never restore or modify application databases.",
        "Keep this private backup and both images until authenticated route acceptance is complete."
      ].join("\n") + "\n"
    );
    phase = "activation_compare_and_swap";
    validateResources();
    assert.equal(hash(readFileSync(ENV_FILE)), hash(originalEnv), "Environment changed before activation");
    assert.deepEqual(envFileMetadata(), metadata, "Environment metadata changed before activation");
    assert.deepEqual(fileHashes(), configs, "Compose changed before activation");
    const current = inspect();
    assert.equal(current.Id, before.Id, "SDA changed before activation");
    assert.deepEqual(runtimeInvariant(current), invariants, "SDA runtime changed before activation");
    assert.deepEqual(otherContainers(), otherBefore, "Another container changed before activation");
    assert.equal(inspectImage(options.image).Id, candidateId, "Candidate image tag changed before activation");
    assert.equal(inspectImage(before.Config.Image).Id, before.Image, "Original rollback image pin changed before activation");
    phase = "activation";
    // Mark ownership before rename so even a later directory-fsync failure triggers guarded recovery.
    changed = true;
    replaceEnvironment(nextEnv, metadata, "next");
    compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", SERVICE], options.image, 120_000);
    phase = "health_acceptance";
    const after = await healthyImage(candidateId);
    phase = "invariant_acceptance";
    assert.deepEqual(runtimeInvariant(after), invariants, "SDA runtime invariants changed");
    assert.deepEqual(otherContainers(), otherBefore, "Another container changed during the release");
    assert.deepEqual(fileHashes(), configs, "Compose changed during the release");
    assert.equal(hash(readFileSync(ENV_FILE)), hash(nextEnv), "Environment changed during the release");
    assert.deepEqual(envFileMetadata(), metadata, "Environment metadata changed during the release");
    const proof = {
      status: "success",
      revision: options.revision,
      imageId: after.Image,
      health: after.State.Health.Status,
      onlySdaChanged: true,
      invariantsPreserved: true,
      backup,
      routeAcceptance: "separate_authenticated_acceptance_required"
    };
    privateWrite(`${backup}/after.json`, JSON.stringify(proof, null, 2));
    console.log(JSON.stringify(proof));
  } catch {
    let rollback = "not_needed";
    if (changed) {
      try {
        const bytes = readFileSync(ENV_FILE);
        const current = inspect();
        assert.ok(hash(bytes) === hash(nextEnv) || hash(bytes) === hash(originalEnv), "Environment is no longer owned by this release");
        assert.deepEqual(envFileMetadata(), metadata, "Environment metadata changed");
        assert.deepEqual(fileHashes(), configs, "Compose is no longer owned by this release");
        assert.ok(current.Image === candidateId || current.Image === before.Image, "SDA is no longer owned by this release");
        assert.deepEqual(otherContainers(), otherBefore, "Concurrent other-container change requires coordination");
        assert.equal(inspectImage(before.Config.Image).Id, before.Image, "Original image pin changed");
        replaceEnvironment(originalEnv, metadata, "rollback");
        compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", SERVICE], before.Config.Image, 120_000);
        const restored = await healthyImage(before.Image);
        assert.deepEqual(runtimeInvariant(restored), invariants, "Original SDA invariants not restored");
        assert.equal(hash(readFileSync(ENV_FILE)), hash(originalEnv), "Original environment not restored");
        assert.deepEqual(envFileMetadata(), metadata, "Original environment metadata not restored");
        assert.deepEqual(fileHashes(), configs, "Compose changed during rollback");
        assert.deepEqual(otherContainers(), otherBefore, "Other container changed during rollback");
        rollback = "verified_original_healthy";
      } catch {
        rollback = "requires_attention";
      }
    }
    console.log(JSON.stringify({ status: "failed", phase, error: "Deployment guard failed; private diagnostics suppressed.", rollback, backup }));
    process.exitCode = 1;
  } finally {
    for (const file of temporaryFiles) {
      try {
        unlinkSync(file);
      } catch {
        /* Private temp cleanup is best-effort; never touch foreign paths. */
      }
    }
    if (lockFd !== undefined) {
      try {
        closeSync(lockFd);
      } finally {
        try {
          const lockStat = lstatSync(LOCK);
          if (lockStat.dev === lockIdentity?.dev && lockStat.ino === lockIdentity?.ino) unlinkSync(LOCK);
        } catch {
          /* Never unlink a foreign or replaced lock. */
        }
      }
    }
  }
}

await main();
