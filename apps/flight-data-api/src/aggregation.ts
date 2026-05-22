import type { FlightDataConfig } from "./config.js";
import { getAircraftType } from "./reference-data.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { FlightDataSource, SourceCacheStats } from "./sources.js";
import type {
  AggregatedFlightTrack,
  BoundingBox,
  FlightDataSourceId,
  FlightTrackIconHint,
  FlightQuery,
  FlightTrackResponse,
  RawFlightObservation,
  SourceDescriptor,
  SourceFetchResult
} from "./types.js";

export class FlightAggregationService {
  private readonly cache: ManagedResponseCache<FlightTrackResponse>;

  constructor(
    private readonly config: FlightDataConfig,
    private readonly sources: FlightDataSource[]
  ) {
    this.cache = new ManagedResponseCache<FlightTrackResponse>({
      ttlMs: config.cacheTtlSeconds * 1000,
      staleIfErrorMs: config.staleIfErrorSeconds * 1000,
      maxEntries: config.cacheMaxEntries
    });
  }

  cacheStats(): ManagedResponseCacheStats {
    return this.cache.stats();
  }

  sourceCacheStats(): SourceCacheStats[] {
    return this.sources.flatMap((source) => source.cacheStats?.() ?? []);
  }

  async getTracks(query: FlightQuery): Promise<FlightTrackResponse> {
    return this.cache.getOrLoad(cacheKeyForFlightQuery(query), () => this.fetchTracks(query));
  }

  private async fetchTracks(query: FlightQuery): Promise<FlightTrackResponse> {
    const enabledSources = this.sources.filter((source) => query.sourceIds.includes(source.descriptor.sourceId));
    const settled = await Promise.allSettled(enabledSources.map((source) => source.fetchObservations(query)));
    const results: SourceFetchResult[] = [];
    const warnings: string[] = [];

    for (const item of settled) {
      if (item.status === "fulfilled") {
        results.push(item.value);
        warnings.push(...item.value.warnings);
      } else {
        warnings.push(item.reason instanceof Error ? item.reason.message : "Unknown source fetch failure.");
      }
    }

    const sourceDescriptors = enabledSources.map((source) => source.descriptor);
    const rawObservations = results.flatMap((result) => result.observations);
    const { tracks, droppedWithoutPositionCount } = deduplicateObservations(rawObservations, sourceDescriptors, this.config.staleAfterSeconds, query.includeStale);
    const limitedTracks = tracks.slice(0, query.limit);
    const response: FlightTrackResponse = {
      generatedAt: new Date().toISOString(),
      query: {
        bbox: query.bbox,
        limit: query.limit,
        includeStale: query.includeStale,
        sources: query.sourceIds
      },
      summary: {
        rawObservationCount: rawObservations.length,
        deduplicatedTrackCount: limitedTracks.length,
        droppedWithoutPositionCount,
        staleTrackCount: limitedTracks.filter((track) => track.quality.stale).length
      },
      sources: sourceDescriptors,
      tracks: limitedTracks,
      warnings
    };
    return response;
  }
}

function cacheKeyForFlightQuery(query: FlightQuery): string {
  return JSON.stringify({
    bbox: query.bbox ? roundBbox(query.bbox) : null,
    includeStale: query.includeStale,
    limit: query.limit,
    sources: [...query.sourceIds].sort()
  });
}

function roundBbox(bbox: NonNullable<FlightQuery["bbox"]>): BoundingBox {
  return {
    west: round(bbox.west, 5),
    south: round(bbox.south, 5),
    east: round(bbox.east, 5),
    north: round(bbox.north, 5)
  };
}

function deduplicateObservations(
  observations: RawFlightObservation[],
  sources: SourceDescriptor[],
  staleAfterSeconds: number,
  includeStale: boolean
): { tracks: AggregatedFlightTrack[]; droppedWithoutPositionCount: number } {
  const grouped = new Map<string, RawFlightObservation[]>();
  let droppedWithoutPositionCount = 0;

  for (const observation of observations) {
    const icao24 = normalizeIcao24(observation.icao24);
    if (!icao24) {
      continue;
    }
    if (typeof observation.lat !== "number" || typeof observation.lon !== "number") {
      droppedWithoutPositionCount += 1;
      continue;
    }
    const existing = grouped.get(icao24) ?? [];
    existing.push({ ...observation, icao24 });
    grouped.set(icao24, existing);
  }

  const sourceLicenseById = new Map<FlightDataSourceId, string>(sources.map((source) => [source.sourceId, source.license.name]));
  const tracks: AggregatedFlightTrack[] = [];
  const nowMs = Date.now();

  for (const [icao24, group] of grouped) {
    const sorted = [...group].sort(compareObservationPriority);
    const primary = sorted[0];
    if (!primary || typeof primary.lat !== "number" || typeof primary.lon !== "number") {
      continue;
    }
    const positionAgeSeconds = Math.max(0, Math.round((nowMs - Date.parse(primary.seenAt)) / 1000));
    const stale = positionAgeSeconds > staleAfterSeconds;
    if (stale && !includeStale) {
      continue;
    }
    const typeDesignator = firstDefined(sorted.map((item) => item.typeDesignator?.toUpperCase()));
    const aircraftType = getAircraftType(typeDesignator);
    const sourceCategory = firstDefined(sorted.map((item) => item.category));
    const iconHint = iconHintFor(typeDesignator, aircraftType?.category, aircraftType?.engineType, sourceCategory);
    const sourceLicenses = Array.from(new Set(sorted.map((item) => sourceLicenseById.get(item.sourceId)).filter((item): item is string => Boolean(item))));

    tracks.push({
      trackId: `flight:icao24:${icao24}`,
      icao24,
      callsign: firstDefined(sorted.map((item) => item.callsign)),
      registration: firstDefined(sorted.map((item) => item.registration)),
      objectType: iconHint === "uav" ? "UAV" : "AIRCRAFT",
      domain: "AIR",
      lat: round(primary.lat, 6),
      lon: round(primary.lon, 6),
      position: {
        lat: round(primary.lat, 6),
        lon: round(primary.lon, 6)
      },
      altitudeM: primary.altitudeM,
      speedMps: primary.speedMps,
      headingDeg: primary.headingDeg,
      verticalRateMps: primary.verticalRateMps,
      lastSeenAt: primary.seenAt,
      originCountry: firstDefined(sorted.map((item) => item.originCountry)),
      aircraft: {
        typeDesignator,
        manufacturer: aircraftType?.manufacturer,
        model: aircraftType?.model,
        category: aircraftType?.category,
        engineType: aircraftType?.engineType,
        wakeTurbulenceCategory: aircraftType?.wakeTurbulenceCategory,
        iconHint
      },
      sources: sorted.map((item) => ({
        sourceId: item.sourceId,
        sourceRecordId: item.sourceRecordId,
        fetchedAt: item.fetchedAt,
        seenAt: item.seenAt
      })),
      deduplication: {
        key: "icao24",
        mergedRecordCount: sorted.length,
        primarySourceId: primary.sourceId
      },
      quality: {
        confidence: confidenceFor(sorted.length, positionAgeSeconds, staleAfterSeconds),
        stale,
        positionAgeSeconds
      },
      metadata: {
        onGround: primary.onGround,
        squawk: primary.squawk,
        emergency: primary.emergency,
        sourceLicenses
      }
    });
  }

  return {
    tracks: tracks.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)),
    droppedWithoutPositionCount
  };
}

function iconHintFor(
  typeDesignator: string | undefined,
  aircraftCategory: string | undefined,
  engineType: string | undefined,
  sourceCategory: string | undefined
): FlightTrackIconHint {
  const designator = typeDesignator?.toUpperCase() ?? "";
  const category = `${aircraftCategory ?? ""} ${sourceCategory ?? ""}`.toLowerCase();
  const engine = engineType?.toLowerCase() ?? "";

  if (category.includes("uav") || category.includes("drone") || category.includes("b6") || designator.startsWith("UAV")) {
    return "uav";
  }
  if (category.includes("glider") || category.includes("b1")) {
    return "glider";
  }
  if (category.includes("helicopter") || category.includes("rotor") || category.includes("a7") || designator.startsWith("H")) {
    return "helicopter";
  }
  if (engine.includes("turboprop") || engine.includes("turboshaft")) {
    return "turboprop";
  }
  if (engine.includes("jet")) {
    return "jet";
  }
  if (engine.includes("piston") || category.includes("light") || ["C", "D", "P"].some((prefix) => designator.startsWith(prefix))) {
    return "small_aircraft";
  }
  return "unknown";
}

function compareObservationPriority(a: RawFlightObservation, b: RawFlightObservation): number {
  const priorityDelta = b.sourcePriority - a.sourcePriority;
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return Date.parse(b.seenAt) - Date.parse(a.seenAt);
}

function confidenceFor(sourceCount: number, positionAgeSeconds: number, staleAfterSeconds: number): number {
  const sourceBonus = Math.min(0.25, (sourceCount - 1) * 0.08);
  const agePenalty = Math.min(0.45, positionAgeSeconds / Math.max(1, staleAfterSeconds) / 2);
  return round(Math.max(0.15, Math.min(0.99, 0.76 + sourceBonus - agePenalty)), 2);
}

function firstDefined<T>(values: Array<T | undefined>): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function normalizeIcao24(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{6}$/.test(normalized) ? normalized : undefined;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
