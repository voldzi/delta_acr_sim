import { describe, it, expect } from "vitest";
import { BoundedRoutingDiagnostics, nativeRoutingDiagnosticFacts, routingRequestContext, rememberNativeRoutingFacts, recalledNativeRoutingFacts } from "../src/routing-diagnostics.js";
const id = "f0000000-0000-4000-8000-000000000001";
const start = Date.parse("2026-10-28T12:00:00Z"),
  until = new Date(start + 600_000).toISOString();
const facts = () => nativeRoutingDiagnosticFacts({ costing: "auto", alternates: 0 }, { trip: {}, warnings: [{ code: 401 }] });
describe("bounded private routing diagnostics", () => {
  it.each([undefined, "", "secret@example.invalid", "2026-10-28", new Date(start - 1).toISOString(), new Date(start + 600_001).toISOString()])(
    "is off for absent/invalid/expired/overlong window %s",
    (expiry) => {
      const lines: string[] = [];
      new BoundedRoutingDiagnostics(
        expiry,
        (s) => lines.push(s),
        () => start,
        () => 0
      ).rejected({ correlationId: id }, "native_warning_validation", "ROUTING_RESTRICTIONS_RELAXATION_REQUIRED", facts(), true);
      expect(lines).toEqual([]);
    }
  );
  it("requires an existing exact UUID, accepts uppercase without exporting arbitrary headers", () => {
    expect(routingRequestContext(id.toUpperCase())).toEqual({ correlationId: id.toUpperCase() });
    for (const value of [undefined, [id], { id }, "gps-canary", "x".repeat(100_000), ` ${id}`, id + "\n"]) expect(routingRequestContext(value)).toBeUndefined();
    const lines: string[] = [],
      sink = new BoundedRoutingDiagnostics(
        until,
        (s) => lines.push(s),
        () => start,
        () => 0
      );
    sink.rejected(undefined, "native_request", "OTHER", undefined, false);
    sink.rejected({ correlationId: "private-canary" }, "native_request", "OTHER", undefined, false);
    expect(lines).toEqual([]);
  });
  it("has sixteen total events, no replenishment or logging failure affecting caller", () => {
    let attempts = 0;
    const sink = new BoundedRoutingDiagnostics(
      until,
      () => {
        attempts++;
        throw new Error("private-log-error");
      },
      () => start,
      () => 0
    );
    for (let i = 0; i < 100; i++) expect(() => sink.rejected({ correlationId: id }, "native_request", "OTHER", undefined, false)).not.toThrow();
    expect(attempts).toBe(16);
  });
  it("stops on wall or monotonic expiry, including a backwards wall clock", () => {
    for (const kind of ["wall", "monotonic"]) {
      let wall = start,
        monotonic = 0;
      const lines: string[] = [],
        sink = new BoundedRoutingDiagnostics(
          until,
          (s) => lines.push(s),
          () => wall,
          () => monotonic
        );
      sink.rejected({ correlationId: id }, "native_request", "OTHER", undefined, false);
      if (kind === "wall") wall = start + 600_000;
      else {
        wall = start - 1_000_000;
        monotonic = 600_000;
      }
      sink.rejected({ correlationId: id }, "native_request", "OTHER", undefined, false);
      wall = start;
      monotonic = 0;
      sink.rejected({ correlationId: id }, "native_request", "OTHER", undefined, false);
      expect(lines).toHaveLength(1);
    }
  });
  it("reports outgoing time mode, never guesses algorithm or multipass reason", () => {
    for (const [date_time, mode] of [
      [undefined, "none"],
      [{ type: 0 }, "depart_now"],
      [{ type: 1, value: "private-date-canary" }, "depart_at"],
      [{ type: 999 }, "unknown"]
    ] as const) {
      const f = nativeRoutingDiagnosticFacts({ costing: "auto", alternates: 2, date_time }, { trip: {}, alternates: [{ trip: {} }, { trip: {} }] });
      expect(f.requestedDateTimeMode).toBe(mode);
      expect(f.requestedVariantCount).toBe(3);
      const lines: string[] = [];
      new BoundedRoutingDiagnostics(
        until,
        (s) => lines.push(s),
        () => start,
        () => 0
      ).rejected({ correlationId: id }, "native_warning_validation", "ROUTING_RESTRICTIONS_RELAXATION_REQUIRED", f, true);
      expect(JSON.parse(lines[0])).toMatchObject({ algorithm: "not_reported", multipassCondition: "not_reported", snapClassification: "unknown" });
      expect(lines[0]).not.toContain("private-date-canary");
    }
  });
  it("caps malformed provider codes/counts and never emits raw data or extra properties", () => {
    const secret = "PRIVATE_COORD_PROFILE_ACCOUNT_TOKEN_CANARY";
    const f = nativeRoutingDiagnosticFacts(
      { costing: secret, alternates: 2 },
      {
        warnings: [{ code: 401, text: secret }, { code: secret }, null, "bad", { code: -1 }, { code: Infinity }, { code: 1.5 }],
        trip: { warnings: [{ code: 401, text: secret }], geometry: secret },
        alternates: Array.from({ length: 1000 }, () => ({ trip: { warnings: Array.from({ length: 100 }, (_, code) => ({ code, text: secret })) } }))
      }
    );
    const lines: string[] = [];
    new BoundedRoutingDiagnostics(
      until,
      (s) => lines.push(s),
      () => start,
      () => 0
    ).rejected({ correlationId: id }, "native_warning_validation", secret, { ...f, secret } as any, true);
    const event = JSON.parse(lines[0]);
    expect(lines[0]).not.toContain(secret);
    expect(event.outcomeCode).toBe("OTHER_PROTECTIVE_FAILURE");
    expect(event.returnedVariantCount).toBe(3);
    expect(event.returnedVariantCountTruncated).toBe(true);
    expect(event.nativeWarningCodes.length).toBeLessThanOrEqual(16);
    expect(event.warningCounts.alternate).toBe(64);
    expect(event.warningCounts.malformed).toBeGreaterThan(0);
    expect(event.nativeWarningsTruncated).toBe(true);
    expect(Object.keys(event).sort()).toEqual(
      [
        "event",
        "correlationId",
        "stage",
        "outcomeCode",
        "costing",
        "requestedDateTimeMode",
        "requestedVariantCount",
        "returnedVariantCount",
        "returnedVariantCountTruncated",
        "nativeWarningCodes",
        "warningCounts",
        "nativeWarningsTruncated",
        "algorithm",
        "multipassCondition",
        "snapClassification",
        "closureGeometryValidated"
      ].sort()
    );
  });
  it("does not reinterpret ambiguous waypoint/origin or pre-geometry errors as a target", () => {
    const lines: string[] = [],
      sink = new BoundedRoutingDiagnostics(
        until,
        (s) => lines.push(s),
        () => start,
        () => 0
      );
    sink.rejected({ correlationId: id }, "waypoint_snap_validation", "ROUTING_WAYPOINT_NOT_ROUTABLE", undefined, true);
    sink.rejected({ correlationId: id }, "native_request", "ROUTING_TARGET_NOT_ROUTABLE", undefined, false);
    sink.rejected({ correlationId: id }, "waypoint_snap_validation", "ROUTING_TARGET_NOT_ROUTABLE", undefined, true);
    expect(lines.map((s) => JSON.parse(s).snapClassification)).toEqual(["unknown", "unknown", "destination"]);
  });
  it.each(["alternate", "malformed"])("marks %s aggregate overflow even when each array is below its cap", scope => {
    const a = Array.from({ length: 40 }, () => ({ code: scope === "alternate" ? 401 : "not-numeric" }));
    const body = scope === "alternate" ? { trip: {}, alternates: [{ trip: { warnings: a } }, { trip: { warnings: a } }] }
      : { warnings: a, trip: { warnings: a } };
    const f = nativeRoutingDiagnosticFacts({ costing: "auto", alternates: 2 }, body);
    expect(f.warningCounts[scope]).toBe(64); expect(f.nativeWarningsTruncated).toBe(true);
  });
  it("suppresses a formatter fault and stores only safe facts without touching the native object", () => {
    const target = { trip: {}, warnings: [{ code: 401 }] }, original = structuredClone(target);
    const faultyPayload = { get costing(): string { throw new Error("PRIVATE_FORMATTER_CANARY"); } };
    expect(() => rememberNativeRoutingFacts(target, faultyPayload, target)).not.toThrow();
    expect(recalledNativeRoutingFacts(target)).toBeUndefined(); expect(target).toEqual(original);
    rememberNativeRoutingFacts(target, { costing: "auto", alternates: 0 }, target);
    expect(recalledNativeRoutingFacts(target)?.nativeWarningCodes).toEqual([401]); expect(target).toEqual(original);
  });
});
