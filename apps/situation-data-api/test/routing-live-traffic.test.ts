import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type SituationDataConfig } from "../src/config.js";
import { encodeValhallaPolyline6, RoutingService, routingTrafficCachePolicy, valhallaDepartureTimePayload, valhallaTrafficSpeedTypes } from "../src/routing-service.js";
import type { ValhallaTrafficCoordinator, ValhallaTrafficPublicStatus } from "../src/valhalla-traffic-coordinator.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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

describe("live traffic route expiry", () => {
  it("excludes current speeds until a usable overlay is acknowledged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const current = overlay();
    expect(valhallaTrafficSpeedTypes(current)).toContain("current");
    for (const state of ["idle", "warming", "stale", "degraded", "disabled"] as const) {
      expect(valhallaTrafficSpeedTypes({ ...current, state })).toEqual(["freeflow", "constrained", "predicted"]);
    }
    expect(valhallaTrafficSpeedTypes({ ...current, usableUntil: "2026-10-01T12:00:00Z" })).not.toContain("current");
    expect(valhallaTrafficSpeedTypes({ ...current, overlayGeneration: undefined })).not.toContain("current");
  });

  it("changes the cache key for an expiry or clear on the same provider revision", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const active = routingTrafficCachePolicy(overlay());
    expect(active.usableUntilMs).toBe(Date.parse("2026-10-01T12:01:00Z"));
    expect(routingTrafficCachePolicy({ ...overlay(), state: "stale" }).revision).not.toBe(active.revision);
    expect(routingTrafficCachePolicy({ ...overlay(), overlayGeneration: "clear-1", state: "degraded" }).revision).not.toBe(active.revision);
  });

  it.each([false, true])("routes with static speeds after a same-revision clear (truck=%s)", async (truck) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    let state = overlay();
    const coordinator = { activate: vi.fn(), status: vi.fn(async () => state) } as unknown as ValhallaTrafficCoordinator;
    const requests: Array<{ costing: string; costing_options: Record<string, { speed_types: string[] }> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/status")) return new Response(JSON.stringify({ tileset_last_modified: 1790679143 }), { status: 200 });
      const payload = JSON.parse(String(init?.body));
      requests.push(payload);
      const live = payload.costing_options[payload.costing].speed_types.includes("current");
      return routeReply(live ? 60 : 120);
    }));
    const service = new RoutingService(await config(), coordinator);
    const request = { profileId: "car" as const, from: { lon: 14.42, lat: 50.08 }, to: { lon: 14.422, lat: 50.082 },
      ...(truck ? { vehicle: { heightM: 2.2, widthM: 2.1, lengthM: 5.1, weightTonnes: 2.4 } } : {}) };
    expect((await service.route(request)).routes[0]!.durationSeconds).toBe(60);
    expect((await service.route(request)).routes[0]!.durationSeconds).toBe(60);
    expect(requests).toHaveLength(1);
    state = { ...state, state: "degraded", overlayGeneration: "clear-1", appliedEdgeCount: 0, usableUntil: new Date().toISOString() };
    const cleared = await service.route(request);
    expect(cleared.routes[0]!.durationSeconds).toBe(120);
    expect(cleared.traffic.liveSpeeds?.state).toBe("degraded");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.costing).toBe(truck ? "truck" : "auto");
    expect(requests[1]!.costing_options[truck ? "truck" : "auto"].speed_types).toEqual(["freeflow", "constrained", "predicted"]);
  });

  it("rejects a live-derived ETA if its deadline is crossed during calculation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const state = overlay();
    const coordinator = { activate: vi.fn(), status: vi.fn(async () => Date.now() >= Date.parse(state.usableUntil!) ? { ...state, state: "stale" } : state) } as unknown as ValhallaTrafficCoordinator;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/status")) return new Response(JSON.stringify({ tileset_last_modified: 1790679143 }), { status: 200 });
      vi.setSystemTime(new Date("2026-10-01T12:01:00Z"));
      return routeReply(60);
    }));
    const service = new RoutingService(await config(), coordinator);
    await expect(service.route({ profileId: "car", from: { lon: 14.42, lat: 50.08 }, to: { lon: 14.422, lat: 50.082 } })).rejects.toMatchObject({ status: 503, code: "ROUTING_TRAFFIC_CHANGED" });
  });

  it("checks the acknowledged generation again even on a cache hit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const status = vi.fn(async () => overlay());
    const coordinator = { activate: vi.fn(), status } as unknown as ValhallaTrafficCoordinator;
    const fetch = vi.fn(async (url: string) => String(url).endsWith("/status")
      ? new Response(JSON.stringify({ tileset_last_modified: 1790679143 }), { status: 200 }) : routeReply(60));
    vi.stubGlobal("fetch", fetch);
    const service = new RoutingService(await config(), coordinator);
    const request = { profileId: "car" as const, from: { lon: 14.42, lat: 50.08 }, to: { lon: 14.422, lat: 50.082 } };
    await service.route(request);
    const count = fetch.mock.calls.length;
    status.mockResolvedValueOnce(overlay()).mockResolvedValue({ ...overlay(), state: "degraded", overlayGeneration: "clear-1" });
    await expect(service.route(request)).rejects.toMatchObject({ status: 503, code: "ROUTING_TRAFFIC_CHANGED" });
    expect(fetch.mock.calls).toHaveLength(count);
  });

  it("does not use current speeds from an overlay for another routing dataset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const coordinator = { activate: vi.fn(), status: vi.fn(async () => overlay()) } as unknown as ValhallaTrafficCoordinator;
    let payload: { costing_options: { auto: { speed_types: string[] } } } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/status")) return new Response(JSON.stringify({ tileset_last_modified: 1790765543 }), { status: 200 });
      payload = JSON.parse(String(init?.body));
      return routeReply(120);
    }));
    const service = new RoutingService(await config(), coordinator);
    const response = await service.route({ profileId: "car", from: { lon: 14.42, lat: 50.08 }, to: { lon: 14.422, lat: 50.082 } });
    expect(payload!.costing_options.auto.speed_types).not.toContain("current");
    expect(response.traffic.liveSpeeds?.state).toBe("warming");
    expect(response.routes[0]!.durationSeconds).toBe(120);
  });

  it("rejects a cached live ETA after the active graph changes without a new report", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    let tileset = 1790679143;
    const coordinator = { activate: vi.fn(), status: vi.fn(async () => overlay()) } as unknown as ValhallaTrafficCoordinator;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).endsWith("/status")
      ? new Response(JSON.stringify({ tileset_last_modified: tileset }), { status: 200 }) : routeReply(60)));
    const service = new RoutingService(await config(), coordinator);
    const request = { profileId: "car" as const, from: { lon: 14.42, lat: 50.08 }, to: { lon: 14.422, lat: 50.082 } };
    expect((await service.route(request)).routes[0]!.durationSeconds).toBe(60);
    tileset = 1790765543;
    await expect(service.route(request)).rejects.toMatchObject({ status: 503, code: "ROUTING_TRAFFIC_CHANGED" });
  });

  it("checks the deadline after a slow final dataset verification", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const coordinator = { activate: vi.fn(), status: vi.fn(async () => overlay()) } as unknown as ValhallaTrafficCoordinator;
    let statusRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/status")) {
        if (++statusRequests === 3) vi.setSystemTime(new Date("2026-10-01T12:01:00Z"));
        return new Response(JSON.stringify({ tileset_last_modified: 1790679143 }), { status: 200 });
      }
      return routeReply(60);
    }));
    const service = new RoutingService(await config(), coordinator);
    await expect(service.route({ profileId: "car", from: { lon: 14.42, lat: 50.08 }, to: { lon: 14.422, lat: 50.082 } }))
      .rejects.toMatchObject({ status: 503, code: "ROUTING_TRAFFIC_CHANGED" });
  });

  it("does not attach live-speed ETA validity to a walking route", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const status = vi.fn(async () => overlay());
    const coordinator = { activate: vi.fn(), status } as unknown as ValhallaTrafficCoordinator;
    vi.stubGlobal("fetch", vi.fn(async () => routeReply(120)));
    const service = new RoutingService(await config(), coordinator);
    const response = await service.route({ profileId: "walking", from: { lon: 14.42, lat: 50.08 }, to: { lon: 14.422, lat: 50.082 } });
    expect(response.traffic.liveSpeeds).toBeUndefined();
    expect(status).not.toHaveBeenCalled();
    expect(response.routes[0]!.durationSeconds).toBe(120);
  });
});

function overlay(): ValhallaTrafficPublicStatus {
  return { enabled: true, state: "current", updatedAt: "2026-10-01T12:00:00Z", overlayGeneration: "apply-1",
    usableUntil: "2026-10-01T12:01:00Z", appliedEdgeCount: 10, routingDataset: "sim-routing-2026-09-29-1790679143" };
}

async function config(): Promise<SituationDataConfig> {
  return { ...await loadConfig(), enabledSources: [], valhallaTrafficEnabled: true, valhallaBaseUrl: "http://valhalla.test", routingEngine: "valhalla",
    osmPostgisConnectionString: undefined,
    routingCacheTtlSeconds: 300, staleIfErrorSeconds: 1800, routingCacheMaxEntries: 10,
    routingMaxSearchRadiusM: 750_000, routingMaxSnapDistanceM: 2500, routingTimeoutMs: 1000, requestTimeoutMs: 1000,
    demEnabled: false, routingGraphEdgeLimit: 1000, roadSrtiLodCacheTtlSeconds: 300 };
}

function routeReply(time: number): Response {
  return new Response(JSON.stringify({ trip: { status: 0, summary: { length: 0.4, time },
    locations: [{ lat: 50.08, lon: 14.42 }, { lat: 50.082, lon: 14.422 }],
    legs: [{ shape: encodeValhallaPolyline6([[14.42, 50.08], [14.422, 50.082]]), maneuvers: [] }] } }), { status: 200 });
}
