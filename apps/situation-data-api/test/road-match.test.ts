import { describe, expect, it } from "vitest";
import { selectDirectedRoadMatch } from "../src/road-match.js";
const point = { directedEdgeId: "123", lat: 50, lon: 14, headingDeg: 90, distanceM: 3 };
describe("directional observation matching", () => {
  it("requires dataset provenance and travel direction", () => {
    expect(selectDirectedRoadMatch([point], 90, undefined, "now").state).toBe("unavailable");
    expect(selectDirectedRoadMatch([point], undefined, "dataset", "now").state).toBe("ambiguous");
  });
  it("rejects opposite carriageway and keeps parallel candidates ambiguous", () => {
    expect(selectDirectedRoadMatch([{ ...point, headingDeg: 270 }], 90, "dataset", "now").state).toBe("unavailable");
    expect(selectDirectedRoadMatch([point, { ...point, directedEdgeId: "124", distanceM: 8 }], 90, "dataset", "now").state).toBe("ambiguous");
  });
  it("accepts only a separated direction-compatible edge and handles north wrap", () => {
    expect(selectDirectedRoadMatch([point, { ...point, directedEdgeId: "124", distanceM: 30 }], 90, "dataset", "now").candidate?.directedEdgeId).toBe("123");
    expect(selectDirectedRoadMatch([{ ...point, headingDeg: 359 }], 1, "dataset", "now").state).toBe("matched");
  });
});
