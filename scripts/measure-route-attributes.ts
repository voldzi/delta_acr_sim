/** Read-only SIM route-response size/latency probe using public sample locations. */
import { performance } from "node:perf_hooks";
import { loadConfig } from "../apps/situation-data-api/src/config.js";
import { RoutingService } from "../apps/situation-data-api/src/routing-service.js";

async function main(): Promise<void> {
  const baseUrl = process.argv[2];
  if (!baseUrl) throw new Error("Usage: tsx scripts/measure-route-attributes.ts INTERNAL_VALHALLA_BASE_URL");
  process.env.SITUATION_DATA_DIR = "/private/tmp/sim-road-attributes-data";
  process.env.SITUATION_DATA_ENABLED_SOURCES = "mock";
  process.env.ROUTING_ENGINE = "valhalla";
  process.env.VALHALLA_BASE_URL = baseUrl;
  process.env.VALHALLA_TRAFFIC_ENABLED = "false";
  const config = await loadConfig();
  const service = new RoutingService(config);
  const cases: Record<string, [[number, number], [number, number]]> = {
    parallel_urban_roads: [
      [50.0806, 14.4312],
      [50.0875, 14.4285]
    ],
    motorway_ramp: [
      [50.037, 14.497],
      [50.024, 14.506]
    ],
    roundabout: [
      [50.0984, 14.394],
      [50.1004, 14.4005]
    ],
    one_way_streets: [
      [50.084, 14.414],
      [50.086, 14.419]
    ],
    speed_change: [
      [50.087, 14.416],
      [50.07, 14.49]
    ],
    conditional_restriction_candidate: [
      [50.066, 14.411],
      [50.061, 14.416]
    ],
    cross_border: [
      [50.64, 13.82],
      [50.76, 13.75]
    ]
  };
  for (const [name, [start, end]] of Object.entries(cases)) {
    const request = { profileId: "car" as const, from: { lat: start[0], lon: start[1] }, to: { lat: end[0], lon: end[1] } };
    const observations = [];
    for (const includeRoadAttributes of [false, true]) {
      const started = performance.now();
      const response = await service.route({ ...request, includeRoadAttributes });
      const attrs = response.routes[0]?.roadAttributes;
      observations.push({
        includeRoadAttributes,
        ms: Math.round(performance.now() - started),
        bytes: Buffer.byteLength(JSON.stringify(response)),
        durationSeconds: response.routes[0]?.durationSeconds,
        coverage: response.coverage?.state,
        attributesState: attrs?.state,
        knownLimitCoveragePercent: attrs?.knownSpeedLimitCoveragePercent,
        edgeCount: attrs?.matchedEdgeCount,
        geometryMismatches: attrs?.geometryMismatchCount
      });
    }
    process.stdout.write(JSON.stringify({ scenario: name, baseline: observations[0], enriched: observations[1] }) + "\n");
  }
}
void main();
