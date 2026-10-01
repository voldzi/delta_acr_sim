// Private one-shot snapshot from SIM's normalized internal feed, not a provider bypass.
// Run inside situation-data-api; stdout is binary gzip and MUST go to a private file.
import { gzipSync } from "node:zlib";
const token = process.env.VALHALLA_TRAFFIC_CONTROL_TOKEN;
if (!token) throw new Error("Control authentication unavailable");
const response = await fetch("http://127.0.0.1:4020/api/v1/internal/valhalla-traffic/feed?includeStatic=false", {
  redirect: "error", signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}` }
});
if (response.status !== 200) throw new Error("Active normalized feed unavailable");
const chunks = [];
let size = 0;
for await (const chunk of response.body) {
  size += chunk.length;
  if (size > 48 * 1024 * 1024) throw new Error("Feed size bound");
  chunks.push(Buffer.from(chunk));
}
const body = Buffer.concat(chunks);
const feed = JSON.parse(body.toString("utf8"));
if (feed.contractVersion !== "sim-valhalla-live-traffic-feed-v1" || !Array.isArray(feed.flows)) throw new Error("Feed contract mismatch");
process.stdout.write(gzipSync(body));
