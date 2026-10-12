import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type SituationDataConfig } from "../src/config.js";
import { SearchDataService } from "../src/search-data.js";

describe("Search Data Safety boundary", () => {
  let dataDir: string;
  let config: SituationDataConfig;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "sim-search-boundary-"));
    vi.stubEnv("SITUATION_DATA_DIR", dataDir);
    config = {
      ...(await loadConfig()),
      enabledSources: ["safety_data"],
      osmPostgisConnectionString: undefined,
      safetyDataBaseUrl: "http://safety.test",
      requestTimeoutMs: 8000,
      searchDataCacheTtlSeconds: 300,
      staleIfErrorSeconds: 1800
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true });
  });
  const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const awaitAbort = (signal: AbortSignal) =>
    new Promise<never>((_, reject) => {
      const abort = () => reject(new DOMException("sensitive provider error", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });

  it.each(["headers", "body"])("bounds stalled %s by 4500ms and retains an attributable partial result", async (phase) => {
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      if (phase === "headers") return awaitAbort(init.signal!);
      return { ok: true, json: () => awaitAbort(init.signal!) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new SearchDataService(config);
    const pending = service.entities({ limit: 1000 });
    await vi.advanceTimersByTimeAsync(4500);
    const feed = await pending;
    expect(feed.warnings).toEqual(["SEARCH_SOURCE_TIMEOUT:safety_data"]);
    expect(feed.summary.warningCount).toBe(1);
    expect(feed.entities).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a shorter configured deadline instead of extending it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => awaitAbort(init.signal!))
    );
    const pending = new SearchDataService({ ...config, requestTimeoutMs: 20 }).entities({});
    await vi.advanceTimersByTimeAsync(20);
    expect((await pending).warnings).toEqual(["SEARCH_SOURCE_TIMEOUT:safety_data"]);
  });

  it("recovers after 30 seconds without waiting the complete-feed five-minute TTL", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("private error", "AbortError"))
      .mockImplementation(async () => response({ features: [], warnings: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new SearchDataService(config);
    const partial = await service.entities({ limit: 1000 });
    await vi.advanceTimersByTimeAsync(29_999);
    const partialProjection = await service.entities({ limit: 1000 });
    expect(partialProjection).not.toBe(partial);
    expect(partialProjection).toMatchObject({
      generatedAt: partial.generatedAt,
      entities: partial.entities,
      summary: partial.summary,
      warnings: partial.warnings
    });
    expect(partialProjection.freshness?.evaluatedAt).toBe(new Date().toISOString());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const recovered = await service.entities({ limit: 1000 });
    expect(recovered.warnings).toEqual([]);
    expect(recovered.generatedAt).not.toBe(partial.generatedAt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(299_999);
    const recoveredProjection = await service.entities({ limit: 1000 });
    expect(recoveredProjection).not.toBe(recovered);
    expect(recoveredProjection).toMatchObject({
      generatedAt: recovered.generatedAt,
      entities: recovered.entities,
      summary: recovered.summary,
      warnings: recovered.warnings
    });
    expect(recoveredProjection.freshness?.evaluatedAt).toBe(new Date().toISOString());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await service.entities({ limit: 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("propagates Safety 200 partial metadata without leaking raw warning content", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => response({ features: [], warnings: ["secret credential and raw provider text"] }))
      .mockImplementation(async () => response({ features: [], warnings: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new SearchDataService(config);
    const partial = await service.entities({});
    expect(partial.warnings).toEqual(["SEARCH_SOURCE_INCOMPLETE:safety_data"]);
    expect(JSON.stringify(partial)).not.toContain("secret");
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await service.entities({})).summary.warningCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sanitizes non-timeout transport failures rather than emitting URLs or provider errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("postgres://user:secret@private.test and raw payload")));
    const result = await new SearchDataService(config).entities({});
    expect(result.warnings).toEqual(["SEARCH_SOURCE_UNAVAILABLE:safety_data"]);
    expect(JSON.stringify(result)).not.toMatch(/private\.test|postgres|secret/);
  });

  it("preserves stale source observations and expiry instead of making them current", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          features: [
            {
              type: "Feature",
              id: "synthetic-test",
              geometry: { type: "Point", coordinates: [14, 50] },
              properties: { sourceId: "chmi_hydro", layer: "flood", observedAt: "2026-10-10T10:00:00Z", validUntil: "2026-10-10T11:00:00Z", stale: true }
            }
          ],
          warnings: []
        })
      )
    );
    const result = await new SearchDataService(config).entities({});
    expect(result.summary.staleEntityCount).toBe(1);
    expect(result.entities[0]).toMatchObject({
      stale: true,
      status: "expired",
      observedAt: "2026-10-10T10:00:00.000Z",
      validUntil: "2026-10-10T11:00:00.000Z"
    });
  });
});
