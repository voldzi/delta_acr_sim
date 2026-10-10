import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "../src/config.js";
import { buildOperationsSummary, readOperationalCheckSummary } from "../src/operations-summary.js";
import { fetchProviderJson } from "../src/provider-http.js";
import { JsonStore } from "../src/store.js";

vi.mock("../src/provider-http.js", () => ({ fetchProviderJson: vi.fn() }));

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const PRIVATE = "SYNTHETIC_RAW_TOKEN_DETAIL_NEVER_PUBLISHED";
const UNAVAILABLE = {
  status: "failed",
  summary: "OPERATIONAL_MONITOR_UNAVAILABLE: Provozní dohled neposkytl platný report."
};

describe("operational monitor report freshness", () => {
  let directory: string;
  let file: string;
  let config: ApiConfig;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "sim-operational-report-"));
    file = join(directory, "latest.json");
    config = {
      port: 0, dataDir: directory, schemaDir: directory, publisherMode: "MOCK",
      sourceSystemId: "synthetic-test", adapterVersion: "test", externalAiAllowed: false,
      operationsReportFile: file
    };
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.mocked(fetchProviderJson).mockResolvedValue({ latencyMs: 1, payload: { status: "ok", enabledSources: [] } });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  async function report(overrides: Record<string, unknown> = {}) {
    await writeFile(file, JSON.stringify({
      schemaVersion: "sim-operational-check/v1", status: "ok", summary: "all operational checks passed",
      finishedAt: new Date(NOW - 60_000).toISOString(), ...overrides
    }));
  }

  async function summary() {
    return buildOperationsSummary({
      config,
      store: new JsonStore(join(directory, "unused-store.json")),
      publisher: { status: () => ({ mode: "MOCK", publishingEnabled: false, queueSize: 0, deadLetterSize: 0 }) }
    });
  }

  it("an unconfigured report remains an explicit opt-out", async () => {
    config.operationsReportFile = undefined;
    expect(await readOperationalCheckSummary(config)).toBeUndefined();
    expect((await summary()).alerts.some((alert) => alert.code === "operational_check_failed")).toBe(false);
  });

  it("a configured but missing report fails safely, without publishing a filesystem path", async () => {
    config.operationsReportFile = join(directory, PRIVATE, "missing.json");
    const result = await readOperationalCheckSummary(config);
    expect(result).toEqual(UNAVAILABLE);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(JSON.stringify(result)).not.toContain(directory);
  });

  it.each([
    null, [], { status: "ok", summary: PRIVATE },
    { schemaVersion: "wrong", status: "ok", summary: PRIVATE, finishedAt: new Date(NOW).toISOString() },
    { schemaVersion: "sim-operational-check/v1", status: "degraded", summary: PRIVATE, finishedAt: new Date(NOW).toISOString() },
    { schemaVersion: "sim-operational-check/v1", status: "ok", summary: {}, finishedAt: new Date(NOW).toISOString() },
    { schemaVersion: "sim-operational-check/v1", status: "ok", summary: " ", finishedAt: new Date(NOW).toISOString() }
  ])("invalid schema or fields return only the generic failure", async (value) => {
    await writeFile(file, JSON.stringify(value));
    const result = await readOperationalCheckSummary(config);
    expect(result).toEqual(UNAVAILABLE);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
  });

  it.each([undefined, null, 0, PRIVATE, "2026-10-10T12:00:00", "2026-02-30T12:00:00Z",
    "2026-10-10T24:00:00Z", "2026-10-10T12:60:00Z", new Date(NOW + 30_001).toISOString()])(
    "missing, invalid or excessively future finishedAt fails closed", async (finishedAt) => {
      await report({ finishedAt, summary: PRIVATE });
      const result = await readOperationalCheckSummary(config);
      expect(result).toEqual(UNAVAILABLE);
      expect(JSON.stringify(result)).not.toContain(PRIVATE);
    }
  );

  it("malformed JSON or invalid UTF-8 never publishes payloads or parsing errors", async () => {
    for (const raw of [`{"status":"ok","error":"${PRIVATE}"`, Buffer.from([0xff, 0xfe])]) {
      await writeFile(file, raw);
      expect(await readOperationalCheckSummary(config)).toEqual(UNAVAILABLE);
    }
  });

  it("a directory or over-limit report is unavailable rather than read unboundedly", async () => {
    config.operationsReportFile = directory;
    expect(await readOperationalCheckSummary(config)).toEqual(UNAVAILABLE);
    config.operationsReportFile = file;
    await report({ summary: PRIVATE, padding: "x".repeat(128 * 1024) });
    expect(await readOperationalCheckSummary(config)).toEqual(UNAVAILABLE);
  });

  it("an old ok report is stale, never treated as continuing healthy monitoring", async () => {
    await report({ finishedAt: new Date(NOW - 900_001).toISOString(), summary: PRIVATE });
    const result = await readOperationalCheckSummary(config);
    expect(result?.status).toBe("failed");
    expect(result?.summary).toMatch(/^OPERATIONAL_MONITOR_STALE:/);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    const operations = await summary();
    expect(operations.status).toBe("critical");
    expect(operations.alerts.filter((alert) => alert.code === "operational_check_failed")).toHaveLength(1);
  });

  it("fresh failed reports preserve the trusted bounded failure summary", async () => {
    await report({ status: "failed", summary: "VALHALLA_WEEKLY_ATTEMPT_FAILED: The last update failed.",
      error: PRIVATE, partnerUrl: `https://partner.invalid/?token=${PRIVATE}` });
    const result = await readOperationalCheckSummary(config);
    expect(result?.status).toBe("failed");
    expect(result?.summary).toContain("VALHALLA_WEEKLY_ATTEMPT_FAILED");
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect((await summary()).alerts.some((alert) => alert.code === "operational_check_failed")).toBe(true);
  });

  it("fresh ok reports remain healthy, with only allowed summary fields exposed", async () => {
    await report({ token: PRIVATE, sourcePayload: { raw: PRIVATE } });
    expect(await readOperationalCheckSummary(config)).toEqual({
      status: "ok", summary: "all operational checks passed", finishedAt: new Date(NOW - 60_000).toISOString()
    });
    const operations = await summary();
    expect(operations.status).toBe("ok");
    expect(operations.alerts.some((alert) => alert.code === "operational_check_failed")).toBe(false);
    expect(JSON.stringify(operations)).not.toContain(PRIVATE);
  });

  it("accepts the exact fifteen-minute boundary and future skew up to thirty seconds", async () => {
    for (const ageMs of [900_000, -30_000]) {
      await report({ finishedAt: new Date(NOW - ageMs).toISOString() });
      expect((await readOperationalCheckSummary(config))?.status).toBe("ok");
    }
  });

  it("bounds a legitimate lengthy monitor summary to 8192 characters", async () => {
    await report({ status: "failed", summary: "A".repeat(16_000) });
    expect((await readOperationalCheckSummary(config))?.summary).toHaveLength(8192);
  });
});
