/** Finite new TEST reset scope. Caller must use actual Root reset admission.
 * Never traverses provider caches, configs, other projects or owned v1 paths. */
import {
  lstatSync,
  realpathSync,
  readFileSync,
  openSync,
  closeSync,
  fsyncSync,
  constants,
  renameSync,
  statfsSync,
  writeFileSync,
  unlinkSync,
  fchownSync,
  fchmodSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withResetWork } from "./clean-reset-admission.mjs";
const BASE = "/srv/x5-production/data/csm-sim/sim-data",
  UUID = "2f93f595-b61b-4eea-9054-7afa9b275b5b";
const sha = (x) => createHash("sha256").update(x).digest("hex");
const need = (v) => {
  if (!v) throw Error("SIM_APP_RESET_UNPROVEN");
};
function scan(syntheticRoot) {
  const root = syntheticRoot ?? BASE;
  if (syntheticRoot)
    need(/^\/private\/tmp\/sim-app-reset-[^/]+$/.test(root) && lstatSync(root).uid === process.getuid() && (lstatSync(root).mode & 0o777) === 0o700);
  else {
    need(execFileSync("/usr/bin/findmnt", ["-n", "-o", "UUID", "--mountpoint", "/srv/x5-production"], { encoding: "utf8" }).trim() === UUID);
    need(lstatSync("/srv/x5-production").dev !== lstatSync("/").dev);
    const st = statfsSync("/srv/x5-production");
    need(st.bavail * st.bsize >= 104857600);
  }
  need(realpathSync(root) === root && lstatSync(root).isDirectory());
  const entries = [];
  let scenarios = 0,
    drafts = 0,
    publisher = 0,
    auditBytes = 0;
  for (const name of ["sim-store.json", "publisher-queue.json", "sim-audit.jsonl"]) {
    const path = join(root, name),
      s = lstatSync(path);
    need(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === lstatSync(root).uid && s.size <= 134217728);
    const raw = readFileSync(path);
    let replacement;
    if (name === "sim-audit.jsonl") {
      auditBytes = s.size;
      replacement = "";
    } else {
      const x = JSON.parse(raw.toString("utf8"));
      if (name === "sim-store.json") {
        need(
          Object.keys(x).sort().join(",") === "aiConfig,drafts,runtime,scenarios" &&
            Array.isArray(x.scenarios) &&
            Array.isArray(x.drafts) &&
            x.aiConfig &&
            typeof x.aiConfig === "object"
        );
        need(
          Object.keys(x.aiConfig).sort().join(",") === "externalProviderAllowed,providerMode" &&
            typeof x.aiConfig.externalProviderAllowed === "boolean" &&
            ["openai", "codex", "local", "mock", "auto"].includes(x.aiConfig.providerMode)
        );
        scenarios = x.scenarios.length;
        drafts = x.drafts.length;
        replacement = JSON.stringify(
          { ...x, scenarios: [], drafts: [], runtime: { state: "STOPPED", generatedEvents: 0, publishedEvents: 0, queuedEvents: 0 } },
          null,
          2
        );
      } else {
        need(Object.keys(x).sort().join(",") === "items,publishingEnabled" && Array.isArray(x.items) && typeof x.publishingEnabled === "boolean");
        publisher = x.items.length;
        replacement = JSON.stringify({ items: [], publishingEnabled: x.publishingEnabled });
      }
    }
    entries.push({ name, path, ino: s.ino, mode: s.mode & 0o777, uid: s.uid, gid: s.gid, size: s.size, digest: sha(raw), replacement });
  }
  return { root, entries, counts: { scenarios, drafts, publisher, auditBytes }, digest: sha(JSON.stringify(entries.map(({ replacement, path, ...e }) => e))) };
}
export function inspectSimAppReset({ syntheticRoot } = {}) {
  const s = scan(syntheticRoot);
  return { contractVersion: "sim-app-test-reset-v2", root: s.root, planDigest: s.digest, counts: s.counts, wholeAccountComplete: false };
}
export async function resetSimAppFiles({ syntheticRoot, reviewedPlan, rootGate, expectedMainImage, inspectMain }) {
  need(reviewedPlan?.contractVersion === "sim-app-test-reset-v2" && /^sha256:[a-f0-9]{64}$/.test(expectedMainImage ?? "") && typeof inspectMain === "function");
  const stopped = async () => {
    const x = await inspectMain("csm-sim-api");
    need(
      x.Name === "/csm-sim-api" && x.Image === expectedMainImage && x.State?.Running === false && x.State?.Restarting === false && x.State?.Status === "exited"
    );
  };
  return withResetWork(rootGate, { contractVersion: reviewedPlan.contractVersion, planDigest: reviewedPlan.planDigest }, async (admission, assertOpen) => {
    await admission.assertCurrent();
    await stopped();
    assertOpen();
    let s = scan(syntheticRoot);
    need(s.root === reviewedPlan.root && s.digest === reviewedPlan.planDigest);
    for (const e of s.entries) {
      assertOpen();
      await admission.assertCurrent();
      await stopped();
      const current = scan(syntheticRoot).entries.find((x) => x.name === e.name);
      need(current?.digest === e.digest && current.ino === e.ino);
      const temp = join(s.root, ".sim-reset-" + randomUUID());
      try {
        writeFileSync(temp, e.replacement, { flag: "wx", mode: e.mode });
        const fd = openSync(temp, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          fchownSync(fd, e.uid, e.gid);
          fchmodSync(fd, e.mode);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        need(lstatSync(temp).uid === e.uid && lstatSync(temp).gid === e.gid);
        renameSync(temp, e.path);
        const d = openSync(s.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          fsyncSync(d);
        } finally {
          closeSync(d);
        }
      } finally {
        try {
          unlinkSync(temp);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      }
    }
    assertOpen();
    await admission.assertCurrent();
    await stopped();
    s = scan(syntheticRoot);
    need(Object.values(s.counts).every((n) => n === 0));
    return { contractVersion: reviewedPlan.contractVersion, remaining: s.counts, wholeAccountComplete: false };
  });
}
