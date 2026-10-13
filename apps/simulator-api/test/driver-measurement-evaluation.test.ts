import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "../src/config.js";
import { DRIVER_REJECTION_CODES, parseDriverMeasurementEvaluationReport, readDriverMeasurementEvaluation } from "../src/driver-measurement-evaluation.js";
import type { DriverMeasurementEvaluationReport } from "../src/driver-measurement-evaluation.js";
import { driverEvaluationView, startDriverEvaluationPolling } from "../../simulator-web/src/driver-measurement-ui.js";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const dataset = "sim-routing-2026-10-11-1791687606";
function fixture(now = NOW): DriverMeasurementEvaluationReport {
  const time = new Date(now).toISOString();
  return {
    contractVersion: "sim-driver-evaluation-v1",
    generatedAt: time,
    asOf: time,
    routingDataset: dataset,
    evaluationWindow: { since: new Date(now - 86400_000).toISOString(), until: time },
    applicationMode: "shadow_only",
    etaEvidence: "client_reported_not_ground_truth",
    consistency: "read_only_repeatable_read",
    retentionDays: 7,
    livePromotionSupported: false,
    revocationCoverage: "database_only",
    intake: { enabled: true, revocationEnabled: true, accountScope: "cop_managed_with_consent" },
    comparisonMode: "comparison_only",
    liveAppliedGroupCount: 0,
    summary: {
      retainedBatchCount: 0,
      lastAcceptedAt: null,
      acceptedIntervalCount: 0,
      deduplicatedIntervalCount: 0,
      activeRevocationTombstoneCount: 0,
      rejectionCounts: Object.fromEntries(DRIVER_REJECTION_CODES.map((code) => [code, 0])) as DriverMeasurementEvaluationReport["summary"]["rejectionCounts"],
      speed: {
        evaluatedGroupCount: 0,
        currentGroupCount: 0,
        historicalGroupCount: 0,
        futureGroupCount: 0,
        otherDatasetGroupCount: 0,
        subthresholdGroupCount: 0,
        qualityGroupCount: 0,
        closedWindowGroupCount: 0,
        currentQualityGroupCount: 0,
        currentQualityIntervalCount: 0
      },
      eta: []
    },
    limits: { minimumAttestedContributors: 5, minimumIntervals: 10, maximumEtaRows: 100 }
  };
}

async function bindingContract() {
  const binding = JSON.parse(await readFile(resolve("../../openapi/openapi.json"), "utf8"));
  const operation = binding.paths["/api/v1/operations/driver-measurements"]?.get;
  expect(operation, "binding OpenAPI must be regenerated with the protected operations fragment").toBeTruthy();
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const validator = (status: string) =>
    ajv.compile({
      ...operation.responses[status].content["application/json"].schema,
      components: binding.components
    });
  return { operation, validator };
}

describe("protected driver evaluation report", () => {
  let dir: string, path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sim-driver-evaluation-"));
    path = join(dir, "report.json");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });
  const persist = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });

  it("returns no-data nulls without invented zero ETA and accepts the exact DTO", () => {
    const report = parseDriverMeasurementEvaluationReport(fixture(), NOW);
    expect(report).toEqual(fixture());
    expect(report.summary.eta).toEqual([]);
    expect(report.summary.lastAcceptedAt).toBeNull();
  });

  it("accepts a threshold-qualified ETA group only for the current graph and hourly window", () => {
    const report = fixture();
    report.summary.eta = [
      {
        routingDataset: dataset,
        windowStart: "2026-10-13T11:00:00.000Z",
        attestedContributorCount: 5,
        observationCount: 10,
        medianAbsoluteErrorSeconds: 12.5,
        medianAbsoluteErrorPercent: 2.5
      }
    ];
    expect(parseDriverMeasurementEvaluationReport(report, NOW).summary.eta).toEqual(report.summary.eta);
    for (const change of [
      { routingDataset: "sim-routing-2026-10-10-1791600000" },
      { attestedContributorCount: 4 },
      { observationCount: 9 },
      { windowStart: "2026-10-13T11:00:01.000Z" },
      { windowStart: "2026-10-13T13:00:00.000Z" },
      { windowStart: "2026-10-12T11:00:00.000Z" },
      { medianAbsoluteErrorSeconds: -1 },
      { medianAbsoluteErrorPercent: Infinity },
      { lat: 50 },
      { directedEdgeId: "1" }
    ])
      expect(() =>
        parseDriverMeasurementEvaluationReport({ ...report, summary: { ...report.summary, eta: [{ ...report.summary.eta[0], ...change }] } }, NOW)
      ).toThrow();
  });

  it("rejects current quality groups with fewer than ten intervals per group", () => {
    const report = fixture();
    Object.assign(report.summary.speed, {
      evaluatedGroupCount: 1,
      currentGroupCount: 1,
      qualityGroupCount: 1,
      currentQualityGroupCount: 1,
      currentQualityIntervalCount: 9
    });
    expect(() => parseDriverMeasurementEvaluationReport(report, NOW)).toThrow();
  });

  it("rejects an ETA group with fewer observations than attested contributors", () => {
    const report = fixture();
    report.summary.eta = [
      {
        routingDataset: dataset,
        windowStart: "2026-10-13T11:00:00.000Z",
        attestedContributorCount: 11,
        observationCount: 10,
        medianAbsoluteErrorSeconds: 12.5,
        medianAbsoluteErrorPercent: 2.5
      }
    ];
    expect(() => parseDriverMeasurementEvaluationReport(report, NOW)).toThrow();
  });

  it.each([
    [
      "root GPS",
      (r: any) => {
        r.gps = [0, 0];
      }
    ],
    [
      "source URL",
      (r: any) => {
        r.sourceUrl = "https://invalid.example";
      }
    ],
    [
      "summary identifier",
      (r: any) => {
        r.summary.driverId = "synthetic-disallowed";
      }
    ],
    [
      "unknown rejection",
      (r: any) => {
        r.summary.rejectionCounts.raw_record = 1;
      }
    ],
    [
      "missing rejection",
      (r: any) => {
        delete r.summary.rejectionCounts.sampling_gap;
      }
    ],
    [
      "window raw context",
      (r: any) => {
        r.evaluationWindow.context = "disallowed";
      }
    ],
    [
      "scope claim",
      (r: any) => {
        r.intake.accountScope = "all_authenticated";
      }
    ],
    [
      "live mode",
      (r: any) => {
        r.applicationMode = "live";
      }
    ],
    [
      "live application",
      (r: any) => {
        r.liveAppliedGroupCount = 1;
      }
    ],
    [
      "unknown comparison",
      (r: any) => {
        r.comparisonMode = "limited_live";
      }
    ],
    [
      "negative count",
      (r: any) => {
        r.summary.acceptedIntervalCount = -1;
      }
    ],
    [
      "fraction count",
      (r: any) => {
        r.summary.retainedBatchCount = 1.5;
      }
    ],
    [
      "unsafe count",
      (r: any) => {
        r.summary.retainedBatchCount = Number.MAX_SAFE_INTEGER + 1;
      }
    ],
    [
      "group mismatch",
      (r: any) => {
        r.summary.speed.evaluatedGroupCount = 1;
      }
    ],
    [
      "false current interval",
      (r: any) => {
        r.summary.speed.currentQualityIntervalCount = 10;
      }
    ],
    [
      "retention bypass",
      (r: any) => {
        r.retentionDays = 30;
      }
    ],
    [
      "lower threshold",
      (r: any) => {
        r.limits.minimumAttestedContributors = 1;
      }
    ],
    [
      "future receipt",
      (r: any) => {
        r.summary.lastAcceptedAt = new Date(NOW + 1000).toISOString();
      }
    ],
    [
      "invalid calendar date",
      (r: any) => {
        r.generatedAt = "2026-02-31T12:00:00Z";
      }
    ],
    [
      "future generation",
      (r: any) => {
        r.generatedAt = r.asOf = r.evaluationWindow.until = new Date(NOW + 5001).toISOString();
        r.evaluationWindow.since = new Date(NOW + 5001 - 86400_000).toISOString();
      }
    ],
    [
      "window mismatch",
      (r: any) => {
        r.evaluationWindow.since = new Date(NOW - 86400_001).toISOString();
      }
    ]
  ])("rejects %s instead of projecting raw or misleading fields", (_name, mutate) => {
    const report = fixture();
    mutate(report);
    expect(() => parseDriverMeasurementEvaluationReport(report, NOW)).toThrow();
  });

  it("accepts bounded clock skew, and expires a report strictly after 90 seconds", async () => {
    await persist(path, fixture(NOW + 5000));
    expect(await readDriverMeasurementEvaluation({ dataDir: dir, operationsDriverMeasurementReportFile: path }, NOW)).toMatchObject({
      status: "current",
      reportAgeSeconds: 0
    });
    await persist(path, fixture(NOW - 90000));
    expect(await readDriverMeasurementEvaluation({ dataDir: dir, operationsDriverMeasurementReportFile: path }, NOW)).toMatchObject({
      status: "current",
      reportAgeSeconds: 90
    });
    await persist(path, fixture(NOW - 90001));
    expect(await readDriverMeasurementEvaluation({ dataDir: dir, operationsDriverMeasurementReportFile: path }, NOW)).toMatchObject({
      status: "stale",
      reason: "report_stale"
    });
  });

  it("an unconfigured report is unavailable and never reads the broader operational-checks directory", async () => {
    await mkdir(join(dir, "operational-checks"));
    await persist(join(dir, "operational-checks", "driver-measurement-evaluation.json"), fixture());
    expect(await readDriverMeasurementEvaluation({ dataDir: dir }, NOW)).toMatchObject({ status: "unavailable", reason: "report_missing" });
  });

  it("reports missing data as unavailable without counts", async () => {
    const result = await readDriverMeasurementEvaluation({ dataDir: dir, operationsDriverMeasurementReportFile: path }, NOW);
    expect(result).toMatchObject({ status: "unavailable", reason: "report_missing", reportAgeSeconds: null });
    expect(result.report).toBeUndefined();
  });

  it("returns a sanitized unavailable state on a file-source failure", async () => {
    await persist(path, fixture());
    const result = await readDriverMeasurementEvaluation({ dataDir: dir, operationsDriverMeasurementReportFile: join(path, "not-a-directory.json") }, NOW);
    expect(result).toMatchObject({ status: "unavailable", reason: "report_unreadable", reportAgeSeconds: null });
    expect(result.report).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(path);
  });

  it.each(["symlink", "directory", "oversize", "writable", "hardlink", "invalid-json", "unknown-fields"])(
    "fails closed for %s with no raw contents",
    async (kind) => {
      if (kind === "directory") await mkdir(path);
      else if (kind === "symlink") {
        await persist(join(dir, "other.json"), fixture());
        await symlink(join(dir, "other.json"), path);
      } else if (kind === "oversize") await writeFile(path, " ".repeat(65537), { mode: 0o600 });
      else if (kind === "invalid-json") await writeFile(path, "synthetic-invalid-private-marker", { mode: 0o600 });
      else {
        await persist(path, kind === "unknown-fields" ? { ...fixture(), rawGps: "synthetic-invalid-private-marker" } : fixture());
        if (kind === "writable") await chmod(path, 0o666);
        if (kind === "hardlink") await link(path, join(dir, "second.json"));
      }
      const result = await readDriverMeasurementEvaluation({ dataDir: dir, operationsDriverMeasurementReportFile: path }, NOW);
      expect(result).toMatchObject({ status: "invalid", reason: "report_invalid" });
      expect(result.report).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("synthetic-invalid-private-marker");
    }
  );

  it("serves only authorized SIM viewers even when public-read is enabled, without a provider call", async () => {
    const { createApp } = await import("../src/app.js");
    const { validator } = await bindingContract();
    await persist(path, fixture(Date.now()));
    const config: ApiConfig = {
      port: 0,
      dataDir: dir,
      schemaDir: resolve("../../docs/api/schemas"),
      publisherMode: "DRY_RUN",
      sourceSystemId: "synthetic-sim",
      adapterVersion: "test",
      externalAiAllowed: false,
      apiAuthRequired: true,
      apiPublicRead: true,
      operationsDriverMeasurementReportFile: path,
      apiPrincipals: [
        { actor: "viewer", token: "synthetic-viewer", roles: ["SIM_VIEWER"] },
        { actor: "ai-only", token: "synthetic-ai", roles: ["SIM_AI_USER"] }
      ]
    };
    const { app, context } = await createApp(config);
    const fetch = vi.fn(async () => {
      throw new Error("network forbidden");
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const unauthorized = await request(app).get("/api/v1/operations/driver-measurements").expect(401);
      expect(validator("401")(unauthorized.body)).toBe(true);
      await request(app).get("/api/v1/operations/driver-measurements").set("authorization", "Bearer wrong").expect(401);
      const forbidden = await request(app).get("/api/v1/operations/driver-measurements").set("authorization", "Bearer synthetic-ai").expect(403);
      expect(validator("403")(forbidden.body)).toBe(true);
      const result = await request(app).get("/api/v1/operations/driver-measurements").set("authorization", "Bearer synthetic-viewer").expect(200);
      expect(result.headers["cache-control"]).toBe("private, no-store");
      expect(result.body.status).toBe("current");
      expect(validator("200")(result.body)).toBe(true);
      const query = await request(app).get("/api/v1/operations/driver-measurements?raw=true").set("authorization", "Bearer synthetic-viewer").expect(400);
      expect(validator("400")(query.body)).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      context.runtimeRunner.dispose();
    }
  });

  it("matches all four actual reader states against the binding path without invented counters", async () => {
    const { operation, validator } = await bindingContract();
    expect(operation.security).toEqual([{ simOperatorBearer: [] }]);
    expect(operation["x-required-roles"]).toEqual(["SIM_VIEWER"]);
    expect(operation["x-public-read"]).toBe(false);
    expect(operation["x-unknown-query-policy"]).toBe("reject");
    expect(operation.parameters).toEqual([]);
    expect(operation.responses["200"].headers["Cache-Control"].schema.enum).toEqual(["private, no-store"]);
    const validate = validator("200");
    const unavailable = await readDriverMeasurementEvaluation({ dataDir: dir }, NOW);
    await persist(path, fixture(NOW - 1234));
    const current = await readDriverMeasurementEvaluation({ dataDir: dir, operationsDriverMeasurementReportFile: path }, NOW);
    expect(current.reportAgeSeconds).toBe(1.234);
    await persist(path, fixture(NOW - 90001));
    const stale = await readDriverMeasurementEvaluation({ dataDir: dir, operationsDriverMeasurementReportFile: path }, NOW);
    await persist(path, { ...fixture(), rawGps: [0, 0] });
    const invalid = await readDriverMeasurementEvaluation({ dataDir: dir, operationsDriverMeasurementReportFile: path }, NOW);
    for (const body of [current, stale, unavailable, invalid]) expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...unavailable, retainedBatchCount: 0 })).toBe(false);
    expect(validate({ ...current, reportAgeSeconds: null })).toBe(false);
    expect(validate({ ...current, report: { ...current.report, rawGps: [0, 0] } })).toBe(false);
    expect(validate({ ...stale, status: "current" })).toBe(false);
  });

  it("reuses identical shared evaluation schemas without overwriting COP measurement components", async () => {
    const source = JSON.parse(await readFile(resolve("../../openapi/fragments/driver-measurements-v1.openapi.json"), "utf8"));
    const operations = JSON.parse(await readFile(resolve("../../openapi/fragments/driver-measurement-operations.openapi.json"), "utf8"));
    for (const [section, components] of Object.entries(operations.components)) {
      for (const [name, schema] of Object.entries(components as Record<string, unknown>)) {
        if (source.components[section]?.[name] !== undefined) expect(schema).toEqual(source.components[section][name]);
      }
    }
    const response = operations.components.schemas.DriverEvaluationOperationsResponse;
    expect(response.properties.report.$ref).toBe("#/components/schemas/DriverEvaluationReport");
    expect(source.components.schemas.DriverEvaluationReport.additionalProperties).toBe(false);
    const builder = await readFile(resolve("../../scripts/build-openapi-json.rb"), "utf8");
    expect(builder).toMatch(
      /key: "driverMeasurementOperations",\s+prefix: "DriverMeasurements",[\s\S]*?file: "openapi\/fragments\/driver-measurement-operations.openapi.json",\s+path_prefix: ""/
    );
  });
});

describe("driver evaluation UI freshness and request boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("no-data ETA is null, expired evidence never becomes current, and old statuses cannot freshen", () => {
    const response = {
      contractVersion: "sim-driver-evaluation-v1" as const,
      status: "current" as const,
      checkedAt: new Date(NOW).toISOString(),
      reportAgeSeconds: 90,
      report: fixture()
    };
    expect(driverEvaluationView(response)).toMatchObject({ status: "current", etaErrorSeconds: null, etaErrorPercent: null, currentEvidenceAvailable: false });
    expect(driverEvaluationView(response, 1).status).toBe("stale");
    expect(driverEvaluationView({ ...response, status: "stale", reportAgeSeconds: 0 }, -1000).status).toBe("stale");
    expect(driverEvaluationView(undefined)).toMatchObject({ status: "unavailable", report: undefined, eta: null });
  });

  it("requires current threshold-qualified groups while retaining a historical evaluation view", () => {
    const report = fixture();
    report.summary.speed.currentQualityGroupCount = 1;
    const response = {
      contractVersion: "sim-driver-evaluation-v1" as const,
      status: "current" as const,
      checkedAt: new Date(NOW).toISOString(),
      reportAgeSeconds: 0,
      report
    };
    expect(driverEvaluationView(response).currentEvidenceAvailable).toBe(true);
    expect(driverEvaluationView(response, 90001).currentEvidenceAvailable).toBe(false);
  });

  it("expires current groups at the five-minute boundary even while the report is younger than 90 seconds", () => {
    const report = fixture(Date.parse("2026-10-13T12:04:59.000Z"));
    Object.assign(report.summary.speed, {
      evaluatedGroupCount: 1,
      currentGroupCount: 1,
      qualityGroupCount: 1,
      currentQualityGroupCount: 1,
      currentQualityIntervalCount: 10
    });
    const response = {
      contractVersion: "sim-driver-evaluation-v1" as const,
      status: "current" as const,
      checkedAt: report.generatedAt,
      reportAgeSeconds: 0,
      report
    };
    expect(driverEvaluationView(response, 999)).toMatchObject({
      status: "current",
      currentWindowOpen: true,
      currentEvidenceAvailable: true,
      currentWindowEndsAt: "2026-10-13T12:05:00.000Z"
    });
    expect(driverEvaluationView(response, 1000)).toMatchObject({ status: "current", currentWindowOpen: false, currentEvidenceAvailable: false });
    expect(driverEvaluationView({ ...response, reportAgeSeconds: 31 })).toMatchObject({
      status: "current",
      currentWindowOpen: false,
      currentEvidenceAvailable: false
    });
  });

  it("polls once per minute only while visible, without overlapping requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let visible = false;
    const load = vi.fn(async () => "synthetic");
    const deliver = vi.fn(),
      fail = vi.fn();
    const polling = startDriverEvaluationPolling({ load, deliver, fail, visible: () => visible });
    await vi.advanceTimersByTimeAsync(120000);
    expect(load).not.toHaveBeenCalled();
    visible = true;
    polling.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59999);
    expect(load).toHaveBeenCalledTimes(1);
    polling.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    visible = false;
    polling.visibilityChanged();
    await vi.advanceTimersByTimeAsync(120000);
    expect(load).toHaveBeenCalledTimes(2);
    polling.stop();
    expect(fail).not.toHaveBeenCalled();
  });

  it("cancels pending requests and discards late results on hidden view and auth disposal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let visible = true,
      complete!: (value: string) => void,
      signal!: AbortSignal;
    const deliver = vi.fn(),
      fail = vi.fn();
    const load = vi.fn((incoming: AbortSignal) => {
      signal = incoming;
      return new Promise<string>((resolve) => {
        complete = resolve;
      });
    });
    const polling = startDriverEvaluationPolling({ load, deliver, fail, visible: () => visible });
    await vi.advanceTimersByTimeAsync(120000);
    expect(load).toHaveBeenCalledTimes(1);
    visible = false;
    polling.visibilityChanged();
    expect(signal.aborted).toBe(true);
    complete("late-private-result");
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    visible = true;
    polling.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    polling.stop();
    expect(signal.aborted).toBe(true);
    complete("late-other-account-result");
    await vi.advanceTimersByTimeAsync(120000);
    expect(deliver).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a fetch failure is unavailable, and retries respect the one-minute cadence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const load = vi.fn(async () => {
      throw new Error("synthetic source failure");
    });
    const fail = vi.fn();
    const polling = startDriverEvaluationPolling({ load, fail, deliver: vi.fn(), visible: () => true });
    await vi.advanceTimersByTimeAsync(0);
    expect(fail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(load).toHaveBeenCalledTimes(2);
    polling.stop();
  });

  it("mounts the results panel only behind the protected overview, and uses only the SIM endpoint", async () => {
    const appSource = await readFile(resolve("../simulator-web/src/App.tsx"), "utf8");
    const apiSource = await readFile(resolve("../simulator-web/src/api.ts"), "utf8");
    expect(appSource).toContain(
      "protectedSectionsUnlocked && driverAuthRevision > 0 && driverAuthorizationReady ? <DriverMeasurementsPanel key={driverAuthRevision}"
    );
    expect(appSource).toContain('document.visibilityState === "visible"');
    expect(apiSource).toContain('"/api/v1/operations/driver-measurements", { signal }');
    expect(apiSource).not.toContain("/internal/driver-measurements/");
  });
});
