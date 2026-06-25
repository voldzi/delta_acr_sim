import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HydroSeriesId, HydroSeriesRole } from "./types.js";

export type ChmiHydroSourceKind = "now" | "recent";

export interface ChmiHydroHistoryRecord {
  stationId: string;
  seriesId: HydroSeriesId;
  role: HydroSeriesRole;
  observedAt: string;
  value: number;
  unit?: string;
  ingestedAt: string;
  sourceUrl: string;
  sourceKind: ChmiHydroSourceKind;
}

export interface ChmiHydroHistoryReadQuery {
  from?: string;
  to?: string;
  seriesIds?: HydroSeriesId[];
}

interface ChmiHydroPayload {
  objList?: Array<{
    objID?: string;
    tsList?: Array<{
      tsConID?: string;
      unit?: string;
      tsData?: Array<{
        dt?: string;
        value?: number | string | null;
      }>;
    }>;
  }>;
}

const SUPPORTED_SERIES = new Set<HydroSeriesId>(["H", "Q", "TH", "H_F", "Q_F"]);

export class ChmiHydroHistoryStore {
  private readonly rootDir: string;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.rootDir = join(dataDir, "chmi-hydro", "history");
  }

  async persistPayload(payload: ChmiHydroPayload, sourceUrl: string, sourceKind: ChmiHydroSourceKind, ingestedAt: string): Promise<void> {
    const recordsByStation = new Map<string, ChmiHydroHistoryRecord[]>();
    for (const object of payload.objList ?? []) {
      if (!object.objID) {
        continue;
      }
      for (const series of object.tsList ?? []) {
        const seriesId = asHydroSeriesId(series.tsConID);
        if (!seriesId) {
          continue;
        }
        const records = (series.tsData ?? [])
          .map((point) => {
            const observedAt = normalizeTimestamp(point.dt);
            const value = optionalNumber(point.value);
            if (!observedAt || value === undefined) {
              return undefined;
            }
            const record: ChmiHydroHistoryRecord = {
              stationId: object.objID as string,
              seriesId,
              role: seriesId.endsWith("_F") ? "forecast" : "observation",
              observedAt,
              value,
              ingestedAt,
              sourceUrl,
              sourceKind
            };
            if (series.unit) {
              record.unit = series.unit;
            }
            return record;
          })
          .filter((record): record is ChmiHydroHistoryRecord => Boolean(record));
        if (records.length === 0) {
          continue;
        }
        recordsByStation.set(object.objID, [...(recordsByStation.get(object.objID) ?? []), ...records]);
      }
    }

    await Promise.all(Array.from(recordsByStation.entries()).map(([stationId, records]) => this.persistStationRecords(stationId, records)));
  }

  async readStationRecords(stationId: string, query: ChmiHydroHistoryReadQuery = {}): Promise<ChmiHydroHistoryRecord[]> {
    const records = await this.readAllStationRecords(stationId);
    const fromMs = query.from ? Date.parse(query.from) : undefined;
    const toMs = query.to ? Date.parse(query.to) : undefined;
    const seriesFilter = query.seriesIds ? new Set(query.seriesIds) : undefined;

    return records
      .filter((record) => (seriesFilter ? seriesFilter.has(record.seriesId) : true))
      .filter((record) => {
        const observedMs = Date.parse(record.observedAt);
        return Number.isFinite(observedMs) && (fromMs === undefined || observedMs >= fromMs) && (toMs === undefined || observedMs <= toMs);
      })
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.seriesId.localeCompare(b.seriesId));
  }

  private async persistStationRecords(stationId: string, records: ChmiHydroHistoryRecord[]): Promise<void> {
    const previous = this.writeQueues.get(stationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.writeStationRecords(stationId, records));
    this.writeQueues.set(stationId, current);
    try {
      await current;
    } finally {
      if (this.writeQueues.get(stationId) === current) {
        this.writeQueues.delete(stationId);
      }
    }
  }

  private async writeStationRecords(stationId: string, records: ChmiHydroHistoryRecord[]): Promise<void> {
    const filePath = this.stationFilePath(stationId);
    const existingKeys = new Set((await this.readAllStationRecords(stationId)).map(recordKey));
    const newRecords = records.filter((record) => !existingKeys.has(recordKey(record)));
    if (newRecords.length === 0) {
      return;
    }
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${newRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  }

  private async readAllStationRecords(stationId: string): Promise<ChmiHydroHistoryRecord[]> {
    try {
      const text = await readFile(this.stationFilePath(stationId), "utf8");
      const records = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseRecord)
        .filter((record): record is ChmiHydroHistoryRecord => Boolean(record));
      return dedupeRecords(records);
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }
  }

  private stationFilePath(stationId: string): string {
    return join(this.rootDir, `${safeStationId(stationId)}.jsonl`);
  }
}

function asHydroSeriesId(value: string | undefined): HydroSeriesId | undefined {
  return value && SUPPORTED_SERIES.has(value as HydroSeriesId) ? (value as HydroSeriesId) : undefined;
}

function parseRecord(line: string): ChmiHydroHistoryRecord | undefined {
  try {
    const value = JSON.parse(line) as Partial<ChmiHydroHistoryRecord>;
    if (
      typeof value.stationId !== "string" ||
      !asHydroSeriesId(value.seriesId) ||
      (value.role !== "observation" && value.role !== "forecast") ||
      typeof value.observedAt !== "string" ||
      typeof value.value !== "number" ||
      typeof value.ingestedAt !== "string" ||
      typeof value.sourceUrl !== "string" ||
      (value.sourceKind !== "now" && value.sourceKind !== "recent")
    ) {
      return undefined;
    }
    return value as ChmiHydroHistoryRecord;
  } catch {
    return undefined;
  }
}

function dedupeRecords(records: ChmiHydroHistoryRecord[]): ChmiHydroHistoryRecord[] {
  const byKey = new Map<string, ChmiHydroHistoryRecord>();
  for (const record of records) {
    byKey.set(recordKey(record), record);
  }
  return Array.from(byKey.values());
}

function recordKey(record: ChmiHydroHistoryRecord): string {
  return `${record.seriesId}:${record.observedAt}`;
}

function safeStationId(stationId: string): string {
  return stationId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
