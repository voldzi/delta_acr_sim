import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSafetyNotificationCandidateCollection } from "../src/notification-candidates.js";
import type { SafetyFeature, SafetyFeatureCollection, SafetyFeatureProperties } from "../src/types.js";

const NOW = "2026-10-10T10:00:00.000Z";
const VALID_FROM = "2026-10-10T09:00:00.000Z";
const VALID_UNTIL = "2026-10-10T11:00:00.000Z";

describe("Safety notification precision and provenance guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves synthetic point candidates and stable identifiers without inventing precision", () => {
    const result = candidates([feature()]);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.candidateId).toBe(`sim.safety-data:safety.weather_alerts:weather_alerts:mock:wind:${VALID_FROM}:${VALID_UNTIL}`);
    expect(result.candidates[0]?.idempotencyKey).toBe(result.candidates[0]?.candidateId);
    expect(result.candidates[0]?.messaging.recommendedChannels).toEqual(["push", "in_app"]);
    expect(result.summary.eligibilitySkippedCount).toBe(0);
    expect(result.summary.eligibilitySkippedReasons).toEqual({});
    expect(result.policy.eligibilityPolicy).toBe("verified_alert_and_non_fallback_location_required");
  });

  it.each(["authority_fallback_point", "region_centroid", "municipality_centroid", "admin_boundary_centroid"])(
    "does not produce a radius-push candidate from %s even with a named affected area",
    (locationPrecision) => {
      const result = candidates([feature({ tags: { locationPrecision }, affectedArea: "Město Bruntál" })]);

      expect(result.candidates).toEqual([]);
      expect(result.summary).toEqual(expect.objectContaining({ eligibilitySkippedCount: 1, eligibilitySkippedReasons: { approximate_location: 1 } }));
    }
  );

  it("excludes a CHMI representative point while preserving the authoritative polygon forecast", () => {
    const point = feature({ sourceId: "chmi_alerts", tags: { geometryMode: "representative_point" }, basis: ["chmi_cap", "chmi_cap_representative_point"] });
    const polygon: SafetyFeature = {
      ...point,
      id: "weather_alerts:chmi_alerts:polygon",
      properties: { ...point.properties, featureId: "weather_alerts:chmi_alerts:polygon", tags: { geometryMode: "admin_boundary" }, basis: ["chmi_cap"] },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [17.4, 49.9],
            [17.5, 49.9],
            [17.5, 50.0],
            [17.4, 49.9]
          ]
        ]
      }
    };
    const result = candidates([point, polygon]);

    expect(result.candidates.map((candidate) => candidate.feature.featureId)).toEqual([polygon.id]);
    expect(result.summary.eligibilitySkippedReasons).toEqual({ approximate_location: 1 });
    expect(result.candidates[0]?.feature.geometry).toEqual(polygon.geometry);
  });

  it("honors provider denial and informational-only metadata even for critical precise features", () => {
    const result = candidates([
      feature({ featureId: "denied", severity: "critical", providerProperties: { notification: { eligible: false } } }),
      feature({ featureId: "context", severity: "critical", providerProperties: { informationalOnly: true, notification: { eligible: true } } }),
      feature({ featureId: "nested-context", severity: "critical", providerProperties: { notification: { informationalOnly: true } } }),
      feature({ featureId: "tagged-context", severity: "critical", tags: { informationalOnly: "true" } })
    ]);

    expect(result.candidates).toEqual([]);
    expect(result.summary.eligibilitySkippedCount).toBe(4);
    expect(result.summary.eligibilitySkippedReasons).toEqual({ provider_not_eligible: 1, informational_only: 3 });
  });

  it("does not treat a geolocated municipal bulletin as a verified alert", () => {
    const result = candidates([municipalFeature({ tags: { locationPrecision: "source_point", feedFormat: "rss" } })]);

    expect(result.candidates).toEqual([]);
    expect(result.summary.eligibilitySkippedReasons).toEqual({ unverified_municipal_alert: 1 });
  });

  it("does not promote article publication with a fabricated expiry to actual event validity", () => {
    const result = candidates([
      municipalFeature({ providerProperties: { notification: { eligible: true, validityBasis: "article_publication" } } }),
      municipalFeature({ featureId: "missing-basis", providerProperties: { notification: { eligible: true } } })
    ]);

    expect(result.candidates).toEqual([]);
    expect(result.summary.eligibilitySkippedReasons).toEqual({ unknown_municipal_event_validity: 2 });
  });

  it("allows a verified municipal alert only during its explicitly parsed event interval", () => {
    const alert = municipalFeature({ providerProperties: { notification: { eligible: true, validityBasis: "explicit_event_interval" } } });
    const result = candidates([alert]);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.feature.validFrom).toBe(VALID_FROM);
    expect(result.candidates[0]?.feature.validUntil).toBe(VALID_UNTIL);
    expect(result.summary.eligibilitySkippedCount).toBe(0);
  });

  it.each([{ validFrom: "not-a-date" }, { validUntil: undefined }, { validUntil: VALID_FROM }, { validUntil: "2026-10-10T08:00:00.000Z" }])(
    "rejects missing, invalid or unordered explicit event intervals: %j",
    (validity) => {
      const result = candidates([
        municipalFeature({ ...validity, providerProperties: { notification: { eligible: true, validityBasis: "explicit_event_interval" } } })
      ]);

      expect(result.candidates).toEqual([]);
      expect(result.summary.eligibilitySkippedReasons).toEqual({ unknown_municipal_event_validity: 1 });
    }
  );

  it.each([
    { validFrom: "2026-10-10T10:30:00.000Z" },
    { validFrom: "2026-10-10T08:00:00.000Z", validUntil: NOW },
    { status: "expired" },
    { status: "cancelled" }
  ])("rejects inactive municipal intervals and statuses: %j", (validity) => {
    const result = candidates([
      municipalFeature({ ...validity, providerProperties: { notification: { eligible: true, validityBasis: "explicit_event_interval" } } })
    ]);

    expect(result.candidates).toEqual([]);
    expect(result.summary.eligibilitySkippedReasons).toEqual({ inactive_municipal_alert: 1 });
  });

  it("reports disjoint skip counts and does not allow includeStale to bypass eligibility", () => {
    const alert = feature({ featureId: "eligible" });
    const result = buildSafetyNotificationCandidateCollection(
      collection([
        alert,
        alert,
        feature({ featureId: "non-notification", layer: "boundary_admin" }),
        feature({ featureId: "below-severity", severity: "info" }),
        feature({ featureId: "stale-approximate", stale: true, tags: { locationPrecision: "region_centroid" } })
      ]),
      { minSeverity: "advisory", includeStale: true }
    );

    expect(result.summary).toEqual(
      expect.objectContaining({
        featureCount: 5,
        candidateCount: 1,
        skippedCount: 4,
        nonNotificationLayerSkippedCount: 1,
        belowSeveritySkippedCount: 1,
        staleSkippedCount: 0,
        duplicateSkippedCount: 1,
        eligibilitySkippedCount: 1
      })
    );
    expect(result.summary.skippedCount).toBe(
      result.summary.nonNotificationLayerSkippedCount +
        result.summary.belowSeveritySkippedCount +
        result.summary.staleSkippedCount +
        result.summary.duplicateSkippedCount +
        result.summary.eligibilitySkippedCount
    );
  });
});

function candidates(features: SafetyFeature[]) {
  return buildSafetyNotificationCandidateCollection(collection(features), { minSeverity: "advisory", includeStale: false });
}

function municipalFeature(properties: Partial<SafetyFeatureProperties> = {}): SafetyFeature {
  return feature({
    sourceId: "municipal_alerts",
    source: "municipal_alerts",
    layer: "warnings",
    category: "municipal_crisis_alert",
    tags: { locationPrecision: "source_pkr_json" },
    ...properties
  });
}

function feature(properties: Partial<SafetyFeatureProperties> = {}): SafetyFeature {
  const featureId = properties.featureId ?? "weather_alerts:mock:wind";
  return {
    type: "Feature",
    id: featureId,
    geometry: { type: "Point", coordinates: [17.4647, 49.9884] },
    properties: {
      featureId,
      layer: "weather_alerts",
      category: "weather_warning",
      hazardType: "wind",
      headline: "Synthetic wind warning",
      sourceId: "mock",
      source: "mock",
      sourceName: "Synthetic fixture",
      observedAt: VALID_FROM,
      validFrom: VALID_FROM,
      validUntil: VALID_UNTIL,
      updatedAt: VALID_FROM,
      confidence: 1,
      stale: false,
      severity: "warning",
      status: "active",
      urgency: "immediate",
      certainty: "observed",
      basis: ["test_fixture"],
      license: { name: "Synthetic", attribution: "Synthetic" },
      ...properties
    }
  };
}

function collection(features: SafetyFeature[]): SafetyFeatureCollection {
  return {
    contractVersion: "cop-safety-source-v1",
    type: "FeatureCollection",
    generatedAt: NOW,
    source: { sourceId: "safety-data-api", sourceType: "PUBLIC_SAFETY_AGGREGATE", generatedAt: NOW },
    query: {
      bbox: { west: 12, south: 48, east: 19, north: 52 },
      layers: ["weather_alerts", "warnings", "fire", "flood", "boundary_admin"],
      limit: 100,
      sources: ["mock"]
    },
    summary: { featureCount: features.length, sourceCount: 1, staleFeatureCount: 0, advisoryCount: 0, warningCount: features.length, criticalCount: 0 },
    features,
    sources: [],
    warnings: []
  };
}
