import { describe, expect, it } from "vitest";
import { valhallaDepartureTimePayload } from "../src/routing-service.js";

describe("Valhalla live traffic request time", () => {
  it("uses current time only when live road traffic is enabled", () => {
    expect(valhallaDepartureTimePayload(undefined, true)).toEqual({ date_time: { type: 0 } });
    expect(valhallaDepartureTimePayload(undefined, false)).toEqual({});
  });

  it("preserves an explicit departure time", () => {
    expect(valhallaDepartureTimePayload("2026-09-14T15:30:45+02:00", true)).toEqual({
      date_time: { type: 1, value: "2026-09-14T15:30" }
    });
  });
});
