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
  private lastReport?: ValhallaTrafficUpdateReport;
  private reportLoaded = false;
  private persistedStaticRevision?: string;
  private persistedDynamicRevision?: string;
  private persistPromise?: Promise<void>;

  constructor(
    private readonly config: SituationDataConfig,
    private readonly source?: Tpeg2Source
  ) {}

  activate(): void {
    if (!this.available()) return;
    this.lastVehicleRequestAtMs = Date.now();
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
    this.lastReport = value;
    await this.persistJson("status.json", value);
  }

  async status(): Promise<ValhallaTrafficPublicStatus> {
    await this.loadReport();
    if (!this.available()) return { enabled: false, state: "disabled" };
    const activeUntilMs = this.activeUntilMs();
    const reportTimestamp = this.lastReport ? Date.parse(this.lastReport.updatedAt) : NaN;
    const ageSeconds = Number.isFinite(reportTimestamp) ? Math.max(0, Math.round((Date.now() - reportTimestamp) / 1000)) : undefined;
    let state: ValhallaTrafficState;
    if (this.lastReport?.status === "degraded") state = "degraded";
    else if (ageSeconds !== undefined && ageSeconds <= this.config.tpeg2DynamicCacheTtlSeconds * 2) state = "current";
    else if (ageSeconds !== undefined && ageSeconds <= this.config.valhallaTrafficMaxAgeSeconds) state = "stale";
    else if (this.isActive()) state = "warming";
    else state = "idle";
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
    if (this.reportLoaded) return;
    this.reportLoaded = true;
    try {
      this.lastReport = JSON.parse(await readFile(join(this.config.valhallaTrafficCacheDir, "status.json"), "utf8")) as ValhallaTrafficUpdateReport;
    } catch {
      this.lastReport = undefined;
    }
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
    !report.routingDataset ||
    !report.staticRevision ||
    !report.dynamicRevision ||
    (report.status !== "current" && report.status !== "degraded") ||
    !report.updatedAt ||
    !Number.isFinite(Date.parse(report.updatedAt))
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
  return report as ValhallaTrafficUpdateReport;
}
