import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { SituationDataConfig } from "./config.js";
import { Tpeg2Source, type Tpeg2TrafficSnapshot } from "./tpeg2-source.js";

const gzipAsync = promisify(gzip);

export type ValhallaTrafficState = "disabled" | "idle" | "warming" | "current" | "stale" | "degraded";

export interface ValhallaTrafficUpdateReport {
  routingDataset: string;
  staticRevision: string;
  dynamicRevision: string;
  status: "current" | "degraded";
  updatedAt: string;
  sourceObservedAt?: string;
  overlayGeneration?: string;
  usableUntil?: string;
  mappedSegmentCount: number;
  mappedEdgeCount: number;
  appliedFlowCount: number;
  appliedEdgeCount: number;
  mappingCoveragePercent: number;
  detail?: string;
}

export interface ValhallaTrafficPublicStatus {
  enabled: boolean;
  state: ValhallaTrafficState;
  activeUntil?: string;
  lastVehicleRequestAt?: string;
  updatedAt?: string;
  sourceObservedAt?: string;
  overlayGeneration?: string;
  usableUntil?: string;
  ageSeconds?: number;
  routingDataset?: string;
  mappingCoveragePercent?: number;
  mappedSegmentCount?: number;
  mappedEdgeCount?: number;
  appliedFlowCount?: number;
  appliedEdgeCount?: number;
  detail?: string;
}

export interface ValhallaTrafficFeed extends Tpeg2TrafficSnapshot {
  contractVersion: "sim-valhalla-live-traffic-feed-v1";
  activeUntil: string;
  maxAgeSeconds: number;
}

export class ValhallaTrafficCoordinator {
  private lastVehicleRequestAtMs?: number;
  private leaseStartedAtMs?: number;
  private lastReport?: ValhallaTrafficUpdateReport;
  private reportLoadPromise?: Promise<void>;
  private persistedStaticRevision?: string;
  private persistedDynamicRevision?: string;
  private persistPromise?: Promise<void>;
  private reportQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: SituationDataConfig,
    private readonly source?: Tpeg2Source
  ) {}

  activate(): void {
    if (!this.available()) return;
    const now = Date.now();
    if (!this.isActive()) this.leaseStartedAtMs = now;
    this.lastVehicleRequestAtMs = now;
    this.source?.retainTrafficUntil?.(this.activeUntilMs()!);
  }

  isAuthorized(value: string | undefined): boolean {
    const expected = this.config.valhallaTrafficControlToken;
    if (!expected || !value) return false;
    const prefix = "Bearer ";
    const supplied = value.startsWith(prefix) ? value.slice(prefix.length) : "";
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
  }

  async feed(includeStatic: boolean): Promise<ValhallaTrafficFeed | undefined> {
    if (!this.isActive() || !this.source) return undefined;
    const snapshot = await this.source.trafficSnapshot(includeStatic);
    this.persistPromise ??= this.persistSnapshot(snapshot).finally(() => {
      this.persistPromise = undefined;
    });
    void this.persistPromise.catch(() => undefined);
    return {
      contractVersion: "sim-valhalla-live-traffic-feed-v1",
      activeUntil: new Date(this.activeUntilMs()!).toISOString(),
      maxAgeSeconds: this.config.valhallaTrafficMaxAgeSeconds,
      ...snapshot
    };
  }

  async report(value: ValhallaTrafficUpdateReport): Promise<void> {
    const accepted = parseValhallaTrafficUpdateReport(value);
    if (!accepted) throw new Error("Invalid Valhalla traffic update report.");
    const operation = this.reportQueue.then(async () => {
      await this.loadReport();
      const incoming = reportTimestampMicros(accepted.updatedAt);
      const previous = this.lastReport ? reportTimestampMicros(this.lastReport.updatedAt) : undefined;
      // An earlier apply can arrive after a newer expiry-clear report. Keep the
      // acknowledged overlay monotonic, including sub-millisecond timestamps.
      if (previous !== undefined && incoming !== undefined && incoming <= previous) return;
      await this.persistJson("status.json", accepted);
      this.lastReport = accepted;
    });
    this.reportQueue = operation.catch(() => undefined);
    await operation;
  }

  async status(): Promise<ValhallaTrafficPublicStatus> {
    await this.loadReport();
    if (!this.available()) return { enabled: false, state: "disabled" };
    const activeUntilMs = this.activeUntilMs();
    const reportTimestamp = this.lastReport ? Date.parse(this.lastReport.updatedAt) : NaN;
    const ageSeconds = Number.isFinite(reportTimestamp) ? Math.max(0, Math.round((Date.now() - reportTimestamp) / 1000)) : undefined;
    const active = this.isActive();
    const recentReport = ageSeconds !== undefined && ageSeconds <= this.config.tpeg2DynamicCacheTtlSeconds * 2;
    const usableUntil = this.lastReport?.usableUntil ? Date.parse(this.lastReport.usableUntil) : NaN;
    const usableOverlay = Boolean(this.lastReport?.overlayGeneration) && Number.isFinite(usableUntil) && usableUntil > Date.now() &&
      usableUntil <= reportTimestamp + this.config.valhallaTrafficMaxAgeSeconds * 1000;
    let state: ValhallaTrafficState;
    if (this.lastReport?.status === "current" && recentReport && usableOverlay && this.lastReport.appliedEdgeCount > 0) state = "current";
    else if (!active) state = "idle";
    else if (
      !this.lastReport || ageSeconds === undefined || ageSeconds > this.config.valhallaTrafficMaxAgeSeconds ||
      (this.leaseStartedAtMs !== undefined && reportTimestamp < this.leaseStartedAtMs)
    ) state = "warming";
    else if (this.lastReport.status === "degraded") state = recentReport ? "degraded" : "warming";
    else state = "stale";
    return {
      enabled: true,
      state,
      ...(activeUntilMs ? { activeUntil: new Date(activeUntilMs).toISOString() } : {}),
      ...(this.lastVehicleRequestAtMs ? { lastVehicleRequestAt: new Date(this.lastVehicleRequestAtMs).toISOString() } : {}),
      ...(ageSeconds !== undefined ? { ageSeconds } : {}),
      ...(this.lastReport ?? {})
    };
  }

  private available(): boolean {
    return Boolean(
      this.config.valhallaTrafficEnabled &&
        this.config.valhallaTrafficControlToken &&
        this.config.tpeg2ApiToken &&
        this.config.enabledSources.includes("tpeg2") &&
        this.source
    );
  }

  private activeUntilMs(): number | undefined {
    return this.lastVehicleRequestAtMs === undefined
      ? undefined
      : this.lastVehicleRequestAtMs + this.config.valhallaTrafficIdleSeconds * 1000;
  }

  private isActive(): boolean {
    const activeUntil = this.activeUntilMs();
    return this.available() && activeUntil !== undefined && activeUntil > Date.now();
  }

  private async loadReport(): Promise<void> {
    this.reportLoadPromise ??= (async () => {
      try {
        this.lastReport = parseValhallaTrafficUpdateReport(JSON.parse(await readFile(join(this.config.valhallaTrafficCacheDir, "status.json"), "utf8")));
      } catch {
        this.lastReport = undefined;
      }
    })();
    await this.reportLoadPromise;
  }

  private async persistSnapshot(snapshot: Tpeg2TrafficSnapshot): Promise<void> {
    await mkdir(this.config.valhallaTrafficCacheDir, { recursive: true });
    if (snapshot.segments && snapshot.staticRevision !== this.persistedStaticRevision) {
      await this.persistGzipJson("static-segments.json.gz", {
        staticRevision: snapshot.staticRevision,
        generatedAt: snapshot.generatedAt,
        segments: snapshot.segments
      });
      this.persistedStaticRevision = snapshot.staticRevision;
    }
    if (snapshot.dynamicRevision !== this.persistedDynamicRevision) {
      await this.persistGzipJson("last-valid-speeds.json.gz", {
        dynamicRevision: snapshot.dynamicRevision,
        generatedAt: snapshot.generatedAt,
        flows: snapshot.flows
      });
      this.persistedDynamicRevision = snapshot.dynamicRevision;
    }
  }

  private async persistGzipJson(name: string, value: unknown): Promise<void> {
    const bytes = await gzipAsync(Buffer.from(JSON.stringify(value)), { level: 6 });
    await this.atomicWrite(name, bytes);
  }

  private async persistJson(name: string, value: unknown): Promise<void> {
    await this.atomicWrite(name, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  }

  private async atomicWrite(name: string, value: Buffer): Promise<void> {
    await mkdir(this.config.valhallaTrafficCacheDir, { recursive: true });
    const target = join(this.config.valhallaTrafficCacheDir, name);
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, target);
  }
}

export function parseValhallaTrafficUpdateReport(value: unknown): ValhallaTrafficUpdateReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const report = value as Partial<ValhallaTrafficUpdateReport>;
  if (
    typeof report.routingDataset !== "string" || !report.routingDataset ||
    typeof report.staticRevision !== "string" || !report.staticRevision ||
    typeof report.dynamicRevision !== "string" || !report.dynamicRevision ||
    (report.status !== "current" && report.status !== "degraded") ||
    !report.updatedAt ||
    reportTimestampMicros(report.updatedAt) === undefined ||
    Date.parse(report.updatedAt) > Date.now() + 30_000
  ) {
    return undefined;
  }
  const numeric = [
    report.mappedSegmentCount,
    report.mappedEdgeCount,
    report.appliedFlowCount,
    report.appliedEdgeCount,
    report.mappingCoveragePercent
  ];
  if (numeric.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0)) return undefined;
  if ([report.mappedSegmentCount, report.mappedEdgeCount, report.appliedFlowCount, report.appliedEdgeCount].some((item) => !Number.isInteger(item))) return undefined;
  if (report.mappingCoveragePercent! > 100) return undefined;
  if (report.sourceObservedAt !== undefined && (
    reportTimestampMicros(report.sourceObservedAt) === undefined || Date.parse(report.sourceObservedAt) > Date.now() + 30_000
  )) return undefined;
  if (report.overlayGeneration !== undefined && (
    typeof report.overlayGeneration !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(report.overlayGeneration)
  )) return undefined;
  if (report.usableUntil !== undefined && (
    reportTimestampMicros(report.usableUntil) === undefined ||
    reportTimestampMicros(report.usableUntil)! < reportTimestampMicros(report.updatedAt)!
  )) return undefined;
  if (report.detail !== undefined && typeof report.detail !== "string") return undefined;
  // Ignore extension fields rather than allowing an input `state` or `enabled`
  // property to overwrite the coordinator's computed public status.
  return {
    routingDataset: report.routingDataset,
    staticRevision: report.staticRevision,
    dynamicRevision: report.dynamicRevision,
    status: report.status,
    updatedAt: report.updatedAt,
    mappedSegmentCount: report.mappedSegmentCount!,
    mappedEdgeCount: report.mappedEdgeCount!,
    appliedFlowCount: report.appliedFlowCount!,
    appliedEdgeCount: report.appliedEdgeCount!,
    mappingCoveragePercent: report.mappingCoveragePercent!,
    ...(report.sourceObservedAt !== undefined ? { sourceObservedAt: report.sourceObservedAt } : {}),
    ...(report.overlayGeneration !== undefined ? { overlayGeneration: report.overlayGeneration } : {}),
    ...(report.usableUntil !== undefined ? { usableUntil: report.usableUntil } : {}),
    ...(report.detail !== undefined ? { detail: report.detail } : {})
  };
}

function reportTimestampMicros(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const fractional = /\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? "";
  return BigInt(parsed) * 1000n + BigInt(fractional.padEnd(6, "0").slice(3));
}
