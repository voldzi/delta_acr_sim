import { describe, expect, it } from "vitest";
import { encodeValhallaPolyline6, roadAttributesFromTrace } from "../src/routing-service.js";

const dataset = { version: "sim-routing-2026-09-23-1", builtAt: "2026-09-23T00:00:00Z" };
const observedAt = "2026-09-23T12:00:00Z";
const shape: Array<[number, number]> = [
  [14.42, 50.08],
  [14.4205, 50.08],
  [14.421, 50.08]
];

describe("Valhalla directed route attributes", () => {
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
      observedAt
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
      observedAt
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
      observedAt
    );
    expect(result).toMatchObject({ state: "unavailable", geometryMismatchCount: 1, speedLimits: [] });
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
      observedAt
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
      observedAt
    );
    expect(result).toMatchObject({ state: "ok", geometryMismatchCount: 0, matchedEdgeCount: 2 });
    expect(result.speedLimits[1]).toMatchObject({ beginShapeIndex: 1, endShapeIndex: 2, valueKph: 30 });

    const middleDuplicate = roadAttributesFromTrace(
      { shape: encodeValhallaPolyline6([shape[0]!, shape[1]!, shape[1]!, shape[2]!]), edges: [{ begin_shape_index: 0, end_shape_index: 3, speed_limit: 50 }] },
      shape,
      dataset,
      observedAt
    );
    expect(middleDuplicate).toMatchObject({ state: "unavailable", speedLimits: [] });
  });
});
