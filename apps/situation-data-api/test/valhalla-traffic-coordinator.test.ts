import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SituationDataConfig } from "../src/config.js";
import type { Tpeg2Source } from "../src/tpeg2-source.js";
import { parseValhallaTrafficUpdateReport, ValhallaTrafficCoordinator, type ValhallaTrafficUpdateReport } from "../src/valhalla-traffic-coordinator.js";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ValhallaTrafficCoordinator", () => {
  it("stays idle until a road request activates a sliding lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sim-valhalla-traffic-"));
    directories.push(directory);
    const source = {
      retainTrafficUntil: vi.fn(),
      trafficSnapshot: vi.fn(async (includeStatic: boolean) => ({
        generatedAt: "2026-09-14T12:00:00Z",
        staticRevision: "static-1",
        dynamicRevision: "dynamic-1",
        ...(includeStatic ? { segments: [{ messageId: "one", coordinates: [[14, 50], [14.1, 50.1]] }] } : {}),
        flows: [{ messageId: "one", observedAt: "2026-09-14T12:00:00Z", averageSpeedKph: 42 }]
      }))
    } as unknown as Tpeg2Source;
    const coordinator = new ValhallaTrafficCoordinator(config(directory), source);

    expect(await coordinator.feed(false)).toBeUndefined();
    expect((await coordinator.status()).state).toBe("idle");
    coordinator.activate();
    expect(source.retainTrafficUntil).toHaveBeenCalledWith(expect.any(Number));
    const feed = await coordinator.feed(true);
    expect(feed).toEqual(expect.objectContaining({ contractVersion: "sim-valhalla-live-traffic-feed-v1" }));
    expect(Date.parse(feed!.activeUntil) - Date.now()).toBeGreaterThan(899_000);
    expect(source.trafficSnapshot).toHaveBeenCalledWith(true);
    await vi.waitFor(async () => expect((await readFile(join(directory, "static-segments.json.gz"))).length).toBeGreaterThan(0));

    coordinator.activate();
    expect(Date.parse((await coordinator.feed(false))!.activeUntil) - Date.now()).toBeGreaterThan(899_000);
  });

  it("authenticates reports without exposing the configured token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sim-valhalla-traffic-"));
    directories.push(directory);
    const coordinator = new ValhallaTrafficCoordinator(config(directory), {} as Tpeg2Source);
    expect(coordinator.isAuthorized("Bearer test-control-token")).toBe(true);
    expect(coordinator.isAuthorized("Bearer wrong")).toBe(false);
    await coordinator.report({
      routingDataset: "sim-routing-test",
      staticRevision: "static-1",
      dynamicRevision: "dynamic-1",
      status: "current",
      updatedAt: new Date().toISOString(),
      overlayGeneration: "generation-1",
      usableUntil: new Date(Date.now() + 60_000).toISOString(),
      mappedSegmentCount: 10,
      mappedEdgeCount: 20,
      appliedFlowCount: 8,
      appliedEdgeCount: 17,
      mappingCoveragePercent: 80
    });
    expect(await coordinator.status()).toEqual(expect.objectContaining({ state: "current", appliedEdgeCount: 17 }));
  });

  it("does not present an old idle report as a current failure after a new road request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T08:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "sim-valhalla-traffic-"));
    directories.push(directory);
    const coordinator = new ValhallaTrafficCoordinator(config(directory), {} as Tpeg2Source);
    await coordinator.report({
      routingDataset: "sim-routing-test",
      staticRevision: "static-1",
      dynamicRevision: "dynamic-1",
      status: "degraded",
      updatedAt: "2026-09-29T16:44:23Z",
      mappedSegmentCount: 10,
      mappedEdgeCount: 20,
      appliedFlowCount: 0,
      appliedEdgeCount: 0,
      mappingCoveragePercent: 80
    });
    expect((await coordinator.status()).state).toBe("idle");
    coordinator.activate();
    expect((await coordinator.status()).state).toBe("warming");

    await coordinator.report({
      routingDataset: "sim-routing-test",
      staticRevision: "static-1",
      dynamicRevision: "dynamic-2",
      status: "degraded",
      updatedAt: new Date().toISOString(),
      mappedSegmentCount: 10,
      mappedEdgeCount: 20,
      appliedFlowCount: 0,
      appliedEdgeCount: 0,
      mappingCoveragePercent: 80
    });
    expect((await coordinator.status()).state).toBe("degraded");
    vi.setSystemTime(new Date("2026-09-30T08:16:00Z"));
    expect((await coordinator.status()).state).toBe("idle");
    coordinator.activate();
    expect((await coordinator.status()).state).toBe("warming");

    await coordinator.report({
      routingDataset: "sim-routing-test",
      staticRevision: "static-1",
      dynamicRevision: "dynamic-3",
      status: "current",
      updatedAt: "2026-09-30T08:00:00Z",
      mappedSegmentCount: 10,
      mappedEdgeCount: 20,
      appliedFlowCount: 8,
      appliedEdgeCount: 17,
      mappingCoveragePercent: 80
    });
    expect((await coordinator.status()).state).toBe("warming");
    await coordinator.report({
      routingDataset: "sim-routing-test",
      staticRevision: "static-1",
      dynamicRevision: "dynamic-4",
      status: "current",
      updatedAt: new Date().toISOString(),
      overlayGeneration: "generation-4",
      usableUntil: "2026-09-30T08:30:00Z",
      mappedSegmentCount: 10,
      mappedEdgeCount: 20,
      appliedFlowCount: 8,
      appliedEdgeCount: 17,
      mappingCoveragePercent: 80
    });
    expect((await coordinator.status()).state).toBe("current");
    vi.setSystemTime(new Date("2026-09-30T08:27:00Z"));
    expect((await coordinator.status()).state).toBe("stale");
  });

  it("expires current status at its source deadline without a new dynamic revision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "sim-valhalla-traffic-"));
    directories.push(directory);
    const coordinator = new ValhallaTrafficCoordinator(config(directory), {} as Tpeg2Source);
    coordinator.activate();
    await coordinator.report(report());
    expect((await coordinator.status()).state).toBe("current");
    vi.setSystemTime(new Date("2026-10-01T12:01:00Z"));
    expect(await coordinator.status()).toMatchObject({ state: "stale", overlayGeneration: "apply-1", dynamicRevision: "dynamic-1" });
    await coordinator.report({ ...report(), status: "degraded", appliedFlowCount: 0, appliedEdgeCount: 0,
      overlayGeneration: "clear-1", updatedAt: "2026-10-01T12:01:00.000002Z", usableUntil: "2026-10-01T12:01:00.000002Z" });
    expect(await coordinator.status()).toMatchObject({ state: "degraded", overlayGeneration: "clear-1", appliedEdgeCount: 0 });
    // Both timestamps parse to the same JS millisecond: microsecond order must
    // still prevent a delayed apply from replacing the newer clear.
    await coordinator.report({ ...report(), updatedAt: "2026-10-01T12:01:00.000001Z", usableUntil: "2026-10-01T12:02:00Z" });
    expect(await coordinator.status()).toMatchObject({ state: "degraded", overlayGeneration: "clear-1" });
    const persisted = JSON.parse(await readFile(join(directory, "status.json"), "utf8"));
    expect(persisted.overlayGeneration).toBe("clear-1");
  });

  it("keeps legacy report counts but cannot claim current without a source deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "sim-valhalla-traffic-"));
    directories.push(directory);
    const coordinator = new ValhallaTrafficCoordinator(config(directory), {} as Tpeg2Source);
    coordinator.activate();
    const { usableUntil: _until, overlayGeneration: _generation, ...legacy } = report();
    expect(parseValhallaTrafficUpdateReport(legacy)).toBeDefined();
    await coordinator.report(legacy);
    expect(await coordinator.status()).toMatchObject({ state: "stale", appliedEdgeCount: 17 });
  });

  it("awaits persisted report loading before accepting a concurrent delayed apply", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:01:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "sim-valhalla-traffic-"));
    directories.push(directory);
    const clear = { ...report(), status: "degraded" as const, overlayGeneration: "clear-1", appliedEdgeCount: 0,
      updatedAt: "2026-10-01T12:01:00.000002Z", usableUntil: "2026-10-01T12:01:00.000002Z" };
    await writeFile(join(directory, "status.json"), JSON.stringify(clear));
    const coordinator = new ValhallaTrafficCoordinator(config(directory), {} as Tpeg2Source);
    coordinator.activate();
    await Promise.all([
      coordinator.status(),
      coordinator.report({ ...report(), updatedAt: "2026-10-01T12:01:00.000001Z", usableUntil: "2026-10-01T12:02:00Z" })
    ]);
    expect(await coordinator.status()).toMatchObject({ state: "degraded", overlayGeneration: "clear-1" });
    expect(JSON.parse(await readFile(join(directory, "status.json"), "utf8"))).toMatchObject({ overlayGeneration: "clear-1" });
  });

  it("validates precise source timestamps, future skew and overlay metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    expect(parseValhallaTrafficUpdateReport(report())).toBeDefined();
    for (const invalid of [
      { routingDataset: 42 },
      { staticRevision: true },
      { dynamicRevision: [] },
      { updatedAt: "2026-10-01" },
      { updatedAt: "2026-02-30T12:00:00Z" },
      { updatedAt: "2026-10-01T12:00:31Z" },
      { sourceObservedAt: "invalid" },
      { sourceObservedAt: "2026-10-01T12:00:31Z" },
      { usableUntil: "invalid" },
      { usableUntil: "2026-10-01T11:59:59Z" },
      { overlayGeneration: "" },
      { overlayGeneration: "contains spaces" },
      { appliedEdgeCount: 1.5 },
      { mappingCoveragePercent: 101 },
      { detail: {} }
    ]) expect(parseValhallaTrafficUpdateReport({ ...report(), ...invalid })).toBeUndefined();
  });

  it("cannot override computed source expiry through unknown report fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "sim-valhalla-traffic-"));
    directories.push(directory);
    const coordinator = new ValhallaTrafficCoordinator(config(directory), {} as Tpeg2Source);
    coordinator.activate();
    await coordinator.report({ ...report(), state: "current", enabled: false } as ValhallaTrafficUpdateReport);
    vi.setSystemTime(new Date("2026-10-01T12:01:00Z"));
    expect(await coordinator.status()).toMatchObject({ enabled: true, state: "stale" });
    const persisted = JSON.parse(await readFile(join(directory, "status.json"), "utf8"));
    expect(persisted.state).toBeUndefined();
    expect(persisted.enabled).toBeUndefined();
  });
});

function report(): ValhallaTrafficUpdateReport {
  return {
    routingDataset: "sim-routing-test", staticRevision: "static-1", dynamicRevision: "dynamic-1",
    status: "current", updatedAt: "2026-10-01T12:00:00Z", sourceObservedAt: "2026-10-01T11:59:40Z",
    overlayGeneration: "apply-1", usableUntil: "2026-10-01T12:01:00Z",
    mappedSegmentCount: 10, mappedEdgeCount: 20, appliedFlowCount: 8, appliedEdgeCount: 17, mappingCoveragePercent: 80
  };
}

function config(directory: string): SituationDataConfig {
  return {
    valhallaTrafficEnabled: true,
    valhallaTrafficControlToken: "test-control-token",
    valhallaTrafficIdleSeconds: 900,
    valhallaTrafficMaxAgeSeconds: 1800,
    valhallaTrafficCacheDir: directory,
    tpeg2ApiToken: "test-tpeg-token",
    tpeg2DynamicCacheTtlSeconds: 300,
    enabledSources: ["tpeg2"]
  } as SituationDataConfig;
}
