import { describe, expect, it } from "vitest";
import { encodeValhallaPolyline6, roadAttributesFromTrace, valhallaRouteId } from "../src/routing-service.js";

const dataset = { version: "sim-routing-2026-09-23-1", builtAt: "2026-09-23T00:00:00Z" };
const observedAt = "2026-09-23T12:00:00Z";
const shape: Array<[number, number]> = [
  [14.42, 50.08],
  [14.4205, 50.08],
  [14.421, 50.08]
];

describe("Valhalla directed route attributes", () => {
  it("binds consecutive tunnel and ramp edges to only the selected directed variant", () => {
    const primary: Array<[number, number]> = [
      [14.42, 50.08], [14.4205, 50.08], [14.421, 50.08], [14.4215, 50.08], [14.422, 50.08]
    ];
    const alternative: Array<[number, number]> = [
      [14.42, 50.08], [14.4205, 50.08], [14.421, 50.0805], [14.4215, 50.0805], [14.422, 50.08]
    ];
    const from = { lon: primary[0]![0], lat: primary[0]![1] };
    const to = { lon: primary[4]![0], lat: primary[4]![1] };
    const primaryId = valhallaRouteId("car", from, to, 1, primary);
    const reroutedId = valhallaRouteId("car", from, to, 1, alternative);
    expect(reroutedId).not.toBe(primaryId);
    const primaryResult = roadAttributesFromTrace(
      {
        shape: encodeValhallaPolyline6(primary),
        edges: [
          { begin_shape_index: 0, end_shape_index: 1, tunnel: false },
          { begin_shape_index: 1, end_shape_index: 2, tunnel: true },
          { begin_shape_index: 2, end_shape_index: 3, tunnel: true },
          { begin_shape_index: 3, end_shape_index: 4, tunnel: false }
        ]
      }, primary, dataset, observedAt, primaryId
    );
    expect(primaryResult.tunnels).toEqual({
      state: "known", routeId: primaryId, source: "valhalla_trace_attributes.edge.tunnel",
      routingDataset: dataset, observedAt,
      intervals: [{ beginShapeIndex: 1, endShapeIndex: 3, direction: "along_route" }]
    });
    const alternativeResult = roadAttributesFromTrace(
      {
        shape: encodeValhallaPolyline6(alternative),
        edges: [{ begin_shape_index: 0, end_shape_index: 4, tunnel: false }]
      }, alternative, dataset, observedAt, reroutedId
    );
    expect(alternativeResult.tunnels).toMatchObject({ state: "known", routeId: reroutedId, intervals: [] });
  });

  it("reports unknown tunnels when a directed flag or edge coverage is missing", () => {
    const missingFlag = roadAttributesFromTrace(
      { shape: encodeValhallaPolyline6(shape), edges: [
        { begin_shape_index: 0, end_shape_index: 1, tunnel: true },
        { begin_shape_index: 1, end_shape_index: 2 }
      ] }, shape, dataset, observedAt, "route-primary"
    );
    expect(missingFlag.tunnels).toMatchObject({ state: "unknown", intervals: [] });

    const longerShape: Array<[number, number]> = [...shape, [14.4215, 50.08]];
    const gap = roadAttributesFromTrace(
      { shape: encodeValhallaPolyline6(longerShape), edges: [
        { begin_shape_index: 0, end_shape_index: 1, tunnel: true },
        { begin_shape_index: 2, end_shape_index: 3, tunnel: false }
      ] }, longerShape, dataset, observedAt, "route-primary"
    );
    expect(gap.tunnels).toMatchObject({ state: "unknown", intervals: [] });
  });
  it("binds posted limits and an advisory closure to the exact selected shape", () => {
    const result = roadAttributesFromTrace(
      {
        shape: encodeValhallaPolyline6(shape),
        edges: [
          { begin_shape_index: 0, end_shape_index: 1, speed_limit: 50, speed_type: "tagged" },
          { begin_shape_index: 1, end_shape_index: 2, speed_limit: 30, speed_type: "tagged" }
        ],
        shape_attributes: { closures: [{ begin_shape_index: 1, end_shape_index: 2 }] }
      },
      shape,
      dataset,
      observedAt,
      "route-primary"
    );
    expect(result).toMatchObject({
      state: "ok",
      matchedEdgeCount: 2,
      geometryMismatchCount: 0,
      knownSpeedLimitCoveragePercent: 100,
      speedLimits: [
        { beginShapeIndex: 0, endShapeIndex: 1, direction: "along_route", valueKph: 50, status: "explicit" },
        { beginShapeIndex: 1, endShapeIndex: 2, direction: "along_route", valueKph: 30, status: "explicit" }
      ],
      restrictions: [{ kind: "closure", beginShapeIndex: 1, endShapeIndex: 2, assessment: "advisory" }]
    });
  });

  it("never labels a costing speed as a legal limit", () => {
    const result = roadAttributesFromTrace(
      { shape: encodeValhallaPolyline6(shape), edges: [{ begin_shape_index: 0, end_shape_index: 2, speed_type: "classified" }] },
      shape,
      dataset,
      observedAt,
      "route-primary"
    );
    expect(result.state).toBe("ok");
    expect(result.knownSpeedLimitCoveragePercent).toBe(0);
    expect(result.speedLimits).toEqual([{ beginShapeIndex: 0, endShapeIndex: 2, direction: "along_route", status: "unknown", source: "unknown" }]);
  });

  it("rejects the opposite-direction or parallel shape instead of assigning its limit", () => {
    const reversed = [...shape].reverse();
    const result = roadAttributesFromTrace(
      { shape: encodeValhallaPolyline6(reversed), edges: [{ begin_shape_index: 0, end_shape_index: 2, speed_limit: 90 }] },
      shape,
      dataset,
      observedAt,
      "route-primary"
    );
    expect(result).toMatchObject({ state: "unavailable", geometryMismatchCount: 1, speedLimits: [], tunnels: { state: "unknown", intervals: [] } });
  });

  it("keeps directed indexes when the route revisits an earlier coordinate", () => {
    const loop: Array<[number, number]> = [
      [14.42, 50.08],
      [14.4205, 50.08],
      [14.4205, 50.0805],
      [14.42, 50.08]
    ];
    const result = roadAttributesFromTrace(
      {
        shape: encodeValhallaPolyline6(loop),
        edges: [
          { begin_shape_index: 0, end_shape_index: 1, speed_limit: 50 },
          { begin_shape_index: 1, end_shape_index: 2, speed_limit: 30 },
          { begin_shape_index: 2, end_shape_index: 3, speed_limit: 20 }
        ]
      },
      loop,
      dataset,
      observedAt,
      "route-primary"
    );
    expect(result).toMatchObject({ state: "ok", geometryMismatchCount: 0, matchedEdgeCount: 3 });
    expect(result.speedLimits.map(({ beginShapeIndex, endShapeIndex }) => [beginShapeIndex, endShapeIndex])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3]
    ]);
  });

  it("accepts only a duplicated terminal trace point from edge_walk", () => {
    const result = roadAttributesFromTrace(
      {
        shape: encodeValhallaPolyline6([...shape, shape[shape.length - 1]!]),
        edges: [
          { begin_shape_index: 0, end_shape_index: 1, speed_limit: 50 },
          { begin_shape_index: 1, end_shape_index: 3, speed_limit: 30 }
        ]
      },
      shape,
      dataset,
      observedAt,
      "route-primary"
    );
    expect(result).toMatchObject({ state: "ok", geometryMismatchCount: 0, matchedEdgeCount: 2 });
    expect(result.speedLimits[1]).toMatchObject({ beginShapeIndex: 1, endShapeIndex: 2, valueKph: 30 });

    const middleDuplicate = roadAttributesFromTrace(
      { shape: encodeValhallaPolyline6([shape[0]!, shape[1]!, shape[1]!, shape[2]!]), edges: [{ begin_shape_index: 0, end_shape_index: 3, speed_limit: 50 }] },
      shape,
      dataset,
      observedAt,
      "route-primary"
    );
    expect(middleDuplicate).toMatchObject({ state: "unavailable", speedLimits: [] });
  });
});
