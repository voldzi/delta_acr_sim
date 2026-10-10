#!/usr/bin/env node
// Patch the already-mounted authoritative gateway file, preserving divergent routes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = "/srv/sim";
const gatewayPath = resolve(runtimeDir, "apps/simulator-web/nginx/default.conf");
const run = (bin, args) => execFileSync(bin, args, { cwd: runtimeDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const docker = (...args) => run("docker", args);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const anchor = "  location /safety-data/api/ {";
const marker = "  # Read-time decisions must never reuse a cached readiness/age response.";

export function patchGateway(runtime, authoritative) {
  const start = authoritative.indexOf(marker);
  const end = authoritative.indexOf(anchor, start);
  if (start < 0 || end < start) throw new Error("Authoritative freshness blocks are missing.");
  const blocks = authoritative.slice(start, end);
  if (runtime.split(anchor).length !== 2) throw new Error("Expected unique safety route anchor is missing.");
  const alreadyPatched = runtime.includes(blocks);
  const outsideBlocks = alreadyPatched ? runtime.replace(blocks, "") : runtime;
  if (/location = \/safety-data\/api\/v1\/(notifications\/candidates|context\/news)/.test(outsideBlocks))
    throw new Error("Unexpected existing decision route; refusing overwrite.");
  if (alreadyPatched) return runtime;
  return runtime.replace(anchor, blocks + anchor);
}

function preflight() {
  const mount = JSON.parse(run("findmnt", ["--json", "--target", "/srv/x5-production", "--output", "TARGET,UUID"]))?.filesystems?.[0];
  if (mount?.target !== "/srv/x5-production" || mount?.uuid !== "2f93f595-b61b-4eea-9054-7afa9b275b5b")
    throw new Error("Expected X5 mount is not present; no changes made.");
  for (const path of [runtimeDir, "/srv/x5-production"]) {
    const free = Number(run("df", ["-B1", "--output=avail", path]).trim().split("\n").at(-1));
    if (!Number.isFinite(free) || free < 5 * 1024 ** 3) throw new Error("Less than 5 GiB free; no changes made.");
  }
  const stat = lstatSync(gatewayPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unexpected gateway source file.");
  const state = JSON.parse(docker("inspect", "csm-sim-web"))[0];
  if (!state.State.Running || state.State.Health?.Status !== "healthy") throw new Error("Current gateway is not healthy.");
  const bound = state.Mounts.find((item) => item.Destination === "/etc/nginx/conf.d/default.conf");
  if (bound?.Type !== "bind" || bound.Source !== gatewayPath || bound.RW !== false)
    throw new Error("Expected authoritative read-only config bind is missing; no changes made.");
  return { ...state, configDevice: stat.dev, configInode: stat.ino };
}

function acceptance() {
  // Read via an existing internal service, so the same real-IP allowlist is exercised.
  const code = `
    const base="http://sim-web";
    const paths=["/safety-data/api/v1/notifications/candidates?source=hzs_incidents&bbox=15.05,49.45,16.95,50.85&limit=100","/safety-data/api/v1/context/news"];
    const proof=[];
    for(const path of paths){
      let prior;
      for(let i=0;i<2;i++){
        const r=await fetch(base+path,{signal:AbortSignal.timeout(30000)});
        const j=await r.json();const now=Date.now();
        if(r.status!==200||r.headers.get("cache-control")!=="no-store, max-age=0"||r.headers.get("x-sim-gateway-cache")!=="BYPASS"||r.headers.get("pragma")!=="no-cache")throw Error("uncached request rejected");
        const generated=Date.parse(j.generatedAt);
        if(!Number.isFinite(generated)||Math.abs(now-generated)>5000)throw Error("response timestamp invalid or stale");
        if(path.includes("candidates")){
          const s=j.inputReadiness;
          if(!s||!["ready","unavailable","incomplete"].includes(s.status)||!Array.isArray(s.reasons)||!Array.isArray(j.candidates))throw Error("readiness invalid");
          if(s.snapshotAgeSeconds!==null){
            const snapshot=Date.parse(s.snapshotGeneratedAt);
            if(!Number.isFinite(snapshot)||!Number.isFinite(s.snapshotAgeSeconds)||s.snapshotAgeSeconds<0||Math.abs(Math.max(0,now-snapshot)-s.snapshotAgeSeconds*1000)>2000)throw Error("age invalid or inaccurate");
          }
          if(s.status==="ready"&&s.snapshotAgeSeconds===null)throw Error("ready snapshot without age");
          if(s.status!=="ready"&&j.candidates.length!==0)throw Error("unready candidates exposed");
          if(prior&&s.snapshotGeneratedAt===prior.inputReadiness.snapshotGeneratedAt&&!(s.snapshotAgeSeconds>prior.inputReadiness.snapshotAgeSeconds))throw Error("age frozen");
        }
        if(prior&&prior.generatedAt===j.generatedAt)throw Error("decision reused");
        proof.push({kind:path.includes("candidates")?"candidates":"news",status:r.status,cache:r.headers.get("x-sim-gateway-cache"),generatedAt:j.generatedAt,readiness:j.inputReadiness??null});
        prior=j;await new Promise(d=>setTimeout(d,350));
      }
      const denied=await fetch(base+path,{headers:{"X-Forwarded-For":"203.0.113.10"},signal:AbortSignal.timeout(10000)});
      if(denied.status!==403)throw Error("public source not denied");
      proof.push({kind:"public-source-denied",status:denied.status});
    }
    for(const path of ["/api/v1/scenarios","/api/v1/ai/router-admin"]){
      const denied=await fetch(base+path,{signal:AbortSignal.timeout(10000)});
      if(denied.status!==401)throw Error("private operation authentication changed");
      proof.push({kind:"private-auth-denied",status:denied.status});
    }
    console.log(JSON.stringify(proof));
  `;
  return JSON.parse(docker("exec", "csm-sim-api", "node", "--input-type=module", "-e", code));
}

async function main() {
  const args = process.argv.slice(2);
  const revision = args[args.indexOf("--revision") + 1];
  if (args[0] !== "--deploy" || !/^[a-f0-9]{40}$/.test(revision ?? "")) throw new Error("Expected --deploy --revision <tested full commit>.");
  if (sourceDir === runtimeDir || run("git", ["-C", sourceDir, "rev-parse", "HEAD"]).trim() !== revision)
    throw new Error("Use an isolated tested revision checkout.");
  if (run("git", ["-C", sourceDir, "status", "--porcelain", "--untracked-files=all"]).trim()) throw new Error("Build checkout is not clean.");
  const state = preflight();
  const old = readFileSync(gatewayPath, "utf8");
  const authoritative = readFileSync(resolve(sourceDir, "apps/simulator-web/nginx/default.conf"), "utf8");
  const next = patchGateway(old, authoritative);
  const backup = resolve(runtimeDir, ".deploy-crisis-backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-gateway-${revision.slice(0, 12)}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  chmodSync(dirname(backup), 0o700);
  copyFileSync(gatewayPath, resolve(backup, "default.conf"));
  chmodSync(resolve(backup, "default.conf"), 0o600);
  writeFileSync(
    resolve(backup, "evidence.json"),
    JSON.stringify({ revision, containerId: state.Id, imageId: state.Image, oldSha: sha(old), newSha: sha(next) }),
    { mode: 0o600 }
  );
  const beforeWrite = preflight();
  if (beforeWrite.Id !== state.Id || beforeWrite.configDevice !== state.configDevice || beforeWrite.configInode !== state.configInode)
    throw new Error("Gateway or mounted inode changed; no activation made.");
  if (readFileSync(gatewayPath, "utf8") !== old) throw new Error("Gateway changed during preflight; no activation made.");
  try {
    // Preserve the mounted inode: an atomic rename would leave the container on its old bind.
    writeFileSync(gatewayPath, next);
    docker("exec", "csm-sim-web", "nginx", "-t");
    docker("exec", "csm-sim-web", "nginx", "-s", "reload");
    await new Promise((done) => setTimeout(done, 1000));
    const proof = acceptance();
    const after = preflight();
    if (after.Id !== state.Id || after.Image !== state.Image) throw new Error("Gateway identity unexpectedly changed.");
    const bound = docker("exec", "csm-sim-web", "sha256sum", "/etc/nginx/conf.d/default.conf").trim().split(/\s+/)[0];
    if (bound !== sha(next)) throw new Error("Mounted config hash differs.");
    console.log(JSON.stringify({ revision, gatewayContainerId: state.Id, imageId: state.Image, configSha256: bound, proof, privateRollbackDirectory: backup }));
  } catch {
    writeFileSync(gatewayPath, old);
    docker("exec", "csm-sim-web", "nginx", "-t");
    docker("exec", "csm-sim-web", "nginx", "-s", "reload");
    throw new Error("Gateway acceptance failed; old mounted config restored and reloaded. Check health separately.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message.startsWith("Command failed") ? "Gateway command failed; output suppressed to protect configuration." : error.message);
    process.exitCode = 1;
  });
}
