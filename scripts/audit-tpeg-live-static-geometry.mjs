#!/usr/bin/env node
// One-off, aggregate-only provider audit. Never print a token, XML, IDs or coordinates.
import { readFile } from "node:fs/promises";

function count(xml, name) {
  return [...xml.matchAll(new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${name}(?:\\s|>)`, "g"))].length;
}

export function summarize(xml) {
  return {
    bytes: Buffer.byteLength(xml),
    openlrMethods: count(xml, "optionOpenLRLocationReferenceLink"),
    tmcMethods: count(xml, "optionTMCLocationReferenceLink"),
    glrMethods: count(xml, "optionGLRLocationReferenceLink"),
    geometricMethods: count(xml, "optionGeometricLocationReferenceLink"),
    geometryLinePoints: count(xml, "linePoints"),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const path = args.find((arg) => !arg.startsWith("--"));
  if (path) {
    console.log(JSON.stringify({ origin: "local-file", ...summarize(await readFile(path, "utf8")) }));
    return;
  }
  if (!args.includes("--one-shot")) {
    throw new Error("explicit --one-shot required for the provider request");
  }
  const token = process.env.TPEG2_API_TOKEN;
  if (!token) throw new Error("TPEG2_API_TOKEN is not configured");
  const url = new URL("/dev/tpeg/tfp-static", process.env.TPEG2_BASE_URL || "https://online.ceda.cz");
  url.searchParams.set("token", token);
  const response = await fetch(url, {
    headers: {
      "Accept": "application/xml",
      "Accept-Encoding": "gzip",
      "If-Modified-Since": "Thu, 01 Jan 1970 00:00:00 GMT",
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 304) {
    console.log(JSON.stringify({ origin: "authorized-provider", status: 304 }));
    return;
  }
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  const summary = summarize(await response.text());
  console.log(JSON.stringify({ origin: "authorized-provider", status: response.status, ...summary }));
}

if (process.argv[1]?.endsWith("audit-tpeg-live-static-geometry.mjs")) {
  main().catch((error) => {
    console.error(`TPEG2 static geometry audit failed: ${error?.name || "unknown"}`);
    process.exitCode = 1;
  });
}
