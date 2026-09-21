import { describe, expect, it } from "vitest";
import { valhallaSteps } from "../src/routing-service.js";

describe("native maneuver geometry", () => {
  it("preserves joined-leg indices through a return over the same road", () => {
    const steps = valhallaSteps(
      [
        { shape: "_oso~A_acoZowH_pRoh\\_af@", maneuvers: [{ type: 1, begin_shape_index: 0, end_shape_index: 2 }] },
        {
          shape: "_qzp~A_t}pZnh\\~`f@nwH~oR",
          maneuvers: [
            { type: 13, begin_shape_index: 0, end_shape_index: 2 },
            { type: 4, begin_shape_index: 2, end_shape_index: 2, time: 0, length: 0 }
          ]
        }
      ],
      [
        [14.42, 50.08],
        [14.43, 50.085],
        [14.45, 50.1],
        [14.43, 50.085],
        [14.42, 50.08]
      ]
    );
    expect(steps.map((step) => [step.maneuverType, step.beginShapeIndex, step.endShapeIndex])).toEqual([
      [1, 0, 2],
      [13, 2, 4],
      [4, 4, 4]
    ]);
    expect(steps[2]?.geometry.coordinates).toHaveLength(2);
    expect(steps[2]?.distanceM).toBe(0);
  });
  it("does not invent a maneuver type when absent upstream", () => {
    const steps = valhallaSteps(
      [{ shape: "_oso~A_acoZowH_pRoh\\_af@", maneuvers: [{ begin_shape_index: 0, end_shape_index: 2 }] }],
      [
        [14.42, 50.08],
        [14.43, 50.085],
        [14.45, 50.1]
      ]
    );
    expect(steps[0]?.maneuverType).toBeUndefined();
  });
});
