#!/usr/bin/env node
// Read-only, bounded diagnostic. Run inside the SIM situation-data container:
// ssh docker.home.cz 'docker exec -i csm-sim-situation-data-api node' < deploy/valhalla/diagnose-openlr-single-edge.js
const fs = require("node:fs");
const zlib = require("node:zlib");

const cachePath = process.env.OPENLR_STATIC_CACHE ?? "/valhalla-traffic-cache/static-segments.json.gz";
const valhallaUrl = process.env.VALHALLA_URL ?? "http://valhalla.home.cz:8002";
const samplePerFrc = Math.max(1, Math.min(30, Number(process.env.OPENLR_SAMPLE_PER_FRC ?? 20)));
const segments = JSON.parse(zlib.gunzipSync(fs.readFileSync(cachePath))).segments;
const sample = [];
for (let frc = 0; frc <= 7; frc += 1) {
  const group = segments.filter((segment) => segment.openlr?.points?.[0]?.frc === String(frc));
  for (let index = 0; index < Math.min(samplePerFrc, group.length); index += 1) {
    sample.push(group[Math.floor(index * group.length / samplePerFrc)]);
  }
}

async function request(path, payload) {
  const response = await fetch(`${valhallaUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });
  return { status: response.status, body: await response.json() };
}

const difference = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
function candidate(segment, start, end) {
  const points = segment.openlr?.points;
  const expected = Number(points?.[0]?.distanceToNext);
  if (points?.length !== 2 || !Number.isFinite(expected) || expected <= 0) return "invalid_reference";
  if (Number(segment.openlr?.positiveOffsetMeters || 0) > 0 || Number(segment.openlr?.negativeOffsetMeters || 0) > 0) return "offset";
  const firstHeading = Number(points[0].bearing) * 360 / 256;
  const lastHeading = (Number(points[1].bearing) * 360 / 256 + 180) % 360;
  const viable = [];
  for (const first of start.edges ?? []) {
    for (const last of end.edges ?? []) {
      if (first.edge_id?.value !== last.edge_id?.value) continue;
      const length = Number(first.edge?.geo_attributes?.length);
      if (!Number.isFinite(length) || Math.abs(length - expected) > Math.max(35, expected * 0.1)) continue;
      if (first.distance > 20 || last.distance > 20) continue;
      if (first.percent_along > 0.05 || last.percent_along < 0.95) continue;
      if (difference(firstHeading, first.heading) > 35 || difference(lastHeading, last.heading) > 35) continue;
      viable.push({ id: first.edge_id.value, roadClass: first.edge?.classification?.classification ?? "unknown" });
    }
  }
  const unique = [...new Map(viable.map((item) => [item.id, item])).values()];
  if (unique.length === 0) return "no_full_edge_candidate";
  if (unique.length > 1) return "ambiguous";
  return `single_edge:${unique[0].roadClass}`;
}

async function routeCandidate(segment, start, end) {
  const points = segment.openlr?.points;
  if (Number(segment.openlr?.positiveOffsetMeters || 0) > 0 || Number(segment.openlr?.negativeOffsetMeters || 0) > 0) return "offset";
  const firstHeading = Number(points?.[0]?.bearing) * 360 / 256;
  const lastHeading = (Number(points?.at(-1)?.bearing) * 360 / 256 + 180) % 360;
  const locations = segment.coordinates.map(([lon, lat], index) => ({
    lon, lat, radius: 20, search_cutoff: 20, heading: index === 0 ? firstHeading : lastHeading,
    heading_tolerance: 34
  }));
  const route = await request("/route", { locations, costing: "auto", directions_type: "none" });
  if (route.status !== 200) return `route_${route.body?.error_code ?? route.status}`;
  const shape = route.body?.trip?.legs?.[0]?.shape;
  if (typeof shape !== "string") return "missing_route_shape";
  const trace = await request("/trace_attributes", {
    encoded_polyline: shape, costing: "auto", shape_match: "edge_walk",
    filters: { action: "include", attributes: ["edge.id", "edge.length", "edge.begin_heading", "edge.end_heading", "edge.road_class"] }
  });
  if (trace.status !== 200 || !Array.isArray(trace.body?.edges)) return `route_trace_${trace.body?.error_code ?? trace.status}`;
  const edges = trace.body.edges;
  if (edges.length === 0) return "route_no_edges";
  if (Number(edges[0].source_percent_along ?? 0) > 0.05 || Number(edges.at(-1).target_percent_along ?? 1) < 0.95) return "route_partial_edge";
  const expected = Number(points?.[0]?.distanceToNext);
  const actual = edges.reduce((sum, edge) => sum + 1000 * Number(edge.length), 0);
  if (!Number.isFinite(expected) || expected <= 0 || Math.abs(actual - expected) > Math.max(35, expected * 0.1)) return "route_length_mismatch";
  if (difference(firstHeading, Number(edges[0].begin_heading)) > 35) return "route_first_bearing_mismatch";
  if (difference(lastHeading, Number(edges.at(-1).end_heading)) > 35) return "route_last_bearing_mismatch";
  const classes = [...new Set(edges.map((edge) => edge.road_class ?? "unknown"))].sort();
  const allowed = {
    0: ["motorway"], 1: ["trunk", "primary"],
    2: ["trunk", "primary", "secondary"], 3: ["trunk", "secondary", "tertiary"],
    4: ["primary", "secondary", "tertiary"], 5: ["secondary", "tertiary", "residential"],
    6: ["tertiary", "unclassified", "residential"], 7: ["tertiary", "unclassified", "residential", "service_other"]
  }[Number(points[0].frc)] ?? [];
  if (!classes.every((roadClass) => allowed.includes(roadClass))) return `route_class_mismatch:${classes.join("+")}`;
  const near = (location, heading, atStart) => [...new Set((location.edges ?? [])
    .filter((edge) => edge.distance <= 20 && difference(heading, edge.heading) <= 35 &&
      allowed.includes(edge.edge?.classification?.classification) &&
      (atStart ? edge.percent_along <= 0.05 : edge.percent_along >= 0.95))
    .map((edge) => edge.edge_id?.value))].filter((id) => id !== undefined);
  const firstCandidates = near(start, firstHeading, true);
  const lastCandidates = near(end, lastHeading, false);
  if (firstCandidates.length !== 1 || lastCandidates.length !== 1) return `route_ambiguous_endpoints:${firstCandidates.length}+${lastCandidates.length}`;
  if (firstCandidates[0] !== Number(edges[0].id) || lastCandidates[0] !== Number(edges.at(-1).id)) return "route_edge_disagreement";
  return `route_pass:${classes.join("+")}`;
}

(async () => {
  const results = {};
  const routeResults = {};
  const baselineClasses = {};
  let traceFailures = 0;
  for (const segment of sample) {
    const shape = segment.coordinates.map(([lon, lat]) => ({ lon, lat, type: "through", radius: 100 }));
    const trace = await request("/trace_attributes", {
      shape, costing: "auto", shape_match: "walk_or_snap",
      trace_options: { search_radius: 100, gps_accuracy: 50, breakage_distance: 20000, interpolation_distance: 10 },
      filters: { action: "include", attributes: ["edge.id", "edge.road_class"] }
    });
    if (trace.status === 200) {
      const frc = segment.openlr.points[0].frc;
      baselineClasses[frc] ??= {};
      for (const roadClass of new Set((trace.body.edges ?? []).map((edge) => edge.road_class ?? "unknown"))) {
        baselineClasses[frc][roadClass] = (baselineClasses[frc][roadClass] ?? 0) + 1;
      }
      continue;
    }
    if (trace.body?.error_code !== 444) continue;
    traceFailures += 1;
    const locations = segment.coordinates.map(([lon, lat]) => ({ lon, lat, radius: 25, search_cutoff: 25 }));
    const located = await request("/locate", { locations, costing: "auto", verbose: true });
    const reason = located.status === 200 && Array.isArray(located.body) && located.body.length === 2
      ? candidate(segment, located.body[0], located.body[1]) : "locate_failure";
    const key = `${segment.openlr.points[0].frc}:${reason}`;
    results[key] = (results[key] ?? 0) + 1;
    if (reason === "no_full_edge_candidate") {
      const routeReason = await routeCandidate(segment, located.body[0], located.body[1]);
      const routeKey = `${segment.openlr.points[0].frc}:${routeReason}`;
      routeResults[routeKey] = (routeResults[routeKey] ?? 0) + 1;
    }
  }
  console.log(JSON.stringify({ sampleSize: sample.length, traceFailures444: traceFailures, baselineClasses, results, routeResults }));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
