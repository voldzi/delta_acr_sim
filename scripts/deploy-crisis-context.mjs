#!/usr/bin/env node
// Targeted deployment: never copy a whole Compose file over a divergent pilot checkout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDir = "/srv/sim";
const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeArgs = ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.x5.yml"];
const run = (bin, args, cwd = runtimeDir) => execFileSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
const docker = (...args) => run("docker", args);
const compose = (...args) => docker(...composeArgs, ...args);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function patchCompose(text) {
  const start = text.indexOf("\n  safety-data-api:\n");
  if (start < 0) throw new Error("Expected safety-data-api service was not found.");
  // Find the next two-space service key, not an indented field.
  const match = /^  [a-z][a-z0-9-]*:\s*$/m.exec(text.slice(start + 1 + "  safety-data-api:\n".length));
  const boundary = match ? start + 1 + "  safety-data-api:\n".length + match.index : text.length;
  let block = text.slice(start, boundary);
  if (/^    image:/m.test(block)) {
    if (!block.includes("image: ${SIM_SAFETY_DATA_IMAGE:-sim-safety-data-api}")) throw new Error("Unexpected existing safety image configuration.");
  } else {
    block = block.replace("  safety-data-api:\n", "  safety-data-api:\n    image: ${SIM_SAFETY_DATA_IMAGE:-sim-safety-data-api}\n");
  }
  if (!/^      MUNICIPAL_ALERTS_CACHE_TTL_SECONDS:/m.test(block)) throw new Error("Expected safety environment anchor was not found.");
  for (const [key, fallback] of [
    ["MEDIA_NEWS_ENABLED", "false"],
    ["MEDIA_NEWS_REQUEST_TIMEOUT_MS", "8000"]
  ]) {
    const expected = `      ${key}: \${${key}:-${fallback}}`;
    if (new RegExp(`^      ${key}:`, "m").test(block)) {
      if (!block.includes(expected)) throw new Error(`Unexpected ${key} configuration.`);
    } else block = block.replace(/(      MUNICIPAL_ALERTS_CACHE_TTL_SECONDS:[^\n]*\n)/, `$1${expected}\n`);
  }
  return text.slice(0, start) + block + text.slice(boundary);
}

export function patchEnvironment(text, image, imageOnly = false) {
  if (imageOnly) {
    if (text.split("\n").filter((line) => line.startsWith("SIM_SAFETY_DATA_IMAGE=")).length !== 1)
      throw new Error("Image-only deployment requires one existing image selection.");
    return text.replace(/^SIM_SAFETY_DATA_IMAGE=.*$/m, `SIM_SAFETY_DATA_IMAGE=${image}`);
  }
  const sources = text
    .split("\n")
    .filter((line) => line.startsWith("SAFETY_DATA_ENABLED_SOURCES="))
    .at(-1)
    ?.split("=")
    .slice(1)
    .join("=");
  if (!sources || !/^[a-z_,]+$/.test(sources)) throw new Error("Expected explicit enabled safety sources are missing or invalid.");
  const values = {
    SAFETY_DATA_ENABLED_SOURCES: [...new Set([...sources.split(","), "municipal_alerts"])].join(","),
    MEDIA_NEWS_ENABLED: "true",
    MEDIA_NEWS_REQUEST_TIMEOUT_MS: "8000",
    SIM_SAFETY_DATA_IMAGE: image
  };
  let updated = text;
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${key}=.*(?:\\n|$)`, "gm");
    updated = updated.replace(pattern, "");
    if (!updated.endsWith("\n")) updated += "\n";
    updated += `${key}=${value}\n`;
  }
  return updated;
}

function preflight() {
  const mount = JSON.parse(run("findmnt", ["--json", "--target", "/srv/x5-production", "--output", "TARGET,UUID"]))?.filesystems?.[0];
  if (mount?.target !== "/srv/x5-production" || mount?.uuid !== "2f93f595-b61b-4eea-9054-7afa9b275b5b")
    throw new Error("Expected X5 mount is not present; no changes made.");
  for (const path of [runtimeDir, "/srv/x5-production"]) {
    const free = Number(run("df", ["-B1", "--output=avail", path]).trim().split("\n").at(-1));
    if (!Number.isFinite(free) || free < 5 * 1024 ** 3) throw new Error("Less than 5 GiB free; no changes made.");
  }
  for (const name of [".env", "docker-compose.yml"]) {
    const stat = lstatSync(resolve(runtimeDir, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unexpected runtime configuration file.");
    if (name === ".env" && (stat.mode & 0o777) !== 0o600) throw new Error("Runtime secrets file must have mode 600.");
  }
  const state = JSON.parse(docker("inspect", "csm-sim-safety-data-api"))[0];
  if (!state.State.Running || state.State.Health?.Status !== "healthy" || Object.keys(state.HostConfig.PortBindings ?? {}).length)
    throw new Error("Current safety service must be healthy with no published ports.");
  return state.Image;
}

async function acceptance() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const state = JSON.parse(docker("inspect", "csm-sim-safety-data-api"))[0];
    if (state.State.Running && state.State.Health?.Status === "healthy") {
      const proof = JSON.parse(
        docker(
          "exec",
          "csm-sim-safety-data-api",
          "node",
          "--input-type=module",
          "-e",
          'const h=await fetch("http://127.0.0.1:4030/health/ready",{signal:AbortSignal.timeout(15000)});const j=await h.json();const r=await fetch("http://127.0.0.1:4030/api/v1/context/news",{signal:AbortSignal.timeout(15000)});const n=await r.json();console.log(JSON.stringify({healthy:h.ok,municipal:j.enabledSources?.includes("municipal_alerts"),mediaEnabled:j.mediaNews?.enabled,newsOk:r.ok,contract:n.contractVersion,sourcesOk:n.sources?.every(s=>s.status==="ok"),bounded:n.items?.length<=100,informational:n.items?.every(i=>i.location===null&&i.eventAt===null&&i.notificationEligible===false)}));'
        )
      );
      if (
        !proof.healthy ||
        !proof.municipal ||
        !proof.mediaEnabled ||
        !proof.newsOk ||
        !proof.sourcesOk ||
        !proof.bounded ||
        !proof.informational ||
        proof.contract !== "sim-crisis-media-context-v1"
      ) {
        console.log(JSON.stringify({ acceptanceRejected: proof }));
        throw new Error("Live news/health acceptance failed.");
      }
      return proof;
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error("Safety service did not become healthy.");
}

async function main() {
  const args = process.argv.slice(2);
  const imageOnly = args.includes("--image-only");
  const revision = args[args.indexOf("--revision") + 1];
  if (args[0] !== "--deploy" || !/^[a-f0-9]{40}$/.test(revision ?? ""))
    throw new Error("Usage: node scripts/deploy-crisis-context.mjs --deploy --revision <full-tested-commit>");
  if (sourceDir === runtimeDir) throw new Error("Build from an isolated revision checkout, never from the secrets-bearing runtime directory.");
  if (run("git", ["rev-parse", "HEAD"], sourceDir).trim() !== revision) throw new Error("Source checkout does not match tested revision.");
  run("git", ["diff", "--quiet", "HEAD", "--", "apps/safety-data-api", "packages/observability", "package.json", "pnpm-lock.yaml"], sourceDir);
  if (run("git", ["status", "--porcelain", "--untracked-files=all"], sourceDir).trim()) throw new Error("Isolated build checkout must be completely clean.");
  const oldImage = preflight();
  const image = `sim-safety-data-api:crisis-${revision.slice(0, 12)}`;
  const before = JSON.parse(compose("config", "--format", "json"));
  const envPath = resolve(runtimeDir, ".env");
  const composePath = resolve(runtimeDir, "docker-compose.yml");
  const oldEnv = readFileSync(envPath, "utf8");
  const oldCompose = readFileSync(composePath, "utf8");
  const oldX5Compose = readFileSync(resolve(runtimeDir, "docker-compose.x5.yml"), "utf8");
  const newEnv = patchEnvironment(oldEnv, image, imageOnly);
  const newCompose = imageOnly ? oldCompose : patchCompose(oldCompose);
  console.log("Preflight OK; building only the safety-data-api image.");
  execFileSync("docker", ["build", "--label", `org.opencontainers.image.revision=${revision}`, "-t", image, "-f", "apps/safety-data-api/Dockerfile", "."], {
    cwd: sourceDir,
    stdio: "inherit"
  });
  preflight();
  if (
    readFileSync(envPath, "utf8") !== oldEnv ||
    readFileSync(composePath, "utf8") !== oldCompose ||
    readFileSync(resolve(runtimeDir, "docker-compose.x5.yml"), "utf8") !== oldX5Compose
  )
    throw new Error("Runtime configuration changed during the build; no activation performed.");
  const backup = resolve(runtimeDir, ".deploy-crisis-backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-${revision.slice(0, 12)}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  chmodSync(dirname(backup), 0o700);
  copyFileSync(envPath, resolve(backup, ".env"));
  chmodSync(resolve(backup, ".env"), 0o600);
  copyFileSync(composePath, resolve(backup, "docker-compose.yml"));
  writeFileSync(
    resolve(backup, "evidence.json"),
    JSON.stringify(
      {
        revision,
        oldImage,
        image,
        otherServices: Object.fromEntries(
          Object.entries(before.services)
            .filter(([key]) => key !== "safety-data-api")
            .map(([key, value]) => [key, hash(value)])
        )
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  let activationStage = "configuration_validation";
  try {
    writeFileSync(envPath, newEnv, { mode: 0o600 });
    writeFileSync(composePath, newCompose);
    const after = JSON.parse(compose("config", "--format", "json"));
    if (imageOnly) {
      const previousSafety = { ...before.services["safety-data-api"] };
      const nextSafety = { ...after.services["safety-data-api"] };
      delete previousSafety.image;
      delete nextSafety.image;
      if (hash(previousSafety) !== hash(nextSafety)) throw new Error("Image-only deployment would change Safety configuration.");
      if (after.services["safety-data-api"].image !== image) throw new Error("Image selection is not authoritative in runtime Compose.");
    }
    for (const [key, value] of Object.entries(before.services)) {
      if (key !== "safety-data-api" && hash(value) !== hash(after.services[key]))
        throw new Error("An unrelated service configuration would change; refusing activation.");
    }
    activationStage = "service_start";
    compose("up", "-d", "--no-deps", "--no-build", "safety-data-api");
    activationStage = "live_acceptance";
    const proof = await acceptance();
    const state = JSON.parse(docker("inspect", "csm-sim-safety-data-api"))[0];
    if (Object.keys(state.HostConfig.PortBindings ?? {}).length) throw new Error("Unexpected published safety port.");
    console.log(JSON.stringify({ revision, image, imageId: state.Image, healthy: true, proof, privateRollbackDirectory: backup }));
  } catch {
    // Never emit command stderr/config or secret-bearing environment in an error.
    writeFileSync(envPath, oldEnv, { mode: 0o600 });
    writeFileSync(composePath, oldCompose);
    docker("tag", oldImage, before.services["safety-data-api"].image ?? "sim-safety-data-api");
    compose("up", "-d", "--no-deps", "--no-build", "safety-data-api");
    throw new Error(`Activation failed at ${activationStage}; previous configuration and safety image restored. Check health separately.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      error instanceof Error && !error.message.startsWith("Command failed")
        ? error.message
        : "Deployment failed; command output suppressed to protect configuration."
    );
    process.exitCode = 1;
  });
}
