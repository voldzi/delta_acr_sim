#!/usr/bin/env node
// Reviewed, pinned SDA image-only release. Never copy, truncate or reserialize .env.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, statfsSync, statSync, unlinkSync, writeFileSync, writeSync
} from "node:fs";
import { posix, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const ROOT = "/srv/sim", ENV_FILE = `${ROOT}/.env`, SERVICE = "situation-data-api", CONTAINER = "csm-sim-situation-data-api";
const IMAGE_KEY = "DRIVER_MEASUREMENTS_IMAGE";
const SOURCE_REVISION = "90e1d8d0cc50236429b32476e3fd2f31899cf03c";
const BASE_REVISION = "03b842e005f103bb02d622bb4fc95f27fbea9572";
const OLD_ID = "sha256:2f3aa1659d03c5eaf014353071e38f6abc1d2da1419a9ac2205a05b5873a5965";
const OLD_PIN = "sim-situation-data-api:routing-location-03b842e005f1";
const CANDIDATE = "sim-situation-data-api:search-freshness-90e1d8d0cc50";
const PROTECTED_OLD = "sim-situation-data-api:rollback-search90-03b842e005f1";
const SOURCE_SHA = "698e3dd4d978db08cd8ddbc484082327b3743392913ad37b53244cab3a327aaa";
const DIST_SHA = "3060a86a481496e701f9f3c1523bb2c95f68825348a285fe7979a090fe4aad1b";
const X5 = "/srv/x5-production", X5_UUID = "2f93f595-b61b-4eea-9054-7afa9b275b5b";
const LOCK = `${ROOT}/.deploy-search-freshness.lock`, BACKUPS = `${ROOT}/.deploy-search-freshness-backups`;
const FILES = [`${ROOT}/docker-compose.yml`, `${ROOT}/docker-compose.x5.yml`, `${ROOT}/docker-compose.driver-measurements.yml`];
const MAX_ENV_BYTES = 1024 * 1024;
const sha = value => createHash("sha256").update(Buffer.isBuffer(value) || typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const sorted = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
const guardError = code => Object.assign(new Error("Deployment guard failed; private diagnostics suppressed."), { code });

export function parseArguments(argv) {
  const expected = {
    "--image": CANDIDATE, "--revision": SOURCE_REVISION, "--expected-old-image-id": OLD_ID,
    "--expected-source-sha256": SOURCE_SHA, "--expected-dist-sha256": DIST_SHA
  };
  const values = {};
  let mode;
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (["--preflight", "--check", "--apply", "--rollback"].includes(name)) {
      assert.equal(mode, undefined, "Exactly one release mode is required");
      mode = name.slice(2);
    } else {
      assert.ok((Object.hasOwn(expected, name) || name === "--record-dir") && !Object.hasOwn(values, name), "Unknown or duplicate argument");
      const value = argv[++i];
      assert.ok(typeof value === "string" && !value.startsWith("--"), "Missing argument value");
      values[name] = value;
    }
  }
  assert.ok(mode, "A release mode is required");
  for (const [name, value] of Object.entries(expected)) assert.equal(values[name], value, "Pinned release argument mismatch");
  if (mode === "rollback") {
    assert.ok(typeof values["--record-dir"] === "string" && values["--record-dir"].startsWith(BACKUPS + "/") &&
      posix.normalize(values["--record-dir"]) === values["--record-dir"] &&
      posix.dirname(values["--record-dir"]) === BACKUPS && /^[A-Za-z0-9_.-]+$/.test(posix.basename(values["--record-dir"])), "Invalid private record directory");
  } else assert.equal(values["--record-dir"], undefined, "Record directory is rollback-only");
  return { mode, image: CANDIDATE, revision: SOURCE_REVISION, expectedOld: OLD_ID,
    sourceHash: SOURCE_SHA, distHash: DIST_SHA, ...(mode === "rollback" ? { recordDir: values["--record-dir"] } : {}) };
}

function imageLine(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_ENV_BYTES, "Invalid environment buffer");
  const text = bytes.toString("utf8");
  assert.ok(Buffer.from(text, "utf8").equals(bytes), "Environment is not valid UTF-8");
  const assignments = [...text.matchAll(/^\s*(?:export\s+)?DRIVER_MEASUREMENTS_IMAGE\s*=/gm)];
  assert.equal(assignments.length, 1, "Ambiguous image assignment");
  const matches = [...text.matchAll(/^DRIVER_MEASUREMENTS_IMAGE=([^\r\n]*)(?:\r?\n|$)/gm)];
  assert.equal(matches.length, 1, "Image assignment must be canonical");
  const match = matches[0];
  const value = match[1];
  assert.ok(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(value), "Image value must be unquoted ASCII");
  return { value, offset: Buffer.byteLength(text.slice(0, match.index) + IMAGE_KEY + "=", "utf8") };
}

export function imagePinPatchPlan(bytes, oldPin, newPin) {
  assert.ok(Buffer.isBuffer(bytes), "Environment argument must be a buffer");
  const original = Buffer.from(bytes);
  const oldValue = Buffer.from(oldPin, "utf8"), newValue = Buffer.from(newPin, "utf8");
  assert.ok(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(oldPin) && /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(newPin), "Image pins must be ASCII");
  assert.equal(oldValue.length, newValue.length, "Image pins must have equal byte width");
  assert.notEqual(oldPin, newPin, "Image pins must differ");
  const line = imageLine(original);
  assert.equal(line.value, oldPin, "Original image pin differs");
  const nextBytes = Buffer.from(original);
  newValue.copy(nextBytes, line.offset);
  const nonImage = Buffer.concat([original.subarray(0, line.offset), original.subarray(line.offset + oldValue.length)]);
  return { offset: line.offset, length: oldValue.length, beforeValueBytes: oldValue, afterValueBytes: newValue,
    nextBytes, originalSha256: sha(original), nextSha256: sha(nextBytes), nonImageSha256: sha(nonImage) };
}

const selectedMetadata = stat => ({ uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777,
  dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size });
function assertMetadata(stat, metadata) {
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "Environment must be a single-link regular file");
  assert.equal(stat.mode & 0o777, 0o600, "Environment must remain private");
  assert.equal(stat.uid, process.getuid(), "Environment owner differs");
  assert.deepEqual(selectedMetadata(stat), metadata, "Environment identity changed");
}
function readFd(fd, size) {
  assert.ok(Number.isSafeInteger(size) && size > 0 && size <= MAX_ENV_BYTES, "Environment read size exceeded");
  const bytes = Buffer.alloc(size);
  let done = 0;
  while (done < size) {
    const count = readSync(fd, bytes, done, size - done, done);
    assert.ok(count > 0, "Environment read was incomplete");
    done += count;
  }
  assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, size), 0, "Environment length changed");
  return bytes;
}
function productionFlock(fd) {
  try {
    execFileSync("flock", ["-n", "3"], { timeout: 10_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe", fd] });
  } catch { throw guardError("ENV_GUARD_FAILED"); }
}

export function replaceImagePinInPlace(path, expectedBytes, nextBytes, metadata, lockFn = productionFlock) {
  let fd, writeAttempted = false;
  try {
    assert.ok(Buffer.isBuffer(expectedBytes) && Buffer.isBuffer(nextBytes), "Environment arguments must be buffers");
    assert.equal(expectedBytes.length, nextBytes.length, "Environment byte length must not change");
    const plan = imagePinPatchPlan(expectedBytes, imageLine(expectedBytes).value, imageLine(nextBytes).value);
    assert.ok(plan.nextBytes.equals(nextBytes), "Non-image environment bytes changed");
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    assertMetadata(fstatSync(fd), metadata);
    assertMetadata(lstatSync(path), metadata);
    assert.equal(typeof lockFn, "function", "File lock is required");
    lockFn(fd); // Linux flock is retained by this parent's shared open-file description until close.
    assertMetadata(fstatSync(fd), metadata);
    assertMetadata(lstatSync(path), metadata);
    assert.equal(sha(readFd(fd, metadata.size)), sha(expectedBytes), "Environment compare-and-swap failed");
    writeAttempted = true;
    const written = writeSync(fd, plan.afterValueBytes, 0, plan.length, plan.offset); // One write, no retry.
    assert.equal(written, plan.length, "Image pin write was incomplete");
    fsyncSync(fd);
    assertMetadata(fstatSync(fd), metadata);
    assertMetadata(lstatSync(path), metadata);
    assert.equal(sha(readFd(fd, metadata.size)), sha(nextBytes), "Environment write readback failed");
    return { verified: true, previousSha256: plan.originalSha256, nextSha256: plan.nextSha256,
      nonImageSha256: plan.nonImageSha256, offset: plan.offset, length: plan.length };
  } catch {
    throw guardError(writeAttempted ? "ENV_WRITE_UNVERIFIED" : "ENV_GUARD_FAILED");
  } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Preserve the sanitized guard error. */ } } }
}

function readEnvironmentBytes(metadata) {
  const fd = openSync(ENV_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertMetadata(fstatSync(fd), metadata); assertMetadata(lstatSync(ENV_FILE), metadata);
    return readFd(fd, metadata.size);
  } finally { closeSync(fd); }
}

function command(bin, args, env = process.env, timeout = 45_000) {
  try { return execFileSync(bin, args, { cwd: ROOT, env, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }); }
  catch { throw guardError("COMMAND_FAILED"); }
}
const inspect = (timeout = 10_000) => JSON.parse(command("docker", ["inspect", CONTAINER], process.env, timeout))[0];
const inspectImage = image => JSON.parse(command("docker", ["image", "inspect", image]))[0];
const compose = (args, image, timeout) => command("docker", ["compose", "--project-name", "sim", ...FILES.flatMap(file => ["-f", file]), ...args], { ...process.env, [IMAGE_KEY]: image }, timeout);
const config = image => JSON.parse(compose(["config", "--format", "json"], image));
const configHashes = () => Object.fromEntries(FILES.map(file => [file, sha(readFileSync(file))]));
export function runtimeEnvironmentMap(entries) {
  assert.ok(Array.isArray(entries), "Runtime environment must be an entry array");
  const pairs = entries.map(entry => {
    assert.equal(typeof entry, "string", "Runtime environment entry must be a string");
    const index = entry.indexOf("=");
    assert.ok(index > 0, "Runtime environment entry must have a non-empty key");
    return [entry.slice(0, index), entry.slice(index + 1)];
  });
  assert.equal(new Set(pairs.map(([key]) => key)).size, pairs.length, "Duplicate runtime environment key");
  return sorted(Object.fromEntries(pairs));
}
export function assertRuntimeBaseLayers(oldLayers, candidateLayers) {
  const digest = /^sha256:[0-9a-f]{64}$/;
  assert.ok(Array.isArray(oldLayers) && oldLayers.length > 0 && oldLayers.every(value => typeof value === "string" && digest.test(value)), "Old image layers must be immutable digests");
  assert.ok(Array.isArray(candidateLayers) && candidateLayers.every(value => typeof value === "string" && digest.test(value)), "Candidate layers must be immutable digests");
  assert.equal(candidateLayers.length, oldLayers.length + 2, "Candidate must contain only the two reviewed file-copy layers");
  assert.deepEqual(candidateLayers.slice(0, oldLayers.length), oldLayers, "Candidate must inherit the complete immutable old image");
  const added = candidateLayers.slice(oldLayers.length);
  assert.equal(new Set(added).size, 2, "Reviewed copy layers must be distinct");
  assert.ok(added.every(value => !oldLayers.includes(value)), "Reviewed copy layers must be new");
  return true;
}
export function assertEffectiveEnvironment(imageEnvEntries, composeEnvObject, runtimeEnvEntries) {
  const defaults = runtimeEnvironmentMap(imageEnvEntries);
  const runtime = runtimeEnvironmentMap(runtimeEnvEntries);
  assert.ok(composeEnvObject && typeof composeEnvObject === "object" && !Array.isArray(composeEnvObject), "Resolved Compose environment must be an object");
  const effective = new Map(Object.entries(defaults));
  for (const [key, value] of Object.entries(composeEnvObject)) {
    assert.ok(key.length > 0 && (value === null || typeof value === "string"), "Resolved Compose environment values must be strings or null");
    if (value === null) effective.delete(key);
    else effective.set(key, value);
  }
  assert.deepEqual(sorted(Object.fromEntries(effective)), runtime, "Effective Compose environment differs from runtime");
  return true;
}
const environmentMap = container => runtimeEnvironmentMap(container.Config.Env);
function invariant(container) {
  const host = structuredClone(container.HostConfig);
  if (Array.isArray(host.Mounts)) host.Mounts.sort((a, b) => a.Target.localeCompare(b.Target));
  if (Array.isArray(host.Binds)) host.Binds.sort();
  return {
    runtimeConfigHash: sha(Object.fromEntries(["Cmd", "Entrypoint", "WorkingDir", "User", "Healthcheck", "ExposedPorts", "Volumes"].map(key => [key, container.Config[key] ?? null]))),
    environmentHash: sha(environmentMap(container)), hostConfigHash: sha(host),
    mountsHash: sha([...container.Mounts].sort((a, b) => a.Destination.localeCompare(b.Destination))),
    networks: sorted(Object.fromEntries(Object.entries(container.NetworkSettings.Networks).map(([name, network]) => [name, {
      id: network.NetworkID, aliases: (network.Aliases ?? []).filter(alias => alias !== container.Id && alias !== container.Id.slice(0, 12)).sort()
    }])))
  };
}
const others = () => sorted(Object.fromEntries(command("docker", ["ps", "-a", "--format", "{{.Names}} {{.ID}}"])
  .trim().split("\n").filter(Boolean).map(line => line.split(" ")).filter(([name]) => name !== CONTAINER)));

function resources() {
  assert.equal(command("findmnt", ["-n", "-o", "UUID", "--mountpoint", X5]).trim(), X5_UUID, "X5 mount mismatch");
  const x5 = lstatSync(X5);
  assert.ok(x5.isDirectory() && !x5.isSymbolicLink() && x5.dev !== statSync("/").dev, "X5 must be a separate mounted device");
  const dockerRoot = JSON.parse(command("docker", ["info", "--format", "{{json .DockerRootDir}}"]));
  assert.ok(typeof dockerRoot === "string" && dockerRoot.startsWith("/") && dockerRoot !== "/");
  const free = {};
  for (const [name, path] of [["root", "/"], ["x5", X5], ["docker", dockerRoot]]) {
    const stat = statfsSync(path, { bigint: true }), bytes = stat.bavail * stat.bsize;
    assert.ok(bytes >= 12n * 1024n ** 3n, "Insufficient deployment disk headroom");
    free[name] = Number(bytes);
  }
  const memory = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  assert.ok(memory && Number(memory[1]) >= 4 * 1024 ** 2, "Insufficient available memory");
  return { rootFreeBytes: free.root, x5FreeBytes: free.x5, dockerFreeBytes: free.docker, memoryAvailableKiB: Number(memory[1]), separateX5Verified: true };
}
function envMetadata() {
  const stat = lstatSync(ENV_FILE), metadata = selectedMetadata(stat);
  assertMetadata(stat, metadata);
  assert.ok(metadata.size > 0 && metadata.size <= MAX_ENV_BYTES);
  return metadata;
}
function validateBefore() {
  const before = inspect();
  assert.equal(before.Image, OLD_ID);
  assert.equal(before.Config.Image, OLD_PIN);
  assert.equal(before.Config.Labels?.["org.opencontainers.image.revision"], BASE_REVISION);
  assert.ok(before.State.Running && before.State.Health?.Status === "healthy" && !before.State.OOMKilled);
  assert.deepEqual(before.Config.Labels?.["com.docker.compose.project.config_files"]?.split(","), FILES);
  return before;
}
function validateConfigRuntime(resolved, before, image) {
  const service = resolved.services[SERVICE], env = environmentMap(before);
  assert.equal(service.image, image);
  assertEffectiveEnvironment(inspectImage(OLD_ID).Config.Env, service.environment ?? {}, before.Config.Env);
  for (const key of ["DRIVER_MEASUREMENTS_ENABLED", "DRIVER_MEASUREMENTS_REVOCATION_ENABLED", "ROUTING_STRICT_TRIPS_ENABLED", "ROUTING_KNOWN_CLOSURES_ENABLED"]) assert.ok(["true", "false"].includes(env[key]));
  if (env.DRIVER_MEASUREMENTS_ENABLED === "true" || env.DRIVER_MEASUREMENTS_REVOCATION_ENABLED === "true") {
    for (const key of ["DRIVER_MEASUREMENTS_DATABASE_URL", "DRIVER_MEASUREMENTS_COP_TOKEN", "DRIVER_MEASUREMENTS_HASH_SECRET"]) assert.ok(env[key]?.length > 0);
  }
  const mounts = service.volumes ?? [];
  assert.equal(mounts.length, before.Mounts.length);
  for (const mount of mounts) {
    const actual = before.Mounts.find(item => item.Destination === mount.target);
    assert.ok(actual && actual.Type === mount.type);
    assert.equal(actual.RW, !mount.read_only);
    if (mount.type === "bind") assert.equal(actual.Source, mount.source);
    else { assert.equal(mount.type, "volume"); assert.equal(actual.Name, resolved.volumes[mount.source].name); }
  }
  assert.deepEqual(Object.keys(service.networks ?? {}).map(key => resolved.networks[key].name).sort(), Object.keys(before.NetworkSettings.Networks).sort());
  assert.equal((service.ports ?? []).length, 0);
  assert.equal(Object.keys(before.HostConfig.PortBindings ?? {}).length, 0);
}
const offlineArgs = image => ["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL", "--memory", "256m", "--cpus", "0.5", "--pids-limit", "32", "--security-opt", "no-new-privileges", "--entrypoint", "node", image];
const manifestScript = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const excluded=new Set(['apps/situation-data-api/src/search-data.ts','apps/situation-data-api/dist/search-data.js']),records=[];
function walk(relative){const absolute=path.join('/app',relative),stat=fs.lstatSync(absolute);if(stat.isSymbolicLink())throw Error('Invalid code link');if(stat.isDirectory()){for(const name of fs.readdirSync(absolute).sort())walk(relative+'/'+name);return;}if(!stat.isFile())throw Error('Invalid code type');if(!excluded.has(relative))records.push([relative,sha(fs.readFileSync(absolute))]);}
for(const relative of ['apps/situation-data-api/src','apps/situation-data-api/dist','packages/observability/src','packages/observability/dist','openapi'])walk(relative);
for(const relative of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.npmrc','apps/situation-data-api/package.json','apps/situation-data-api/tsconfig.json','packages/observability/package.json'])walk(relative);
records.sort((a,b)=>a[0].localeCompare(b[0]));console.log(JSON.stringify({treeHash:sha(JSON.stringify(records)),fileCount:records.length,nodeVersion:process.version,sourceHash:sha(fs.readFileSync('/app/apps/situation-data-api/src/search-data.ts')),distHash:sha(fs.readFileSync('/app/apps/situation-data-api/dist/search-data.js'))}));`;
// Compare offline image roots, never the live SDA filesystem or provider mounts.
// Only reviewed file content and Docker-created runtime mounts are excluded.
export const rootFilesystemProofScript = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const reviewedFiles=new Set(['/app/apps/situation-data-api/src/search-data.ts','/app/apps/situation-data-api/dist/search-data.js']),excludedFiles=new Set(['/etc/hostname','/etc/hosts','/etc/resolv.conf']);
const excludedTrees=new Set(['/proc','/sys','/dev']),digest=crypto.createHash('sha256'),chunk=Buffer.alloc(1024*1024);
let entryCount=0,fileCount=0,hashedBytes=0;
const identity=s=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.size,s.nlink];
function fileDigest(file,stat){assert.ok(stat.size<=512*1024*1024,'Image file exceeds proof bound');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),hash=crypto.createHash('sha256');try{assert.deepEqual(identity(fs.fstatSync(fd)),identity(stat));let position=0;while(position<stat.size){const count=fs.readSync(fd,chunk,0,Math.min(chunk.length,stat.size-position),position);assert.ok(count>0,'Incomplete image file read');hash.update(chunk.subarray(0,count));position+=count;}assert.equal(fs.readSync(fd,chunk,0,1,position),0);assert.deepEqual(identity(fs.fstatSync(fd)),identity(stat));assert.deepEqual(identity(fs.lstatSync(file)),identity(stat));hashedBytes+=position;return hash.digest('hex');}finally{fs.closeSync(fd);}}
function walk(file,depth=0){assert.ok(depth<=64&&file.length<=4096,'Image path exceeds proof bound');if(excludedTrees.has(file)||excludedFiles.has(file))return;const stat=fs.lstatSync(file);assert.ok(++entryCount<=128000,'Image entries exceed proof bound');const metadata=[stat.mode&0o7777,stat.uid,stat.gid];if(reviewedFiles.has(file)){assert.ok(stat.isFile(),'Reviewed content must be a regular file');fileCount++;digest.update(JSON.stringify([file,'reviewed-content',...metadata])+'\n');}else if(stat.isDirectory()){digest.update(JSON.stringify([file,'directory',...metadata])+'\n');for(const name of fs.readdirSync(file).sort())walk(path.join(file,name),depth+1);assert.deepEqual(identity(fs.lstatSync(file)),identity(stat));}else if(stat.isFile()){fileCount++;digest.update(JSON.stringify([file,'file',...metadata,stat.size,fileDigest(file,stat)])+'\n');}else if(stat.isSymbolicLink()){const target=fs.readlinkSync(file);assert.ok(target.length<=4096);assert.deepEqual(identity(fs.lstatSync(file)),identity(stat));digest.update(JSON.stringify([file,'symlink',...metadata,target])+'\n');}else throw Error('Unexpected image filesystem entry type');}
walk('/');console.log(JSON.stringify({rootFilesystemSha256:digest.digest('hex'),entryCount,fileCount,hashedBytes}));`;
const fixtureScript = String.raw`
import assert from 'node:assert/strict';
globalThis.fetch=()=>{throw Error('Network forbidden in pure fixture');};
const {projectSearchFeedFreshness:project}=await import('/app/apps/situation-data-api/dist/search-data.js');
const base={status:'active',stale:false,sourceSystem:'synthetic',sourceAuthority:'unknown',validUntil:null,expiresAt:null,observedAt:'2029-12-31T23:59:00Z'};
const feed={generatedAt:'2030-01-01T00:00:00Z',summary:{entityCount:999,returnedCount:5,staleEntityCount:0},entities:[{...base,validUntil:'2030-01-01T00:00:05Z'},{...base,validUntil:'invalid'},{...base},{...base,sourceSystem:'osm_reference',sourceAuthority:'reference'},{...base,validUntil:'2030-01-01T00:00:30Z'}]};
const retained=JSON.stringify(feed),now=Date.parse('2030-01-01T00:00:10Z'),out=project(feed,now);
assert.equal(out.entities[0].status,'expired');assert.equal(out.entities[0].stale,true);
assert.equal(out.entities[1].status,'unknown');assert.equal(out.entities[1].stale,true);
assert.equal(out.entities[2].status,'unknown');assert.equal(out.entities[2].stale,true);
assert.equal(out.entities[3].status,'active');assert.equal(out.entities[3].stale,false);
assert.equal(out.entities[4].status,'active');assert.equal(out.entities[4].stale,false);
assert.equal(JSON.stringify(feed),retained);assert.equal(out.generatedAt,feed.generatedAt);assert.deepEqual(out.summary,feed.summary);
assert.ok(out.entities.every((e,i)=>e.observedAt===feed.entities[i].observedAt));
assert.equal(out.freshness.scope,'returned_entities');assert.equal(out.freshness.returnedStaleCount,3);assert.equal(out.freshness.returnedExpiredCount,1);assert.equal(out.freshness.invalidExpiryCount,1);assert.equal(out.freshness.missingExpiryCount,2);assert.equal(out.freshness.feedAgeSeconds,10);
console.log(JSON.stringify({fixturePassed:true,returnedEntitiesScope:true,sourceMetadataPreserved:true,retainedSnapshotUnchanged:true}));`;
function candidateIdentity(before) {
  const old = inspectImage(OLD_ID), candidate = inspectImage(CANDIDATE);
  assert.equal(inspectImage(OLD_PIN).Id, OLD_ID);
  assert.equal(inspectImage(PROTECTED_OLD).Id, OLD_ID);
  assert.equal(old.Config.Labels?.["org.opencontainers.image.revision"], BASE_REVISION);
  assert.equal(candidate.Config.Labels?.["org.opencontainers.image.revision"], SOURCE_REVISION);
  assert.equal(candidate.Config.Labels?.["org.opencontainers.image.base-revision"], BASE_REVISION);
  assert.equal(candidate.Config.Labels?.["org.opencontainers.image.base-image-id"], OLD_ID);
  assert.notEqual(candidate.Id, OLD_ID);
  assert.equal(candidate.Os, old.Os); assert.equal(candidate.Architecture, old.Architecture);
  assert.equal(old.RootFS?.Type, "layers"); assert.equal(candidate.RootFS?.Type, "layers");
  assertRuntimeBaseLayers(old.RootFS.Layers, candidate.RootFS.Layers);
  for (const key of ["Cmd", "Entrypoint", "WorkingDir", "User", "Env", "Healthcheck", "ExposedPorts", "Volumes"]) assert.deepEqual(candidate.Config[key] ?? null, old.Config[key] ?? null);
  const original = JSON.parse(command("docker", [...offlineArgs(OLD_ID), "-e", manifestScript]));
  const next = JSON.parse(command("docker", [...offlineArgs(candidate.Id), "-e", manifestScript]));
  assert.equal(next.treeHash, original.treeHash); assert.equal(next.fileCount, original.fileCount); assert.equal(next.nodeVersion, original.nodeVersion);
  assert.equal(next.sourceHash, SOURCE_SHA); assert.equal(next.distHash, DIST_SHA);
  assert.notEqual(next.sourceHash, original.sourceHash); assert.notEqual(next.distHash, original.distHash);
  const originalRoot = JSON.parse(command("docker", [...offlineArgs(OLD_ID), "-e", rootFilesystemProofScript]));
  const nextRoot = JSON.parse(command("docker", [...offlineArgs(candidate.Id), "-e", rootFilesystemProofScript]));
  assert.deepEqual(nextRoot, originalRoot, "OS, native libraries, dependencies or unreviewed runtime files changed");
  const fixture = JSON.parse(command("docker", [...offlineArgs(candidate.Id), "--input-type=module", "-e", fixtureScript]));
  assert.deepEqual(fixture, { fixturePassed: true, returnedEntitiesScope: true, sourceMetadataPreserved: true, retainedSnapshotUnchanged: true });
  assert.equal(before.Image, OLD_ID);
  assert.equal(inspectImage(PROTECTED_OLD).Id, OLD_ID); assert.equal(inspectImage(CANDIDATE).Id, candidate.Id);
  return { candidateId: candidate.Id, unchangedTreeSha256: next.treeHash, unchangedRootFilesystemSha256: nextRoot.rootFilesystemSha256,
    immutableBaseLayersSha256: sha(old.RootFS.Layers), exactRuntimeBaseVerified: true, fixturePassed: true };
}
function privateDirectory(path, create = false) {
  if (create && !existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700);
}
function privateRecord(path, object) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(object, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
}
async function healthy(expected) {
  const end = performance.now() + 120_000;
  while (performance.now() < end) {
    const current = inspect(Math.min(10_000, Math.max(1, Math.floor(end - performance.now()))));
    assert.equal(current.Image, expected);
    assert.ok(current.State.Running && !current.State.OOMKilled);
    if (current.State.Health?.Status === "healthy") return current;
    await new Promise(done => setTimeout(done, Math.min(1000, Math.max(1, end - performance.now()))));
  }
  throw guardError("HEALTH_DEADLINE");
}
const up = image => compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", SERVICE], image, 120_000);

function readRecord(directory) {
  privateDirectory(BACKUPS); privateDirectory(directory);
  const path = `${directory}/before.json`, stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600 && stat.size < 128 * 1024);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let record;
  try { assert.deepEqual(selectedMetadata(fstatSync(fd)), selectedMetadata(stat)); record = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
  const keys = ["schemaVersion", "sourceRevision", "baseRevision", "oldPin", "candidatePin", "oldImageId", "candidateImageId", "originalEnvironmentSha256", "candidateEnvironmentSha256", "nonImageSha256", "environmentMetadata", "configHashes", "runtimeInvariant", "unchangedTreeSha256", "unchangedRootFilesystemSha256", "immutableBaseLayersSha256"];
  assert.deepEqual(Object.keys(record).sort(), keys.sort());
  assert.equal(record.schemaVersion, "sim-search-freshness-image-only/v2");
  assert.equal(record.sourceRevision, SOURCE_REVISION); assert.equal(record.baseRevision, BASE_REVISION);
  assert.equal(record.oldPin, OLD_PIN); assert.equal(record.candidatePin, CANDIDATE); assert.equal(record.oldImageId, OLD_ID);
  assert.match(record.candidateImageId, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(record.candidateImageId, OLD_ID);
  for (const key of ["originalEnvironmentSha256", "candidateEnvironmentSha256", "nonImageSha256", "unchangedTreeSha256", "unchangedRootFilesystemSha256", "immutableBaseLayersSha256"]) assert.match(record[key], /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(record.configHashes).sort(), [...FILES].sort());
  for (const value of Object.values(record.configHashes)) assert.match(value, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(record.environmentMetadata).sort(), ["uid", "gid", "mode", "dev", "ino", "nlink", "size"].sort());
  assert.ok(Object.values(record.environmentMetadata).every(value => Number.isSafeInteger(value) && value >= 0));
  assert.equal(record.environmentMetadata.mode, 0o600); assert.equal(record.environmentMetadata.nlink, 1);
  assert.equal(record.environmentMetadata.uid, process.getuid());
  assert.ok(record.environmentMetadata.size > 0 && record.environmentMetadata.size <= MAX_ENV_BYTES);
  assert.deepEqual(Object.keys(record.runtimeInvariant).sort(), ["runtimeConfigHash", "environmentHash", "hostConfigHash", "mountsHash", "networks"].sort());
  for (const key of ["runtimeConfigHash", "environmentHash", "hostConfigHash", "mountsHash"]) assert.match(record.runtimeInvariant[key], /^[0-9a-f]{64}$/);
  assert.ok(record.runtimeInvariant.networks && typeof record.runtimeInvariant.networks === "object" && !Array.isArray(record.runtimeInvariant.networks));
  return record;
}

async function main() {
  let phase = "arguments", lockFd, lockIdentity, original, planned, metadata, before, files, baseline, otherBefore,
    candidateId, recordDir, written = false, unverifiedWrite = false, rollbackMode = false;
  try {
    const options = parseArguments(process.argv.slice(2));
    assert.equal(process.env[IMAGE_KEY], undefined, "Inherited image override is forbidden");
    phase = "resource_preflight";
    const headroom = resources();
    if (options.mode === "preflight") {
      phase = "preflight_identity";
      validateBefore(); envMetadata(); configHashes();
      console.log(JSON.stringify({ status: "preflight", resources: headroom, imageId: OLD_ID, sourceRevision: SOURCE_REVISION, baseRevision: BASE_REVISION, productionUnchanged: true }));
      return;
    }
    if (options.mode === "apply" || options.mode === "rollback") {
      lockFd = openSync(LOCK, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const stat = fstatSync(lockFd); lockIdentity = { dev: stat.dev, ino: stat.ino };
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); fsyncSync(lockFd);
    } else assert.ok(!existsSync(LOCK), "A release owns the deployment lock");
    metadata = envMetadata(); original = readEnvironmentBytes(metadata);
    phase = "runtime_identity";
    if (options.mode === "rollback") {
      rollbackMode = true;
      const record = readRecord(options.recordDir);
      recordDir = options.recordDir;
      before = inspect(); candidateId = record.candidateImageId;
      assert.ok((before.Image === candidateId && before.Config.Image === CANDIDATE) ||
        (before.Image === OLD_ID && before.Config.Image === OLD_PIN), "Rollback runtime is not owned by this release");
      assert.deepEqual(metadata, record.environmentMetadata); assert.deepEqual(configHashes(), record.configHashes);
      assert.deepEqual(invariant(before), record.runtimeInvariant);
      assert.deepEqual(before.Config.Labels?.["com.docker.compose.project.config_files"]?.split(","), FILES);
      assert.equal(inspectImage(PROTECTED_OLD).Id, OLD_ID); assert.equal(inspectImage(OLD_PIN).Id, OLD_ID);
      assert.ok([record.candidateEnvironmentSha256, record.originalEnvironmentSha256].includes(sha(original)));
      const currentPin = imageLine(original).value;
      assert.ok(currentPin === CANDIDATE || currentPin === OLD_PIN);
      planned = currentPin === CANDIDATE ? imagePinPatchPlan(original, CANDIDATE, OLD_PIN) : imagePinPatchPlan(original, OLD_PIN, CANDIDATE);
      assert.equal(planned.nonImageSha256, record.nonImageSha256);
      const restore = currentPin === CANDIDATE ? planned.nextBytes : original;
      assert.equal(sha(restore), record.originalEnvironmentSha256);
      validateConfigRuntime(config(currentPin), before, currentPin);
      otherBefore = others(); files = record.configHashes; baseline = record.runtimeInvariant;
      phase = "rollback_compare_and_swap";
      resources(); assert.deepEqual(configHashes(), files);
      const current = inspect();
      assert.equal(current.Id, before.Id); assert.equal(current.Image, before.Image); assert.equal(current.Config.Image, before.Config.Image);
      assert.deepEqual(invariant(current), baseline);
      assert.equal(sha(readEnvironmentBytes(metadata)), sha(original)); assert.deepEqual(others(), otherBefore);
      assert.equal(inspectImage(OLD_PIN).Id, OLD_ID); assert.equal(inspectImage(PROTECTED_OLD).Id, OLD_ID);
      if (currentPin === CANDIDATE) replaceImagePinInPlace(ENV_FILE, original, restore, metadata);
      phase = "rollback_recreate";
      assert.equal(inspectImage(OLD_PIN).Id, OLD_ID); assert.equal(inspectImage(PROTECTED_OLD).Id, OLD_ID);
      up(OLD_PIN);
      const restored = await healthy(OLD_ID);
      assert.deepEqual(invariant(restored), baseline); assert.deepEqual(configHashes(), files); assert.deepEqual(others(), otherBefore);
      assert.equal(sha(readEnvironmentBytes(metadata)), record.originalEnvironmentSha256); assert.deepEqual(envMetadata(), metadata);
      console.log(JSON.stringify({ status: "rolled_back", imageId: OLD_ID, originalEnvironmentVerified: true, onlySdaChanged: true, sourceRevision: SOURCE_REVISION }));
      return;
    }
    before = validateBefore(); baseline = invariant(before); otherBefore = others(); files = configHashes();
    planned = imagePinPatchPlan(original, OLD_PIN, CANDIDATE);
    phase = "compose_identity";
    const oldConfig = config(OLD_PIN); validateConfigRuntime(oldConfig, before, OLD_PIN);
    const candidateConfig = config(CANDIDATE); assert.equal(candidateConfig.services[SERVICE].image, CANDIDATE);
    candidateConfig.services[SERVICE].image = OLD_PIN; assert.deepEqual(candidateConfig, oldConfig);
    phase = "candidate_identity";
    const identity = candidateIdentity(before); candidateId = identity.candidateId;
    assert.equal(sha(readEnvironmentBytes(metadata)), planned.originalSha256); assert.deepEqual(envMetadata(), metadata);
    assert.deepEqual(configHashes(), files); assert.equal(inspect().Id, before.Id); assert.deepEqual(others(), otherBefore);
    if (options.mode === "check") {
      console.log(JSON.stringify({ status: "checked", productionUnchanged: true, sourceRevision: SOURCE_REVISION, baseRevision: BASE_REVISION,
        candidateImageId: candidateId, unchangedRuntimeTreeSha256: identity.unchangedTreeSha256,
        immutableBaseLayersVerified: identity.exactRuntimeBaseVerified, offlineFilesystemContentAndPosixMetadataVerified: true,
        extendedAttributeAndLayerMetadataAcceptancePending: true, pureFixturePassed: true }));
      return;
    }
    phase = "metadata_record";
    privateDirectory(BACKUPS, true);
    const directory = `${BACKUPS}/${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
    privateDirectory(directory, true); recordDir = directory;
    privateRecord(`${recordDir}/before.json`, {
      schemaVersion: "sim-search-freshness-image-only/v2", sourceRevision: SOURCE_REVISION, baseRevision: BASE_REVISION,
      oldPin: OLD_PIN, candidatePin: CANDIDATE, oldImageId: OLD_ID, candidateImageId: candidateId,
      originalEnvironmentSha256: planned.originalSha256, candidateEnvironmentSha256: planned.nextSha256,
      nonImageSha256: planned.nonImageSha256, environmentMetadata: metadata, configHashes: files,
      runtimeInvariant: baseline, unchangedTreeSha256: identity.unchangedTreeSha256,
      unchangedRootFilesystemSha256: identity.unchangedRootFilesystemSha256, immutableBaseLayersSha256: identity.immutableBaseLayersSha256
    });
    privateRecord(`${recordDir}/rollback-instructions.json`, {
      noEnvironmentCopies: true, noEnvironmentRewrite: true, noImageTagMutation: true,
      instructions: "After confirming no owner is running, invoke this same reviewed script with --rollback --record-dir and the five exact pinned arguments. It checks private metadata, full-byte CAS, inode, config, current runtime and protected old image, edits only the same-width image bytes, and recreates only SDA. Never use shell writers or copy .env. An unverified/partial write requires manual coordination without recreation."
    });
    phase = "activation_compare_and_swap";
    resources(); assert.deepEqual(envMetadata(), metadata); assert.equal(sha(readEnvironmentBytes(metadata)), planned.originalSha256);
    assert.deepEqual(configHashes(), files); const current = inspect(); assert.equal(current.Id, before.Id); assert.deepEqual(invariant(current), baseline);
    assert.deepEqual(others(), otherBefore); assert.equal(inspectImage(CANDIDATE).Id, candidateId);
    assert.equal(inspectImage(OLD_PIN).Id, OLD_ID); assert.equal(inspectImage(PROTECTED_OLD).Id, OLD_ID);
    phase = "activation_image_pin";
    replaceImagePinInPlace(ENV_FILE, original, planned.nextBytes, metadata); written = true;
    phase = "activation_recreate"; up(CANDIDATE);
    phase = "acceptance";
    const after = await healthy(candidateId);
    assert.deepEqual(invariant(after), baseline); assert.deepEqual(others(), otherBefore); assert.deepEqual(configHashes(), files);
    assert.equal(sha(readEnvironmentBytes(metadata)), planned.nextSha256); assert.deepEqual(envMetadata(), metadata);
    const proof = { status: "success", sourceRevision: SOURCE_REVISION, baseRevision: BASE_REVISION, candidateImageId: candidateId,
      onlySdaChanged: true, runtimeInvariantsPreserved: true, environmentInodePreserved: true, environmentNonImageBytesPreserved: true,
      immutableBaseLayersVerified: true, offlineFilesystemContentAndPosixMetadataVerified: true,
      pureFixturePassed: true, authenticatedApiAcceptancePending: true, recordDir };
    privateRecord(`${recordDir}/after.json`, proof); console.log(JSON.stringify(proof));
  } catch (error) {
    unverifiedWrite = error?.code === "ENV_WRITE_UNVERIFIED";
    let rollback = unverifiedWrite || rollbackMode ? "requires_attention" : "not_needed";
    if (written && !unverifiedWrite && !rollbackMode) {
      try {
        const current = inspect(), bytes = readEnvironmentBytes(metadata);
        assert.ok((current.Image === candidateId && current.Config.Image === CANDIDATE) ||
          (current.Image === OLD_ID && current.Config.Image === OLD_PIN), "Automatic rollback runtime is not owned by this release");
        assert.ok(sha(bytes) === planned.nextSha256 || sha(bytes) === planned.originalSha256);
        assert.deepEqual(envMetadata(), metadata); assert.deepEqual(configHashes(), files);
        assert.deepEqual(invariant(current), baseline); assert.deepEqual(others(), otherBefore);
        assert.equal(inspectImage(OLD_PIN).Id, OLD_ID); assert.equal(inspectImage(PROTECTED_OLD).Id, OLD_ID);
        if (sha(bytes) === planned.nextSha256) replaceImagePinInPlace(ENV_FILE, bytes, original, metadata);
        assert.equal(inspectImage(OLD_PIN).Id, OLD_ID); assert.equal(inspectImage(PROTECTED_OLD).Id, OLD_ID);
        up(OLD_PIN); const restored = await healthy(OLD_ID);
        assert.deepEqual(invariant(restored), baseline); assert.deepEqual(configHashes(), files); assert.deepEqual(others(), otherBefore);
        assert.equal(sha(readEnvironmentBytes(metadata)), planned.originalSha256); assert.deepEqual(envMetadata(), metadata);
        rollback = "verified_original_healthy";
      } catch { rollback = "requires_attention"; }
    }
    console.log(JSON.stringify({ status: "failed", phase, error: "Deployment guard failed; private diagnostics suppressed.", rollback,
      environmentWriteUnverified: unverifiedWrite, noUnsafeEnvironmentRewrite: true, ...(recordDir ? { recordDir } : {}) })); process.exitCode = 1;
  } finally {
    if (lockFd !== undefined) {
      try { closeSync(lockFd); } finally {
        try { const stat = lstatSync(LOCK); if (stat.dev === lockIdentity?.dev && stat.ino === lockIdentity?.ino) unlinkSync(LOCK); } catch { /* Never delete a replaced/foreign lock. */ }
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
