import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type SituationDataConfig } from "../src/config.js";
import { projectSearchFeedFreshness, SearchDataService, type SearchEntity, type SearchEntityFeed } from "../src/search-data.js";

const now = Date.parse("2026-10-12T00:00:00Z");
const iso = (offsetMs = 0) => new Date(now + offsetMs).toISOString();

function entity(overrides: Partial<SearchEntity> = {}): SearchEntity {
  return {
    contractVersion: "sim-search-source-v1",
    providerId: "sim.search-data",
    providerEntityId: "synthetic-reference-1",
    sourceSystem: "osm_reference",
    sourceEntityId: "synthetic-source-1",
    entityType: "police_station",
    title: "Synthetic reference point",
    summary: "Synthetic test only",
    searchableText: "synthetic reference point",
    aliases: [],
    localized: { cs: { title: "Syntetický bod", summary: "Pouze test" } },
    geometry: { type: "Point", coordinates: [14, 50] },
    centroid: { lat: 50, lon: 14 },
    address: { countryCode: "CZ" },
    status: "active",
    severity: null,
    confidence: 0.5,
    dataQuality: "reference",
    sourceAuthority: "reference",
    classification: "PUBLIC",
    handling: ["server_to_server"],
    visibility: "cop_internal",
    allowedUse: ["search"],
    observedAt: iso(-300_000),
    validFrom: iso(-300_000),
    validUntil: iso(60_000),
    updatedAt: iso(-120_000),
    expiresAt: iso(60_000),
    stale: false,
    sourceRevision: "synthetic:immutable-source-revision",
    layerIds: [],
    tags: ["synthetic"],
    metrics: {},
    positionQuality: { accuracy: "exact", source: "synthetic" },
    providerProperties: {},
    deleted: false,
    ...overrides
  };
}

function feed(entities: SearchEntity[] = [entity()], overrides: Partial<SearchEntityFeed> = {}): SearchEntityFeed {
  return {
    contractVersion: "sim-search-source-v1",
    providerId: "sim.search-data",
    generatedAt: iso(-10_000),
    query: { limit: 1, entityTypes: ["police_station"], sourceSystems: [], includeDeleted: false },
    summary: { entityCount: 73, returnedCount: entities.length, staleEntityCount: 11, deletedCount: 0, warningCount: 0 },
    entities,
    nextCursor: "synthetic-unchanged-cursor",
    warnings: [],
    ...overrides
  };
}

describe("returned Search Data freshness projection", () => {
  it("returns additive page diagnostics without changing fresh entity fields or source timestamps", () => {
    const original = feed(),
      before = structuredClone(original);
    Object.freeze(original.entities[0]);
    const projected = projectSearchFeedFreshness(original, now);
    expect(projected).not.toBe(original);
    expect(projected.entities[0]).toEqual(before.entities[0]);
    expect(projected.generatedAt).toBe(before.generatedAt);
    expect(projected.summary).toEqual(before.summary);
    expect(projected.query).toEqual(before.query);
    expect(projected.nextCursor).toBe(before.nextCursor);
    expect(projected.freshness).toEqual({
      scope: "returned_entities",
      evaluatedAt: iso(),
      feedTimestampState: "valid",
      feedAgeSeconds: 10,
      returnedStaleCount: 0,
      returnedExpiredCount: 0,
      missingExpiryCount: 0,
      invalidExpiryCount: 0
    });
    expect(original).toEqual(before);
  });

  it.each([
    { validUntil: iso(60_000), expiresAt: iso(-1) },
    { validUntil: iso(-1), expiresAt: iso(60_000) },
    { validUntil: iso(), expiresAt: iso(60_000) },
    { validUntil: iso(60_000), expiresAt: iso() }
  ])("uses the earliest deadline, including equality, and never trusts stale:false (%j)", (deadlines) => {
    const original = feed([entity({ ...deadlines, stale: false })]),
      projected = projectSearchFeedFreshness(original, now);
    expect(projected.entities[0]).toMatchObject({ ...deadlines, stale: true, status: "expired" });
    expect(projected.entities[0]!.observedAt).toBe(original.entities[0]!.observedAt);
    expect(projected.entities[0]!.updatedAt).toBe(original.entities[0]!.updatedAt);
    expect(projected.entities[0]!.sourceRevision).toBe(original.entities[0]!.sourceRevision);
    expect(projected.freshness).toMatchObject({ returnedStaleCount: 1, returnedExpiredCount: 1 });
    expect(original.entities[0]!.stale).toBe(false);
    expect(original.entities[0]!.status).toBe("active");
  });

  it("does not make an explicitly expired record current even if deadlines are future", () => {
    const projected = projectSearchFeedFreshness(feed([entity({ status: "expired", stale: false })]), now);
    expect(projected.entities[0]).toMatchObject({ stale: true, status: "expired" });
    expect(projected.freshness).toMatchObject({ returnedStaleCount: 1, returnedExpiredCount: 1 });
  });

  it("never changes source stale:true to false", () => {
    const original = feed([entity({ stale: true })]);
    const projected = projectSearchFeedFreshness(original, now);
    expect(projected.entities[0]).toMatchObject({ stale: true, status: "active" });
    expect(projected.freshness).toMatchObject({ returnedStaleCount: 1, returnedExpiredCount: 0 });
    expect(original.entities[0]!.stale).toBe(true);
  });

  it.each([
    { validUntil: "not-an-expiry", expiresAt: iso(60_000) },
    { validUntil: iso(60_000), expiresAt: "not-an-expiry" },
    { validUntil: "2026-02-30T00:00:00Z", expiresAt: iso(60_000) },
    { validUntil: "not-an-expiry", expiresAt: null }
  ])("marks invalid expiry unknown and stale, never fresh (%j)", (deadlines) => {
    const projected = projectSearchFeedFreshness(feed([entity(deadlines)]), now);
    expect(projected.entities[0]).toMatchObject({ ...deadlines, stale: true, status: "unknown" });
    expect(projected.freshness).toMatchObject({ returnedStaleCount: 1, returnedExpiredCount: 0, invalidExpiryCount: 1 });
  });

  it("keeps an expired deadline dominant while still diagnosing another invalid expiry", () => {
    const projected = projectSearchFeedFreshness(feed([entity({ validUntil: iso(-1), expiresAt: "invalid-expiry" })]), now);
    expect(projected.entities[0]).toMatchObject({ stale: true, status: "expired" });
    expect(projected.freshness).toMatchObject({ returnedStaleCount: 1, returnedExpiredCount: 1, invalidExpiryCount: 1 });
  });

  it("diagnoses missing reference expiry without inventing an expiry or operational validity", () => {
    const original = feed([entity({ validUntil: null, expiresAt: null })]);
    const projected = projectSearchFeedFreshness(original, now);
    expect(projected.entities[0]).toEqual(original.entities[0]);
    expect(projected.entities[0]).toMatchObject({ validUntil: null, expiresAt: null });
    expect(projected.freshness).toMatchObject({ missingExpiryCount: 1, invalidExpiryCount: 0, returnedExpiredCount: 0 });
  });

  it("marks a dynamic record without either expiry unknown and stale without inventing source times", () => {
    const original = feed([
      entity({
        sourceSystem: "chmi_hydro",
        sourceAuthority: "official",
        entityType: "hydro_measurement",
        validUntil: null,
        expiresAt: null,
        stale: false
      })
    ]);
    const projected = projectSearchFeedFreshness(original, now);
    expect(projected.entities[0]).toMatchObject({ status: "unknown", stale: true, validUntil: null, expiresAt: null });
    expect(projected.entities[0]!.observedAt).toBe(original.entities[0]!.observedAt);
    expect(projected.entities[0]!.validFrom).toBe(original.entities[0]!.validFrom);
    expect(projected.entities[0]!.updatedAt).toBe(original.entities[0]!.updatedAt);
    expect(projected.entities[0]!.sourceRevision).toBe(original.entities[0]!.sourceRevision);
    expect(projected.generatedAt).toBe(original.generatedAt);
    expect(projected.freshness).toMatchObject({ missingExpiryCount: 1, returnedStaleCount: 1, returnedExpiredCount: 0 });
    expect(original.entities[0]!.stale).toBe(false);
  });

  it.each([
    { generatedAt: "not-a-feed-timestamp", state: "invalid" },
    { generatedAt: "2026-02-30T00:00:00Z", state: "invalid" },
    { generatedAt: iso(1_000), state: "future" }
  ])("does not manufacture feed age from $state generatedAt", ({ generatedAt, state }) => {
    const projected = projectSearchFeedFreshness(feed([], { generatedAt }), now);
    expect(projected.generatedAt).toBe(generatedAt);
    expect(projected.freshness).toMatchObject({ feedTimestampState: state, feedAgeSeconds: null, evaluatedAt: iso() });
  });

  it.each([
    { generatedAt: "not-a-feed-timestamp", state: "invalid" },
    { generatedAt: "2026-02-30T00:00:00Z", state: "invalid" },
    { generatedAt: iso(1_000), state: "future" }
  ])("prevents current dynamic claims under a $state feed timestamp while preserving timeless OSM references", ({ generatedAt, state }) => {
    const reference = entity({ validUntil: null, expiresAt: null }),
      dynamic = entity({ providerEntityId: "synthetic-dynamic", sourceSystem: "chmi_hydro", sourceAuthority: "official", entityType: "hydro_measurement" }),
      original = feed([reference, dynamic], { generatedAt });
    const projected = projectSearchFeedFreshness(original, now);
    expect(projected.entities[0]).toEqual(reference);
    expect(projected.entities[1]).toMatchObject({ status: "unknown", stale: true });
    expect(projected.entities[1]!.observedAt).toBe(dynamic.observedAt);
    expect(projected.entities[1]!.updatedAt).toBe(dynamic.updatedAt);
    expect(projected.entities[1]!.validUntil).toBe(dynamic.validUntil);
    expect(projected.entities[1]!.expiresAt).toBe(dynamic.expiresAt);
    expect(projected.entities[1]!.sourceRevision).toBe(dynamic.sourceRevision);
    expect(projected.generatedAt).toBe(generatedAt);
    expect(projected.freshness).toMatchObject({
      feedTimestampState: state,
      feedAgeSeconds: null,
      returnedStaleCount: 1,
      returnedExpiredCount: 0,
      missingExpiryCount: 1
    });
    expect(original.entities[1]!.stale).toBe(false);
  });

  it("counts the returned page separately from unchanged collection summary and does not reorder entities", () => {
    const original = feed([
      entity({ providerEntityId: "second-synthetic-id", validUntil: iso(-1), expiresAt: iso(-1) }),
      entity({ providerEntityId: "first-synthetic-id", validUntil: "invalid", expiresAt: null })
    ]);
    const projected = projectSearchFeedFreshness(original, now);
    expect(projected.summary).toEqual(original.summary);
    expect(projected.summary).toMatchObject({ entityCount: 73, returnedCount: 2, staleEntityCount: 11 });
    expect(projected.entities.map((item) => item.providerEntityId)).toEqual(original.entities.map((item) => item.providerEntityId));
    expect(projected.nextCursor).toBe(original.nextCursor);
    expect(projected.freshness).toMatchObject({ returnedStaleCount: 2, returnedExpiredCount: 1, missingExpiryCount: 0, invalidExpiryCount: 1 });
  });
});

describe("cached Search Data expiry and Safety source truth", () => {
  let dataDir: string;
  let config: SituationDataConfig;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "sim-search-freshness-"));
    vi.stubEnv("SITUATION_DATA_DIR", dataDir);
    config = {
      ...(await loadConfig()),
      enabledSources: ["safety_data"],
      osmPostgisConnectionString: undefined,
      safetyDataBaseUrl: "http://synthetic.safety",
      searchDataCacheTtlSeconds: 300,
      staleIfErrorSeconds: 1800
    };
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true });
  });

  const response = (body: unknown) => Response.json(body);
  const feature = (id: string, overrides: Record<string, unknown> = {}) => ({
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [14, 50] },
    properties: {
      sourceId: "chmi_hydro",
      layer: "flood",
      headline: "Synthetic observation",
      observedAt: iso(-60_000),
      validUntil: iso(20_000),
      stale: false,
      ...overrides
    }
  });

  it("projects expiration before the five-minute cache TTL without fetching or mutating the cached feed", async () => {
    const fetchMock = vi.fn(async () => response({ features: [feature("synthetic-cache-expiry")], warnings: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new SearchDataService(config),
      first = await service.entities({ limit: 1 });
    const entries = (service as unknown as { cache: { entries: Map<string, { value: SearchEntityFeed }> } }).cache.entries;
    const cached = entries.values().next().value!.value,
      stored = structuredClone(cached);
    expect(first.entities[0]!.stale).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    const projected = await service.entities({ limit: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(projected.entities[0]).toMatchObject({ stale: true, status: "expired" });
    expect(projected.generatedAt).toBe(first.generatedAt);
    expect(projected.summary).toEqual(first.summary);
    expect(projected.entities[0]!.sourceRevision).toBe(first.entities[0]!.sourceRevision);
    expect(projected.freshness).toMatchObject({ feedAgeSeconds: 20, returnedStaleCount: 1, returnedExpiredCount: 1 });
    expect(first.entities[0]!.stale).toBe(false);
    expect(cached).toEqual(stored);
    expect(cached.entities[0]!.stale).toBe(false);
    expect(cached.entities[0]!.status).toBe("active");
  });

  it("preserves coalescing, page identity, cursor and the 30-second partial TTL while projecting expiry", async () => {
    const fetchMock = vi.fn(async () =>
      response({
        features: [feature("synthetic-a"), feature("synthetic-b"), feature("synthetic-c")],
        warnings: ["synthetic provider incomplete"]
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = new SearchDataService(config);
    const [first, concurrent] = await Promise.all([service.entities({ limit: 1 }), service.entities({ limit: 1 })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(concurrent.entities).toEqual(first.entities);
    expect(service.cacheStats().coalescedHits).toBe(1);
    expect(first.nextCursor).toBeDefined();
    expect(first.summary).toMatchObject({ entityCount: 3, returnedCount: 1, staleEntityCount: 0, warningCount: 1 });
    await vi.advanceTimersByTimeAsync(29_999);
    const projected = await service.entities({ limit: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(projected.nextCursor).toBe(first.nextCursor);
    expect(projected.entities.map((item) => item.providerEntityId)).toEqual(first.entities.map((item) => item.providerEntityId));
    expect(projected.summary).toEqual(first.summary);
    expect(projected.freshness).toMatchObject({ returnedStaleCount: 1, returnedExpiredCount: 1, evaluatedAt: iso(29_999) });
    await vi.advanceTimersByTimeAsync(1);
    const refreshed = await service.entities({ limit: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed.generatedAt).not.toBe(first.generatedAt);
    expect(refreshed.nextCursor).toBe(first.nextCursor);
  });

  it("excludes expired source records with stale:false from includeStale:false queries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ features: [feature("synthetic-expired-source", { validUntil: iso(-1), stale: false })], warnings: [] }))
    );
    const service = new SearchDataService(config);
    expect((await service.query({ includeStale: false })).entities).toEqual([]);
    const retained = await service.query({ includeStale: true });
    expect(retained.entities).toHaveLength(1);
    expect(retained.entities[0]).toMatchObject({ stale: true, status: "expired", observedAt: iso(-60_000), validUntil: iso(-1) });
    expect(retained.entities[0]!.sourceRevision).toBe(`chmi_hydro:${iso(-60_000)}`);
  });

  it("excludes dynamic Safety records with missing expiry unless stale results are requested", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          features: [feature("synthetic-no-expiry", { validUntil: null, expiresAt: null, stale: false })],
          warnings: []
        })
      )
    );
    const service = new SearchDataService(config);
    expect((await service.query({ includeStale: false })).entities).toEqual([]);
    const retained = await service.query({ includeStale: true });
    expect(retained.entities).toHaveLength(1);
    expect(retained.entities[0]).toMatchObject({
      status: "unknown",
      stale: true,
      validUntil: null,
      expiresAt: null,
      observedAt: iso(-60_000),
      updatedAt: iso(-60_000)
    });
    expect(retained.freshness).toMatchObject({ missingExpiryCount: 1, returnedStaleCount: 1, returnedExpiredCount: 0 });
  });

  it.each([
    { validUntil: "not-a-provider-expiry", expiresAt: iso(60_000) },
    { validUntil: iso(60_000), expiresAt: "not-a-provider-expiry" }
  ])("does not promote malformed raw Safety expiry when normalization leaves another future expiry (%j)", async (deadlines) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          features: [feature("synthetic-invalid-expiry", { ...deadlines, stale: false })],
          warnings: []
        })
      )
    );
    const service = new SearchDataService(config);
    expect((await service.query({ includeStale: false })).entities).toEqual([]);
    const retained = await service.query({ includeStale: true });
    expect(retained.entities).toHaveLength(1);
    expect(retained.entities[0]).toMatchObject({ status: "unknown", stale: true, observedAt: iso(-60_000), updatedAt: iso(-60_000) });
    expect(retained.entities[0]!.sourceRevision).toBe(`chmi_hydro:${iso(-60_000)}`);
    expect(retained.freshness).toMatchObject({ returnedStaleCount: 1, returnedExpiredCount: 0 });
  });

  it("reports the actual Safety result timestamp rather than the current observability timestamp", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          status: "ok",
          generatedAt: iso(),
          lastResult: { generatedAt: iso(-120_000), featureCount: 1, staleFeatureCount: 0 }
        })
      )
    );
    const source = (await new SearchDataService(config).observability()).sources.find((item) => item.sourceSystem === "safety_data")!;
    expect(source.lastSuccessAt).toBe(iso(-120_000));
    expect(source.lastSuccessAt).not.toBe(iso());
  });

  it.each([undefined, {}, { generatedAt: "not-a-source-time" }, { generatedAt: iso(1_000) }, { generatedAt: "2026-02-30T00:00:00Z" }])(
    "does not invent lastSuccessAt from empty or invalid Safety results (%j)",
    async (lastResult) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response({ status: "ok", generatedAt: iso(), ...(lastResult === undefined ? {} : { lastResult }) }))
      );
      const source = (await new SearchDataService(config).observability()).sources.find((item) => item.sourceSystem === "safety_data")!;
      expect(source.lastSuccessAt == null).toBe(true);
    }
  );
});
