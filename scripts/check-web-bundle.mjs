#!/usr/bin/env node
import { createGzip } from "node:zlib";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const distDir = process.argv[2] ?? "apps/simulator-web/dist";
const budgets = {
  cssGzipBytes: numberFromEnv("SIM_WEB_CSS_GZIP_BUDGET_BYTES", 12 * 1024),
  jsGzipBytes: numberFromEnv("SIM_WEB_JS_GZIP_BUDGET_BYTES", 130 * 1024),
  totalGzipBytes: numberFromEnv("SIM_WEB_TOTAL_GZIP_BUDGET_BYTES", 180 * 1024)
};

const files = await listFiles(distDir);
const assets = await Promise.all(
  files
    .filter((file) => /\.(css|js)$/i.test(file))
    .map(async (file) => ({
      file,
      rawBytes: (await stat(file)).size,
      gzipBytes: await gzipSize(file),
      type: file.endsWith(".css") ? "css" : "js"
    }))
);

const jsGzipBytes = sum(assets.filter((asset) => asset.type === "js").map((asset) => asset.gzipBytes));
const cssGzipBytes = sum(assets.filter((asset) => asset.type === "css").map((asset) => asset.gzipBytes));
const totalGzipBytes = jsGzipBytes + cssGzipBytes;
const failures = [
  budgetFailure("JS gzip", jsGzipBytes, budgets.jsGzipBytes),
  budgetFailure("CSS gzip", cssGzipBytes, budgets.cssGzipBytes),
  budgetFailure("Total gzip", totalGzipBytes, budgets.totalGzipBytes)
].filter(Boolean);

console.log(
  JSON.stringify(
    {
      distDir,
      budgets,
      summary: {
        jsGzipBytes,
        cssGzipBytes,
        totalGzipBytes
      },
      assets: assets.map((asset) => ({
        file: asset.file.replace(`${distDir}/`, ""),
        rawBytes: asset.rawBytes,
        gzipBytes: asset.gzipBytes
      }))
    },
    null,
    2
  )
);

if (failures.length > 0) {
  console.error(`Bundle budget exceeded: ${failures.join("; ")}`);
  process.exit(1);
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    })
  );
  return nested.flat();
}

function gzipSize(file) {
  return new Promise((resolve, reject) => {
    let total = 0;
    createReadStream(file)
      .pipe(createGzip({ level: 9 }))
      .on("data", (chunk) => {
        total += chunk.length;
      })
      .on("end", () => resolve(total))
      .on("error", reject);
  });
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function budgetFailure(label, actual, max) {
  return actual > max ? `${label} ${actual} > ${max}` : undefined;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}
