#!/usr/bin/env node
// One-off deployment transition only. Stop situation-data-api before invoking.
// Reads/writes quota metadata, never provider records, secrets, or network I/O.
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FEEDS = ["static", "dynamic", "tec"];
const CACHE_DIR = "/valhalla-traffic-cache";
const FILE = "provider-request-timing.json";
const MINIMUM_MS = 300000;

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
}

export function seededTiming(existing, now) {
  if (!validTimestamp(now) || !validTimestamp(now + MINIMUM_MS)) throw new Error("Invalid seed clock");
  if (existing !== undefined) {
    if (!existing || typeof existing !== "object" || Array.isArray(existing) || existing.version !== 1 ||
        Object.keys(existing).some((key) => !["version", ...FEEDS].includes(key))) {
      throw new Error("Invalid existing request timing schema");
    }
    for (const name of FEEDS) {
      const entry = existing[name];
      if (entry !== undefined && (!entry || typeof entry !== "object" || Array.isArray(entry) ||
          Object.keys(entry).length !== 1 || !Object.hasOwn(entry, "nextAttemptAtMs") ||
          !validTimestamp(entry.nextAttemptAtMs))) {
        throw new Error("Invalid existing request timing feed");
      }
    }
  }
  return { version: 1, ...Object.fromEntries(FEEDS.map((name) => [name, {
    nextAttemptAtMs: Math.max(existing?.[name]?.nextAttemptAtMs ?? 0, now + MINIMUM_MS)
  }])) };
}

export async function seedRequestTiming(directory, clock = Date.now) {
  if (!isAbsolute(directory) || resolve(directory) !== directory || await realpath(directory) !== directory) {
    throw new Error("Request timing directory must be an existing absolute non-symlink path");
  }
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Invalid request timing directory");
  const path = join(directory, FILE);
  let existing;
  let original;
  try {
    original = await lstat(path);
    if (!original.isFile() || original.isSymbolicLink() || original.size > 4096) throw new Error("Invalid existing request timing file");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.ino !== original.ino || opened.dev !== original.dev) throw new Error("Existing request timing changed during read");
      existing = JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (original !== undefined) throw new Error("Existing request timing disappeared during read");
  }
  const value = seededTiming(existing, clock());
  const temporary = `${path}.seed-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    let current;
    try { current = await lstat(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if ((original === undefined) !== (current === undefined) ||
        (original && (current.ino !== original.ino || current.dev !== original.dev ||
          current.size !== original.size || current.mtimeMs !== original.mtimeMs))) {
      throw new Error("Request timing was modified by another process; stop all writers before seeding");
    }
    await rename(temporary, path);
    const parent = await open(directory, constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  const result = await lstat(path);
  if ((result.mode & 0o777) !== 0o600 || result.uid !== process.getuid()) throw new Error("Request timing permission verification failed");
  return { ...value, uid: result.uid, mode: "600" };
}

async function main() {
  if ((process.env.VALHALLA_TRAFFIC_CACHE_DIR ?? CACHE_DIR) !== CACHE_DIR) throw new Error("Unexpected production traffic cache path");
  // Compose must bind the cache at precisely this target; never create it on
  // the container layer. Host-side findmnt UUID verification is still required.
  const mounts = await readFile("/proc/self/mountinfo", "utf8");
  if (!mounts.split("\n").some((line) => line.split(" ")[4] === CACHE_DIR)) throw new Error("Traffic cache is not a separate container mount");
  const result = await seedRequestTiming(CACHE_DIR);
  process.stdout.write(`${JSON.stringify({ gateSeeded: true, ...result })}\n`);
}

if (process.argv[1] === "-" || (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)) {
  main().catch(() => {
    process.stderr.write("Provider timing seed failed; do not start the new service. Verify the mount, existing timing schema and permissions.\n");
    process.exitCode = 1;
  });
}
