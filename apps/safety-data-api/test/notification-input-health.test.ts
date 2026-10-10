import { describe, expect, it } from "vitest";
import { evaluateNotificationInput } from "../src/notification-input-health.js";
import type { ManagedResponseCacheStats } from "../src/response-cache.js";
import type { SourceCacheStats } from "../src/sources.js";
import type { SafetyFeature, SafetyFeatureCollection } from "../src/types.js";

const NOW = Date.parse("2026-10-10T10:00:00.000Z");
const FRESH = "2026-10-10T09:59:30.000Z";
const RECENT_ERROR = "2026-10-10T09:59:40.000Z";
const RECOVERED = "2026-10-10T09:59:50.000Z";
const OLD = "2026-10-10T09:50:00.000Z";
const MAX_AGE_SECONDS = 60;

describe("Safety notification input readiness", () => {
  it("marks a fresh warning-free snapshot ready without interpreting zero alerts as a failure", () => {
    const result = evaluate();

    expect(result).toEqual({ status: "ready", snapshotGeneratedAt: FRESH, snapshotAgeSeconds: 30, reasons: [] });
  });

  it.each([
    { lastSuccessAt: FRESH, lastErrorAt: RECENT_ERROR },
    { lastSuccessAt: FRESH, lastErrorAt: FRESH },
    { lastSuccessAt: undefined, lastErrorAt: RECENT_ERROR }
  ])("fails closed for an unresolved response-cache failure: %j", (timestamps) => {
    const result = evaluate(collection(), cache(timestamps));

    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("response_cache_error_unrecovered");
  });

  it("allows recovery only after a strictly newer fresh success, ignoring historical counters", () => {
    const result = evaluate(collection(), cache({ lastSuccessAt: RECOVERED, lastErrorAt: RECENT_ERROR, errors: 3, staleHits: 2 }), [
      sourceCache({ lastSuccessAt: RECOVERED, lastErrorAt: RECENT_ERROR, errors: 4, staleHits: 1 })
    ]);

    expect(result.status).toBe("ready");
    expect(result.reasons).toEqual([]);
  });

  it("rejects an unresolved requested-source error but ignores unrequested source caches", () => {
    const requestedFailure = sourceCache({ lastSuccessAt: FRESH, lastErrorAt: RECENT_ERROR });
    const unrelatedFailure = sourceCache({ sourceId: "chmi_hydro", lastSuccessAt: OLD, lastErrorAt: RECENT_ERROR });
    const rejected = evaluate(collection(), cache(), [requestedFailure, unrelatedFailure]);
    const accepted = evaluate(collection(), cache(), [sourceCache(), unrelatedFailure]);

    expect(rejected.status).toBe("unavailable");
    expect(rejected.reasons).toEqual(["requested_source_cache_error_unrecovered"]);
    expect(accepted.status).toBe("ready");
  });

  it("does not promote a freshly generated aggregate over an old requested-source success", () => {
    const result = evaluate(collection(), cache(), [sourceCache({ lastSuccessAt: OLD })]);

    expect(result.status).toBe("unavailable");
    expect(result.reasons).toEqual(["requested_source_cache_success_stale"]);
  });

  it("does not promote a fresh-looking snapshot over an old response-cache success", () => {
    const result = evaluate(collection(), cache({ lastSuccessAt: OLD }));

    expect(result.status).toBe("unavailable");
    expect(result.reasons).toEqual(["response_cache_success_stale"]);
  });

  it("fails closed after the snapshot freshness budget without rounding it down", () => {
    const result = evaluate(collection({ generatedAt: "2026-10-10T09:58:59.999Z" }));

    expect(result.status).toBe("unavailable");
    expect(result.snapshotAgeSeconds).toBeCloseTo(60.001);
    expect(result.reasons).toEqual(["snapshot_expired"]);
    expect(evaluate(collection({ generatedAt: "2026-10-10T09:59:00.000Z" })).status).toBe("ready");
  });

  it("tolerates at most five seconds of future snapshot clock skew", () => {
    expect(evaluate(collection({ generatedAt: "2026-10-10T10:00:05.000Z" })).status).toBe("ready");
    const rejected = evaluate(collection({ generatedAt: "2026-10-10T10:00:05.001Z" }));

    expect(rejected.status).toBe("unavailable");
    expect(rejected.snapshotAgeSeconds).toBe(0);
    expect(rejected.reasons).toEqual(["snapshot_timestamp_future"]);
  });

  it("returns unknown age for an invalid snapshot timestamp", () => {
    const result = evaluate(collection({ generatedAt: "not-a-timestamp" }));

    expect(result.status).toBe("unavailable");
    expect(result.snapshotAgeSeconds).toBeNull();
    expect(result.reasons).toEqual(["snapshot_timestamp_invalid"]);
  });

  it.each([
    { lastSuccessAt: "invalid", reason: "timestamp_invalid" },
    { lastErrorAt: "invalid", reason: "timestamp_invalid" },
    { lastSuccessAt: "2026-10-10T10:00:06.000Z", reason: "timestamp_future" }
  ])("does not silently accept invalid or future cache evidence: %j", ({ reason, ...timestamps }) => {
    const responseResult = evaluate(collection(), cache(timestamps));
    const sourceResult = evaluate(collection(), cache(), [sourceCache(timestamps)]);

    expect(responseResult.status).toBe("unavailable");
    expect(responseResult.reasons).toContain(`response_cache_${reason}`);
    expect(sourceResult.status).toBe("unavailable");
    expect(sourceResult.reasons).toContain(`requested_source_cache_${reason}`);
  });

  it("rejects source warnings with sanitized reasons and no source identifiers, URLs or payloads", () => {
    const result = evaluate(collection({ warnings: ["source-123 https://private.example.test/feed?token=secret provider payload"] }));

    expect(result.status).toBe("unavailable");
    expect(result.reasons).toEqual(["source_warnings_present"]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("source-123");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("secret");
  });

  it.each([2, 3])("reports incomplete coverage when %i features meet or exceed the known input limit", (count) => {
    const features = Array.from({ length: count }, (_, index) => feature(index));
    const input = collection({ features });
    input.query.limit = 2;
    const result = evaluate(input);

    expect(result.status).toBe("incomplete");
    expect(result.reasons).toEqual(["input_limit_reached"]);
  });

  it("prioritizes unavailable evidence over known truncation and preserves both reasons", () => {
    const input = collection({ features: [feature(1)], warnings: ["upstream error"] });
    input.query.limit = 1;
    const result = evaluate(input);

    expect(result.status).toBe("unavailable");
    expect(result.reasons).toEqual(["source_warnings_present", "input_limit_reached"]);
  });

  it("keeps caches without timestamped activity neutral for synthetic or non-cached sources", () => {
    const result = evaluate(collection(), cache({ lastSuccessAt: undefined }), [sourceCache({ lastSuccessAt: undefined })]);

    expect(result.status).toBe("ready");
  });

  it("fails closed for an invalid clock or freshness budget", () => {
    const invalidClock = evaluateNotificationInput(collection(), cache(), [], MAX_AGE_SECONDS, Number.NaN);
    const invalidLimit = evaluateNotificationInput(collection(), cache(), [], Number.NaN, NOW);

    expect(invalidClock.status).toBe("unavailable");
    expect(invalidClock.snapshotAgeSeconds).toBeNull();
    expect(invalidClock.reasons).toContain("evaluation_time_invalid");
    expect(invalidLimit.status).toBe("unavailable");
    expect(invalidLimit.reasons).toContain("snapshot_age_limit_invalid");
  });

  it("does not mutate the collection or cache evidence", () => {
    const input = collection();
    const response = cache();
    const source = sourceCache();
    const before = JSON.stringify({ input, response, source });

    evaluate(input, response, [source]);

    expect(JSON.stringify({ input, response, source })).toBe(before);
  });
});

function evaluate(input = collection(), response = cache(), sources: SourceCacheStats[] = [sourceCache()]) {
  return evaluateNotificationInput(input, response, sources, MAX_AGE_SECONDS, NOW);
}

function cache(overrides: Partial<ManagedResponseCacheStats> = {}): ManagedResponseCacheStats {
  return {
    entries: 1,
    inflight: 0,
    maxEntries: 10,
    hits: 0,
    misses: 1,
    coalescedHits: 0,
    staleHits: 0,
    refreshes: 1,
    errors: 0,
    evictions: 0,
    lastSuccessAt: FRESH,
    ...overrides
  };
}

function sourceCache(overrides: Partial<SourceCacheStats> = {}): SourceCacheStats {
  return { ...cache(), sourceId: "chmi_alerts", ...overrides };
}

function collection(overrides: Partial<SafetyFeatureCollection> = {}): SafetyFeatureCollection {
  return {
    contractVersion: "cop-safety-source-v1",
    type: "FeatureCollection",
    generatedAt: FRESH,
    source: { sourceId: "safety-data-api", sourceType: "PUBLIC_SAFETY_AGGREGATE", generatedAt: FRESH },
    query: { bbox: { west: 12, south: 48, east: 19, north: 52 }, layers: ["weather_alerts"], limit: 100, sources: ["chmi_alerts"] },
    summary: { featureCount: 0, sourceCount: 1, staleFeatureCount: 0, advisoryCount: 0, warningCount: 0, criticalCount: 0 },
    features: [],
    sources: [],
    warnings: [],
    ...overrides
  };
}

function feature(index: number): SafetyFeature {
  return {
    type: "Feature",
    id: `fixture-${index}`,
    geometry: { type: "Point", coordinates: [17.4647, 49.9884] },
    properties: {
      featureId: `fixture-${index}`,
      layer: "weather_alerts",
      category: "weather_warning",
      hazardType: "wind",
      headline: "Fixture warning",
      sourceId: "chmi_alerts",
      source: "chmi_alerts",
      sourceName: "Fixture",
      observedAt: FRESH,
      validFrom: FRESH,
      updatedAt: FRESH,
      confidence: 1,
      stale: false,
      severity: "warning",
      status: "active",
      urgency: "immediate",
      certainty: "observed",
      basis: ["test_fixture"],
      license: { name: "Synthetic", attribution: "Synthetic" }
    }
  };
}
