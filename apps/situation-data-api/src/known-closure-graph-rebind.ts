import { readFile } from "node:fs/promises";
import type { SituationDataConfig } from "./config.js";
import { canonicalRoutingHash, pointInRing, RoadTripError, ROAD_TRIP_MAX_GRAPH_AGE_SECONDS } from "./routing-safety.js";
import { decodeValhallaPolyline6, valhallaSteps, type ExactRoutingDataset } from "./routing-service.js";
import {
  publishKnownClosureSnapshot,
  validateKnownReviewSet,
  verifyKnownClosureGeometry,
  type KnownClosureReviewSet,
  type KnownClosureSnapshot
} from "./known-road-closures.js";
import type { Tpeg2Source } from "./tpeg2-source.js";

// This caches only a mechanical binding of the SAME server-approved geometry.
// Never caches routes, authorizes changed source semantics or edits the approval.
const bindings = new Map<string, KnownClosureReviewSet>();
const inFlight = new Map<string, Promise<KnownClosureReviewSet>>();
const failures = new Map<string, number>();
const failure = (): never => {
  throw new RoadTripError(
    503,
    "ROUTING_KNOWN_CLOSURES_REVIEW_REQUIRED",
    "New graph could not pass the approved source/structure/both-direction probes; operator review required. No fallback."
  );
};
const meters = (a: number[], b: number[]) => {
  const r = Math.PI / 180,
    dlat = (b[1]! - a[1]!) * r,
    dlon = (b[0]! - a[0]!) * r,
    s = Math.sin(dlat / 2) ** 2 + Math.cos(a[1]! * r) * Math.cos(b[1]! * r) * Math.sin(dlon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
};
const dedup = (p: Array<[number, number]>) => p.filter((v, i) => i === 0 || v[0] !== p[i - 1]![0] || v[1] !== p[i - 1]![1]);
const graph = (s: any): ExactRoutingDataset => {
  if (!Number.isSafeInteger(s.tileset_last_modified) || s.tileset_last_modified <= 0) failure();
  const at = new Date(s.tileset_last_modified * 1000).toISOString();
  return { version: `sim-routing-${at.slice(0, 10)}-${s.tileset_last_modified}`, builtAt: at };
};

export async function probeApprovedGraph(
  set: KnownClosureReviewSet,
  dataset: ExactRoutingDataset,
  config: SituationDataConfig,
  source: Tpeg2Source,
  accepted: string[]
): Promise<KnownClosureReviewSet> {
  const old = validateKnownReviewSet(set, set.routingDataset, Date.now());
  if (old.reviews.length !== 1 || !old.reviews[0]!.graphProbe || !config.valhallaBaseUrl) failure();
  const review = old.reviews[0]!,
    anchor = review.graphProbe!;
  // Only a bounded convex whole-structure pilot, not arbitrary national polygons.
  if (
    review.polygon.length !== 5 ||
    meters(anchor.from, anchor.to) < 50 ||
    meters(anchor.from, anchor.to) > 2000 ||
    meters(anchor.shape[0]!, anchor.shape[1]!) > 250
  )
    failure();
  const corners = review.polygon.slice(0, -1),
    signs = corners.map((a, i) => {
      const b = corners[(i + 1) % 4]!,
        c = corners[(i + 2) % 4]!;
      return Math.sign((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]));
    });
  if (signs.some((s) => s === 0 || s !== signs[0])) failure();
  const evidence = await source.knownClosureEvidence();
  const initial = publishKnownClosureSnapshot(old, evidence, old.routingDataset, Date.now());
  const age = Date.now() - Date.parse(dataset.builtAt);
  if (age < 0 || age > ROAD_TRIP_MAX_GRAPH_AGE_SECONDS * 1000) failure();
  const deadline = Math.min(Date.now() + 10000, Date.parse(initial.validUntil));
  async function call(path: string, body?: unknown) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) failure();
    const r = await fetch(config.valhallaBaseUrl!.replace(/\/$/, "") + path, {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(Math.min(5000, remaining))
    });
    if (!r.ok) failure();
    const value = await r.json();
    if (value.error || (value.warnings?.length ?? 0) > 0) failure();
    return value;
  }
  const before = await call("/status");
  if (!accepted.includes(before.version) || canonicalRoutingHash(graph(before)) !== canonicalRoutingHash(dataset)) failure();
  // The reviewed centerline must still be the very same OSM structure, not a nearby road.
  for (const reverse of [false, true]) {
    const shape = reverse ? [...anchor.shape].reverse() : anchor.shape;
    const trace = await call("/trace_attributes", {
      shape: shape.map((p) => ({ lon: p[0], lat: p[1] })),
      shape_match: "map_snap",
      costing: "auto",
      filters: { action: "include", attributes: ["shape", "edge.way_id"] }
    });
    const matched = decodeValhallaPolyline6(trace.shape);
    if (
      matched.length < 2 ||
      !trace.edges?.length ||
      trace.edges.some((e: any) => String(e.way_id) !== review.osmWayId) ||
      meters(matched[0]!, shape[0]!) > 1 ||
      meters(matched.at(-1)!, shape.at(-1)!) > 1 ||
      matched.some((p) => !pointInRing(p, review.polygon))
    )
      failure();
    const from = reverse ? anchor.to : anchor.from,
      to = reverse ? anchor.from : anchor.to;
    const payload = {
      locations: [from, to].map((p) => ({ lon: p[0], lat: p[1], radius: 25, search_cutoff: 25 })),
      costing: "auto",
      costing_options: {
        auto: { speed_types: ["freeflow", "constrained"], ignore_closures: false, ignore_restrictions: false, ignore_access: false, ignore_oneways: false }
      },
      alternates: 2,
      units: "kilometers",
      language: "cs-CZ"
    };
    const baseline = await call("/route", payload);
    const avoided = await call("/route", { ...payload, exclude_polygons: [review.polygon] });
    for (const [excluded, result] of [
      [false, baseline],
      [true, avoided]
    ] as const) {
      const trips = [result.trip, ...(result.alternates ?? []).map((a: any) => a.trip)];
      if (!result.trip || trips.length > 3) failure();
      for (const trip of trips) {
        if (
          !trip ||
          trip.status !== 0 ||
          trip.legs?.length !== 1 ||
          (trip.warnings?.length ?? 0) > 0 ||
          !(trip.summary?.length > 0) ||
          !(trip.summary?.time > 0)
        )
          failure();
        const shape = dedup(decodeValhallaPolyline6(trip.legs[0].shape));
        if (shape.length < 2 || meters(shape[0]!, from) > 25 || meters(shape.at(-1)!, to) > 25 || trip.summary.length > 20) failure();
        const steps = valhallaSteps(trip.legs, shape);
        let end = 0;
        for (const step of steps) {
          if (
            !Number.isInteger(step.maneuverType) ||
            !Number.isInteger(step.beginShapeIndex) ||
            !Number.isInteger(step.endShapeIndex) ||
            step.beginShapeIndex !== end ||
            step.endShapeIndex! < end ||
            step.endShapeIndex! >= shape.length ||
            canonicalRoutingHash(dedup(step.geometry.coordinates)) !== canonicalRoutingHash(shape.slice(step.beginShapeIndex, step.endShapeIndex! + 1))
          )
            failure();
          end = step.endShapeIndex!;
        }
        if (!steps.length || end !== shape.length - 1) failure();
        if (excluded) {
          const probe: KnownClosureSnapshot = {
            ...initial,
            closures: [
              {
                id: review.id,
                polygon: review.polygon,
                validFrom: initial.observedAt,
                validUntil: initial.validUntil,
                sourceDirection: "unknown",
                enforcedDirection: "both",
                enforcementReason: "conservative_whole_structure_avoidance"
              }
            ]
          };
          verifyKnownClosureGeometry(shape, probe);
          // Independently reject the reviewed way even if new graph geometry
          // extends beyond the old polygon. Check every constrained variant.
          const edges = await call("/trace_attributes", {
            encoded_polyline: trip.legs[0].shape,
            shape_match: "edge_walk",
            costing: "auto",
            filters: { action: "include", attributes: ["edge.way_id"] }
          });
          if (!edges.edges?.length || edges.edges.some((e: any) => String(e.way_id) === review.osmWayId)) failure();
        }
      }
    }
    const primaryTrace = await call("/trace_attributes", {
      encoded_polyline: baseline.trip.legs[0].shape,
      shape_match: "edge_walk",
      costing: "auto",
      filters: { action: "include", attributes: ["edge.way_id"] }
    });
    if (!primaryTrace.edges?.some((e: any) => String(e.way_id) === review.osmWayId)) failure();
  }
  const after = await call("/status"),
    latest = publishKnownClosureSnapshot(old, await source.knownClosureEvidence(), old.routingDataset, Date.now());
  if (
    after.version !== before.version ||
    canonicalRoutingHash(graph(after)) !== canonicalRoutingHash(dataset) ||
    canonicalRoutingHash(latest) !== canonicalRoutingHash(initial) ||
    Date.now() >= deadline
  )
    failure();
  return {
    ...old,
    routingDataset: dataset,
    revision: canonicalRoutingHash({ approvedRevision: old.revision, approvedDataset: old.routingDataset, verifiedDataset: dataset, graphProbe: anchor })
  };
}

export async function verifiedGraphBinding(
  path: string,
  text: string,
  dataset: ExactRoutingDataset,
  config: SituationDataConfig,
  source: Tpeg2Source,
  accepted: string[]
): Promise<KnownClosureReviewSet> {
  const key = canonicalRoutingHash({ path, approval: text, dataset });
  const existing = bindings.get(key);
  if (existing) return structuredClone(existing);
  if ((failures.get(key) ?? 0) > Date.now()) failure();
  let job = inFlight.get(key);
  if (!job) {
    job = (async () => {
      try {
        const result = await probeApprovedGraph(JSON.parse(text), dataset, config, source, accepted);
        if ((await readFile(path, "utf8")) !== text) failure();
        if (bindings.size >= 4) bindings.clear();
        bindings.set(key, result);
        console.info(
          JSON.stringify({ event: "known_closure_graph_revalidated", routingDataset: dataset.version, approvedClosureCount: result.reviews.length })
        );
        return result;
      } catch (e) {
        if (failures.size >= 4) failures.clear();
        failures.set(key, Date.now() + 60000);
        if (e instanceof RoadTripError) throw e;
        return failure();
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, job);
  }
  return structuredClone(await job);
}
