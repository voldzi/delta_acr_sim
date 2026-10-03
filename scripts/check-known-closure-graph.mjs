// Run inside the SDA container; never prints source content or edits approval.
import { readFile } from "node:fs/promises";
const { loadConfig } = await import("/app/apps/situation-data-api/dist/config.js");
const { Tpeg2Source } = await import("/app/apps/situation-data-api/dist/tpeg2-source.js");
const { probeApprovedGraph } = await import("/app/apps/situation-data-api/dist/known-closure-graph-rebind.js");
const config = await loadConfig(),
  source = new Tpeg2Source(config);
try {
  const path = process.env.ROUTING_KNOWN_CLOSURES_REVIEW_FILE;
  if (!path?.startsWith("/") || !config.valhallaBaseUrl) throw Error("Not configured");
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > 1048576) throw Error("Invalid approval size");
  const response = await fetch(config.valhallaBaseUrl.replace(/\/$/, "") + "/status", { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error("Engine unavailable");
  const status = await response.json();
  if (!Number.isSafeInteger(status.tileset_last_modified) || status.tileset_last_modified <= 0) throw Error("Invalid engine dataset");
  const builtAt = new Date(status.tileset_last_modified * 1000).toISOString();
  const dataset = { version: `sim-routing-${builtAt.slice(0, 10)}-${status.tileset_last_modified}`, builtAt };
  const started = performance.now();
  const result = await probeApprovedGraph(
    JSON.parse(text),
    dataset,
    config,
    source,
    (process.env.ROUTING_KNOWN_CLOSURES_ENGINE_VERSIONS ?? "").split(",").map((v) => v.trim())
  );
  if ((await readFile(path, "utf8")) !== text) throw Error("Approval changed");
  console.log(
    JSON.stringify({
      verified: true,
      routingDataset: result.routingDataset,
      approvedClosureCount: result.reviews.length,
      latencyMs: Math.round(performance.now() - started),
      approvalFileUnchanged: true,
      liveTrafficChanged: false
    })
  );
} catch (error) {
  console.log(JSON.stringify({ verified: false, code: error.code ?? "ROUTING_KNOWN_CLOSURES_REVIEW_REQUIRED", fallbackUsed: false }));
  process.exitCode = 1;
} finally {
  source.dispose();
}
