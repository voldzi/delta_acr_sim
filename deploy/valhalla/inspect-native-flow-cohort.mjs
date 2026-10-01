// Aggregate-only localhost check of a private, unapproved native cohort.
// Reads candidate gzip on stdin; never creates/extends a traffic lease.
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const timestamp = (value) => typeof value === "string" && ISO.test(value) ? Date.parse(value) : NaN;

async function boundedRead(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error("body_limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function countCohort(candidate, feed, now) {
  if (candidate?.contractVersion !== "sim-native-baseline-review-v1" || candidate.approvedForLive !== false ||
      !candidate.mapping || typeof candidate.mapping !== "object" || Array.isArray(candidate.mapping) ||
      candidate.staticRevision !== feed?.staticRevision || !Array.isArray(feed.flows) ||
      !Number.isFinite(feed.maxAgeSeconds) || feed.maxAgeSeconds <= 0 || !Number.isFinite(now)) {
    throw new Error("cohort_identity_mismatch");
  }
  const counts = { candidateReferenceCount: Object.keys(candidate.mapping).length,
    candidateFlowRecords: 0, candidateFreshFlowRecords: 0, candidateExpiredFlowRecords: 0,
    candidateInvalidFlowRecords: 0, candidateFreshUniqueReferences: 0 };
  const fresh = new Set();
  for (const flow of feed.flows) {
    if (!Object.hasOwn(candidate.mapping, flow?.messageId)) continue;
    counts.candidateFlowRecords++;
    const observed = timestamp(flow.observedAt), expiry = timestamp(flow.validUntil);
    if (!Number.isFinite(observed) || observed > now + 30000 ||
        (flow.validUntil !== undefined && (!Number.isFinite(expiry) || expiry < observed)) ||
        typeof flow.averageSpeedKph !== "number" || !Number.isFinite(flow.averageSpeedKph) || flow.averageSpeedKph <= 0 || flow.averageSpeedKph > 250) {
      counts.candidateInvalidFlowRecords++;
    } else if (Math.min(flow.validUntil === undefined ? Infinity : expiry, observed + feed.maxAgeSeconds * 1000) <= now) {
      counts.candidateExpiredFlowRecords++;
    } else {
      counts.candidateFreshFlowRecords++;
      fresh.add(flow.messageId);
    }
  }
  counts.candidateFreshUniqueReferences = fresh.size;
  return counts;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const watchdog = setTimeout(() => {
    console.error("Private cohort inspection deadline reached; no payload disclosed.");
    process.exit(1);
  }, 60000);
  try {
    const raw = await boundedRead(process.stdin, 2 * 1024 * 1024);
    const candidate = JSON.parse(gunzipSync(raw, { maxOutputLength: 8 * 1024 * 1024 }));
    const token = process.env.VALHALLA_TRAFFIC_CONTROL_TOKEN;
    if (!token) throw new Error("configuration_invalid");
    const response = await fetch("http://127.0.0.1:4020/api/v1/internal/valhalla-traffic/feed?includeStatic=false", {
      redirect: "error", signal: AbortSignal.timeout(15000), headers: { Authorization: "Bearer " + token }
    });
    if (response.status !== 200) throw new Error("active_feed_unavailable");
    const rawFeed = await boundedRead(response.body, 48 * 1024 * 1024);
    const feed = JSON.parse(rawFeed.toString("utf8"));
    if (feed.contractVersion !== "sim-valhalla-live-traffic-feed-v1" || !Number.isFinite(feed.maxAgeSeconds) || feed.maxAgeSeconds <= 0) throw new Error("feed_invalid");
    console.log(JSON.stringify({ contractVersion: "sim-native-flow-cohort-inspection-v1", inspectedAt: new Date().toISOString(),
      approvedForLive: false, ...countCohort(candidate, feed, Date.now()) }));
  } catch {
    console.error("Private candidate cohort unavailable or invalid; no payload disclosed.");
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
  }
}
