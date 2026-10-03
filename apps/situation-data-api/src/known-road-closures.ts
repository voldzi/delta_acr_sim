import { readFile, stat } from "node:fs/promises";
import { canonicalRoutingHash, pointInRing, segmentsIntersect, RoadTripError } from "./routing-safety.js";
import type { ExactRoutingDataset } from "./routing-service.js";
import type { Tpeg2EventRecord, Tpeg2Source } from "./tpeg2-source.js";

export interface KnownClosureReviewSet {
  version: "sim-known-closure-reviews-v1";
  revision: string;
  routingDataset: ExactRoutingDataset;
  reviews: Array<{
    id: string;
    eventId: string;
    eventSemanticHash: string;
    osmWayId: string;
    reviewedAt: string;
    sourceUrl: string;
    scopeBasis: "source_both_direction" | "official_whole_structure_statement";
    polygon: Array<[number, number]>;
  }>;
}
export interface KnownClosureSnapshot {
  revision: string;
  observedAt: string;
  validUntil: string;
  routingDataset: ExactRoutingDataset;
  closures: Array<{
    id: string;
    polygon: Array<[number, number]>;
    validFrom: string;
    validUntil: string;
    sourceDirection: "both" | "unknown";
    enforcedDirection: "both";
    enforcementReason: "source_both_direction" | "conservative_whole_structure_avoidance";
  }>;
}
export type KnownClosuresAssessment = {
  version: "sim-known-road-closures-v1";
  state: "applied";
  coverage: "incomplete";
  revision: string;
  observedAt: string;
  validUntil: string;
  appliedClosureCount: number;
  geometryHash: string;
  requestHash: string;
  exclusions: Array<{
    closureId: string;
    sourceDirection: "both" | "unknown";
    enforcedDirection: "both";
    enforcementReason: "source_both_direction" | "conservative_whole_structure_avoidance";
    reviewedGeometryHash: string;
  }>;
  routingDataset: ExactRoutingDataset;
  engine: { provider: "valhalla"; version: string; fallbackUsed: false };
  limitations: string[];
};
export interface KnownClosureOptions {
  enabled: boolean;
  acceptedEngineVersions: string[];
  loadSnapshot: (dataset: ExactRoutingDataset, now: number) => Promise<KnownClosureSnapshot>;
}
const fail = (code: string, message: string): never => {
  throw new RoadTripError(503, code, message);
};
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => k in v);
const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256;
const iso = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) && /Z$/.test(v);
export function validateKnownReviewSet(raw: unknown, dataset: ExactRoutingDataset, now: number): KnownClosureReviewSet {
  if (
    !exact(raw, ["version", "revision", "routingDataset", "reviews"]) ||
    raw.version !== "sim-known-closure-reviews-v1" ||
    !text(raw.revision) ||
    !exact(raw.routingDataset, ["version", "builtAt"]) ||
    canonicalRoutingHash(raw.routingDataset) !== canonicalRoutingHash(dataset) ||
    !Array.isArray(raw.reviews) ||
    raw.reviews.length === 0 ||
    raw.reviews.length > 128
  )
    fail("ROUTING_KNOWN_CLOSURES_UNAVAILABLE", "Reviewed known-closure geometry is missing or bound to another graph.");
  const set = raw as unknown as KnownClosureReviewSet;
  const ids = new Set<string>(),
    events = new Set<string>();
  let vertices = 0;
  for (const r of set.reviews) {
    if (
      !exact(r, ["id", "eventId", "eventSemanticHash", "osmWayId", "reviewedAt", "sourceUrl", "scopeBasis", "polygon"]) ||
      ![r.id, r.eventId, r.osmWayId].every(text) ||
      !/^[0-9a-f]{64}$/.test(r.eventSemanticHash) ||
      !/^\d+$/.test(r.osmWayId) ||
      !iso(r.reviewedAt) ||
      Date.parse(r.reviewedAt) > now ||
      !/^https:\/\//.test(r.sourceUrl) ||
      !["source_both_direction", "official_whole_structure_statement"].includes(r.scopeBasis) ||
      ids.has(r.id) ||
      events.has(r.eventId) ||
      !Array.isArray(r.polygon) ||
      r.polygon.length < 4 ||
      r.polygon.length > 256 ||
      r.polygon.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) ||
      canonicalRoutingHash(r.polygon[0]) !== canonicalRoutingHash(r.polygon.at(-1))
    )
      fail("ROUTING_KNOWN_CLOSURES_UNAVAILABLE", "Malformed known-closure review; no partial exclusions are accepted.");
    const ring = r.polygon;
    const area = ring.slice(1).reduce((s, p, i) => s + ring[i]![0] * p[1] - p[0] * ring[i]![1], 0);
    if (Math.abs(area) < 1e-12 || (vertices += ring.length) > 4096) fail("ROUTING_KNOWN_CLOSURES_UNAVAILABLE", "Invalid or unbounded reviewed polygon.");
    for (let i = 0; i < ring.length - 1; i++)
      for (let j = i + 2; j < ring.length - 1; j++) {
        if (i === 0 && j === ring.length - 2) continue;
        if (segmentsIntersect(ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!))
          fail("ROUTING_KNOWN_CLOSURES_UNAVAILABLE", "Self-intersecting reviewed polygon.");
      }
    ids.add(r.id);
    events.add(r.eventId);
  }
  return structuredClone(set);
}
export function publishKnownClosureSnapshot(
  reviews: KnownClosureReviewSet,
  evidence: { confirmedAt: string; records: Tpeg2EventRecord[] },
  dataset: ExactRoutingDataset,
  now: number
): KnownClosureSnapshot {
  const set = validateKnownReviewSet(reviews, dataset, now);
  const confirmed = Date.parse(evidence.confirmedAt);
  if (
    !Number.isFinite(confirmed) ||
    confirmed > now ||
    now - confirmed >= 600000 ||
    new Set(evidence.records.map((r) => r.messageId)).size !== evidence.records.length
  )
    fail("ROUTING_KNOWN_CLOSURES_UNAVAILABLE", "The complete TEC snapshot is stale or invalid.");
  let deadline = confirmed + 600000;
  const closures: KnownClosureSnapshot["closures"] = [];
  for (const review of set.reviews) {
    const event = evidence.records.find((e) => e.messageId === review.eventId);
    // Absence in a successfully parsed CURRENT full snapshot means withdrawal.
    // It does not establish coverage of other roads or an authoritative empty map.
    if (!event) continue;
    const scope = event.closureEvidence;
    const supportedDirection =
      scope &&
      ((review.scopeBasis === "source_both_direction" && scope.direction === "both") ||
        (review.scopeBasis === "official_whole_structure_statement" && scope.direction === "unknown"));
    if (
      !scope ||
      scope.semanticHash !== review.eventSemanticHash ||
      !scope.roadClosed ||
      !scope.verified ||
      !scope.explicitValidity ||
      !supportedDirection ||
      scope.vehicleScope !== "all" ||
      scope.laneRestricted ||
      !event.validFrom ||
      !event.validUntil
    )
      fail("ROUTING_KNOWN_CLOSURES_REVIEW_REQUIRED", "A known source record changed or lacks reviewed direction, scope or validity.");
    const start = Date.parse(event.validFrom!),
      end = Date.parse(event.validUntil!);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) fail("ROUTING_KNOWN_CLOSURES_UNAVAILABLE", "Invalid source closure validity.");
    if (end <= now) continue;
    deadline = Math.min(deadline, start > now ? start : end);
    if (start <= now)
      closures.push({
        id: review.id,
        polygon: review.polygon,
        validFrom: new Date(start).toISOString(),
        validUntil: new Date(end).toISOString(),
        sourceDirection: scope!.direction as "both" | "unknown",
        enforcedDirection: "both",
        enforcementReason: review.scopeBasis === "source_both_direction" ? "source_both_direction" : "conservative_whole_structure_avoidance"
      });
  }
  return {
    revision: canonicalRoutingHash({ reviewRevision: set.revision, reviews: set.reviews, closures }),
    observedAt: new Date(confirmed).toISOString(),
    validUntil: new Date(deadline).toISOString(),
    routingDataset: dataset,
    closures
  };
}
export function verifyKnownClosureGeometry(shape: Array<[number, number]>, snapshot: KnownClosureSnapshot): void {
  if (shape.length < 2 || shape.some((p) => p.length !== 2 || !p.every(Number.isFinite)))
    throw new RoadTripError(502, "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED", "Invalid engine geometry.");
  for (const c of snapshot.closures)
    if (
      shape.some((p) => pointInRing(p, c.polygon)) ||
      shape.slice(1).some((p, i) => c.polygon.slice(1).some((q, j) => segmentsIntersect(shape[i]!, p, c.polygon[j]!, q)))
    )
      throw new RoadTripError(502, "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED", "A returned variant intersects a reviewed closure; no variants are returned.");
}
export function knownClosureOptionsFromEnv(source?: Tpeg2Source): KnownClosureOptions {
  const path = process.env.ROUTING_KNOWN_CLOSURES_REVIEW_FILE;
  return {
    enabled: process.env.ROUTING_KNOWN_CLOSURES_ENABLED === "true",
    acceptedEngineVersions: (process.env.ROUTING_KNOWN_CLOSURES_ENGINE_VERSIONS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    loadSnapshot: async (dataset, now) => {
      if (!source || !path?.startsWith("/")) fail("ROUTING_KNOWN_CLOSURES_UNAVAILABLE", "Known-closure source and reviewed geometry are not configured.");
      try {
        if ((await stat(path!)).size > 1048576) throw new Error();
        const json = await readFile(path!, "utf8");
        if (Buffer.byteLength(json) > 1048576) throw new Error();
        return publishKnownClosureSnapshot(JSON.parse(json), await source!.knownClosureEvidence(), dataset, Date.now());
      } catch (e) {
        if (e instanceof RoadTripError) throw e;
        return fail("ROUTING_KNOWN_CLOSURES_UNAVAILABLE", "Known closure source cannot be verified; no fallback used.");
      }
    }
  };
}
