import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SituationDataConfig } from "../src/config.js";
import type { Tpeg2Source } from "../src/tpeg2-source.js";
import { ValhallaTrafficCoordinator } from "../src/valhalla-traffic-coordinator.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ValhallaTrafficCoordinator", () => {
  it("stays idle until a road request activates a sliding lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sim-valhalla-traffic-"));
    directories.push(directory);
    const source = {
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
      mappedSegmentCount: 10,
      mappedEdgeCount: 20,
      appliedFlowCount: 8,
      appliedEdgeCount: 17,
      mappingCoveragePercent: 80
    });
    expect(await coordinator.status()).toEqual(expect.objectContaining({ state: "current", appliedEdgeCount: 17 }));
  });
});

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
