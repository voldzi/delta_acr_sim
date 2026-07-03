import type { FlightDataConfig } from "./config.js";
import { getAircraftType } from "./reference-data.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { FlightRouteEnrichmentService } from "./route-enrichment.js";
import type { FlightDataSource, SourceCacheStats } from "./sources.js";
import type {
  AggregatedFlightTrack,
  BoundingBox,
  FlightAdsbEmitterCategory,
  FlightDataSourceId,
  FlightTrackKeyKind,
  FlightTrackAircraftClass,
  FlightTrackIconKey,
  FlightTrackIconHint,
  FlightTrackOperationalStatus,
  FlightTrackPresentation,
  FlightQuery,
  FlightTrackResponse,
  RawFlightObservation,
  SourceDescriptor,
  SourceFetchResult
} from "./types.js";

const FLIGHT_CACHE_FETCH_LIMIT = 1000;

export class FlightAggregationService {
  private readonly cache: ManagedResponseCache<FlightTrackResponse>;

  constructor(
    private readonly config: FlightDataConfig,
    private readonly sources: FlightDataSource[],
    private readonly routeEnrichment?: FlightRouteEnrichmentService
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
    const cacheQuery = cacheQueryForFlightQuery(query, this.config);
    const cached = await this.cache.getOrLoad(cacheKeyForFlightQuery(cacheQuery), () => this.fetchTracks(cacheQuery));
    return projectFlightResponse(cached, query);
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
    const enriched = this.routeEnrichment ? await this.routeEnrichment.enrichTracks(limitedTracks) : { tracks: limitedTracks, warnings: [] };
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
      tracks: enriched.tracks,
      warnings: [...warnings, ...enriched.warnings]
    };
    return response;
  }
}

function cacheQueryForFlightQuery(query: FlightQuery, config: FlightDataConfig): FlightQuery {
  return {
    ...query,
    bbox: query.bbox ? canonicalizeBboxForCache(query.bbox, config) : undefined,
    limit: Math.max(query.limit, FLIGHT_CACHE_FETCH_LIMIT)
  };
}

function projectFlightResponse(response: FlightTrackResponse, query: FlightQuery): FlightTrackResponse {
  const tracks = response.tracks
    .filter((track) => !query.bbox || isTrackInBbox(track, query.bbox))
    .slice(0, query.limit);

  return {
    ...response,
    query: {
      bbox: query.bbox,
      limit: query.limit,
      includeStale: query.includeStale,
      sources: query.sourceIds
    },
    summary: {
      ...response.summary,
      deduplicatedTrackCount: tracks.length,
      staleTrackCount: tracks.filter((track) => track.quality.stale).length
    },
    tracks
  };
}

function cacheKeyForFlightQuery(query: FlightQuery): string {
  return JSON.stringify({
    bbox: query.bbox ? roundBbox(query.bbox) : null,
    includeStale: query.includeStale,
    limit: query.limit,
    sources: [...query.sourceIds].sort()
  });
}

function canonicalizeBboxForCache(bbox: NonNullable<FlightQuery["bbox"]>, config: FlightDataConfig): BoundingBox {
  const gridDegrees = Math.max(0, config.bboxCacheGridDegrees);
  const paddingDegrees = Math.max(0, config.bboxCachePaddingDegrees);
  if (gridDegrees === 0 && paddingDegrees === 0) {
    return roundBbox(bbox);
  }

  const west = bbox.west - paddingDegrees;
  const south = bbox.south - paddingDegrees;
  const east = bbox.east + paddingDegrees;
  const north = bbox.north + paddingDegrees;

  return {
    west: clampLongitude(gridDegrees > 0 ? floorToGrid(west, gridDegrees) : west),
    south: clampLatitude(gridDegrees > 0 ? floorToGrid(south, gridDegrees) : south),
    east: clampLongitude(gridDegrees > 0 ? ceilToGrid(east, gridDegrees) : east),
    north: clampLatitude(gridDegrees > 0 ? ceilToGrid(north, gridDegrees) : north)
  };
}

function roundBbox(bbox: NonNullable<FlightQuery["bbox"]>): BoundingBox {
  return {
    west: round(bbox.west, 5),
    south: round(bbox.south, 5),
    east: round(bbox.east, 5),
    north: round(bbox.north, 5)
  };
}

function isTrackInBbox(track: AggregatedFlightTrack, bbox: BoundingBox): boolean {
  return track.lon >= bbox.west && track.lon <= bbox.east && track.lat >= bbox.south && track.lat <= bbox.north;
}

function floorToGrid(value: number, grid: number): number {
  return round(Math.floor(value / grid) * grid, 6);
}

function ceilToGrid(value: number, grid: number): number {
  return round(Math.ceil(value / grid) * grid, 6);
}

function clampLongitude(value: number): number {
  return round(Math.min(180, Math.max(-180, value)), 6);
}

function clampLatitude(value: number): number {
  return round(Math.min(90, Math.max(-90, value)), 6);
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
    const trackKey = observationKey(observation);
    if (!trackKey) {
      continue;
    }
    if (typeof observation.lat !== "number" || typeof observation.lon !== "number") {
      droppedWithoutPositionCount += 1;
      continue;
    }
    const existing = grouped.get(trackKey.groupKey) ?? [];
    existing.push({
      ...observation,
      icao24: observation.icao24 ? normalizeIcao24(observation.icao24) : undefined,
      trackKey: trackKey.value,
      trackKeyKind: trackKey.kind
    });
    grouped.set(trackKey.groupKey, existing);
  }

  const sourceLicenseById = new Map<FlightDataSourceId, string>(sources.map((source) => [source.sourceId, source.license.name]));
  const tracks: AggregatedFlightTrack[] = [];
  const nowMs = Date.now();

  for (const [groupKey, group] of grouped) {
    const sorted = [...group].sort(compareObservationPriority);
    const primary = sorted[0];
    if (!primary || typeof primary.lat !== "number" || typeof primary.lon !== "number") {
      continue;
    }
    const trackKey = primary.trackKey ?? groupKey.slice(groupKey.indexOf(":") + 1);
    const trackKeyKind = primary.trackKeyKind ?? "partner_track";
    const icao24 = firstDefined(sorted.map((item) => item.icao24).map((value) => (value ? normalizeIcao24(value) : undefined)));
    const positionAgeSeconds = Math.max(0, Math.round((nowMs - Date.parse(primary.seenAt)) / 1000));
    const stale = positionAgeSeconds > staleAfterSeconds;
    if (stale && !includeStale) {
      continue;
    }
    const typeDesignator = firstDefined(sorted.map((item) => item.typeDesignator?.toUpperCase()));
    const aircraftType = getAircraftType(typeDesignator);
    const sourceCategory = firstDefined(sorted.map((item) => item.category));
    const iconHint = iconHintFor(typeDesignator, aircraftType?.category, aircraftType?.engineType, sourceCategory);
    const adsbCategory = adsbCategoryFor(sourceCategory);
    const aircraftClass = aircraftClassFor(typeDesignator, aircraftType?.category, aircraftType?.engineType, aircraftType?.wakeTurbulenceCategory, sourceCategory, iconHint);
    const iconKey = iconKeyFor(aircraftClass);
    const sourceLicenses = Array.from(new Set(sorted.map((item) => sourceLicenseById.get(item.sourceId)).filter((item): item is string => Boolean(item))));
    const callsign = firstDefined(sorted.map((item) => item.callsign));
    const registration = firstDefined(sorted.map((item) => item.registration));
    const status = operationalStatusFor(primary, sorted);
    const presentation = presentationFor({
      label: callsign ?? registration ?? icao24 ?? trackKey,
      iconHint,
      iconKey,
      headingDeg: primary.headingDeg,
      status
    });

    tracks.push({
      trackId: `flight:${trackKeyKind}:${trackKey}`,
      trackKey,
      trackKeyKind,
      icao24,
      callsign,
      registration,
      objectType: primary.objectType ?? (iconHint === "uav" ? "UAV" : "AIRCRAFT"),
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
        sourceCategory,
        adsbCategory,
        engineType: aircraftType?.engineType,
        wakeTurbulenceCategory: aircraftType?.wakeTurbulenceCategory,
        classKey: aircraftClass,
        iconHint,
        iconKey,
        iconFile: `${iconKey}.svg`,
        iconSet: "airspace-icons-mono-v1"
      },
      status,
      presentation,
      sources: sorted.map((item) => ({
        sourceId: item.sourceId,
        sourceRecordId: item.sourceRecordId,
        fetchedAt: item.fetchedAt,
        seenAt: item.seenAt,
        sensorId: item.sensorId
      })),
      deduplication: {
        key: trackKeyKind,
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
        sourceCategory,
        sourceKind: primary.sourceKind,
        sensorId: firstDefined(sorted.map((item) => item.sensorId)),
        remoteId: firstDefined(sorted.map((item) => item.remoteId)),
        uasRegistration: firstDefined(sorted.map((item) => item.uasRegistration)),
        operatorRegistration: firstDefined(sorted.map((item) => item.operatorRegistration)),
        serialNumber: firstDefined(sorted.map((item) => item.serialNumber)),
        sourceLicenses
      }
    });
  }

  return {
    tracks: tracks.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)),
    droppedWithoutPositionCount
  };
}

function observationKey(observation: RawFlightObservation): { groupKey: string; kind: FlightTrackKeyKind; value: string } | undefined {
  const icao24 = observation.icao24 ? normalizeIcao24(observation.icao24) : undefined;
  if (icao24) {
    return { groupKey: `icao24:${icao24}`, kind: "icao24", value: icao24 };
  }
  const kind = observation.trackKeyKind;
  const value = normalizeExternalTrackKey(observation.trackKey ?? observation.remoteId ?? observation.uasRegistration ?? observation.serialNumber);
  if (kind && value) {
    return { groupKey: `${kind}:${value}`, kind, value };
  }
  return undefined;
}

function adsbCategoryFor(sourceCategory: string | undefined): FlightAdsbEmitterCategory | undefined {
  const code = sourceCategory?.trim().toUpperCase();
  if (!code) {
    return undefined;
  }
  const byCode: Record<string, FlightAdsbEmitterCategory> = {
    A0: { code: "A0", label: "No ADS-B emitter category information", group: "unknown" },
    A1: { code: "A1", label: "Light aircraft", group: "aircraft" },
    A2: { code: "A2", label: "Small aircraft", group: "aircraft" },
    A3: { code: "A3", label: "Large aircraft", group: "aircraft" },
    A4: { code: "A4", label: "High vortex large aircraft", group: "aircraft" },
    A5: { code: "A5", label: "Heavy aircraft", group: "aircraft" },
    A6: { code: "A6", label: "High performance aircraft", group: "aircraft" },
    A7: { code: "A7", label: "Rotorcraft", group: "rotorcraft" },
    B1: { code: "B1", label: "Glider or sailplane", group: "aircraft" },
    B2: { code: "B2", label: "Lighter-than-air aircraft", group: "aircraft" },
    B3: { code: "B3", label: "Parachutist or skydiver", group: "unknown" },
    B4: { code: "B4", label: "Ultralight, hang-glider or paraglider", group: "aircraft" },
    B6: { code: "B6", label: "Unmanned aerial vehicle", group: "uav" },
    B7: { code: "B7", label: "Space or trans-atmospheric vehicle", group: "unknown" },
    C1: { code: "C1", label: "Surface emergency vehicle", group: "surface" },
    C2: { code: "C2", label: "Surface service vehicle", group: "surface" },
    C3: { code: "C3", label: "Point obstacle", group: "obstacle" },
    C4: { code: "C4", label: "Cluster obstacle", group: "obstacle" },
    C5: { code: "C5", label: "Line obstacle", group: "obstacle" }
  };
  if (byCode[code]) {
    return byCode[code];
  }
  if (code.startsWith("OPENSKY:")) {
    return { code, label: `OpenSky category ${code.slice("OPENSKY:".length)}`, group: "unknown" };
  }
  return { code, label: `ADS-B category ${code}`, group: "unknown" };
}

function aircraftClassFor(
  typeDesignator: string | undefined,
  aircraftCategory: string | undefined,
  engineType: string | undefined,
  wakeTurbulenceCategory: string | undefined,
  sourceCategory: string | undefined,
  iconHint: FlightTrackIconHint
): FlightTrackAircraftClass {
  const designator = typeDesignator?.toUpperCase() ?? "";
  const category = `${aircraftCategory ?? ""} ${sourceCategory ?? ""}`.toLowerCase();
  const engine = engineType?.toLowerCase() ?? "";
  const wake = wakeTurbulenceCategory?.toLowerCase() ?? "";

  if (iconHint === "uav") {
    return designator.includes("VTOL") ? "uav_vtol" : "uav_fixed_wing";
  }
  if (category.includes("b4")) {
    return "ultralight";
  }
  if (iconHint === "glider") {
    return "glider";
  }
  if (isMilitaryFighterDesignator(designator) || category.includes("a6")) {
    return "military_fighter";
  }
  if (isMilitaryTransportDesignator(designator)) {
    return "military_transport";
  }
  if (isMilitaryBomberDesignator(designator)) {
    return "military_bomber";
  }
  if (iconHint === "helicopter") {
    if (isMilitaryHelicopterDesignator(designator)) {
      return "helicopter_military";
    }
    return wake.includes("heavy") || isHeavyHelicopterDesignator(designator) ? "helicopter_heavy" : "helicopter_medium";
  }
  if (isCargoDesignator(designator)) {
    return "cargo_freighter";
  }
  if (isJumboDesignator(designator)) {
    return "jumbo_airliner";
  }
  if (wake.includes("heavy") || isWidebodyDesignator(designator) || category.includes("a5")) {
    return "widebody_airliner";
  }
  if (isBusinessJetDesignator(designator)) {
    return "business_jet";
  }
  if (isRegionalJetDesignator(designator)) {
    return "regional_jet";
  }
  if (isNarrowbodyDesignator(designator)) {
    return "narrowbody_airliner";
  }
  if (isTurbopropDesignator(designator)) {
    return "turboprop";
  }
  if (engine.includes("jet")) {
    return "narrowbody_airliner";
  }
  if (iconHint === "turboprop" || engine.includes("turboprop")) {
    return "turboprop";
  }
  if (isLightTwinDesignator(designator)) {
    return "light_twin";
  }
  if (iconHint === "small_aircraft") {
    return "small_ga";
  }
  return "unknown";
}

function iconKeyFor(aircraftClass: FlightTrackAircraftClass): FlightTrackIconKey {
  const byClass: Record<FlightTrackAircraftClass, FlightTrackIconKey> = {
    small_ga: "aircraft_01_small_ga",
    light_twin: "aircraft_02_light_twin",
    turboprop: "aircraft_03_turboprop",
    business_jet: "aircraft_04_business_jet",
    regional_jet: "aircraft_05_regional_jet",
    narrowbody_airliner: "aircraft_06_narrowbody_airliner",
    widebody_airliner: "aircraft_07_widebody_airliner",
    jumbo_airliner: "aircraft_08_jumbo_airliner",
    cargo_freighter: "aircraft_09_cargo_freighter",
    glider: "aircraft_10_glider",
    military_fighter: "aircraft_11_military_fighter",
    military_transport: "aircraft_12_military_transport",
    military_bomber: "aircraft_13_military_bomber",
    aerobatic_prop: "aircraft_14_aerobatic_prop",
    seaplane: "aircraft_15_seaplane",
    ultralight: "aircraft_16_ultralight",
    helicopter_light: "aircraft_17_helicopter_light",
    helicopter_medium: "aircraft_18_helicopter_medium",
    helicopter_heavy: "aircraft_19_helicopter_heavy",
    helicopter_military: "aircraft_20_helicopter_military",
    uav_multirotor: "drone_01_quadcopter",
    uav_fixed_wing: "drone_03_fixed_wing_uav",
    uav_vtol: "drone_05_vtol_hybrid",
    unknown: "aircraft_01_small_ga"
  };
  return byClass[aircraftClass];
}

function operationalStatusFor(primary: RawFlightObservation, sorted: RawFlightObservation[]): FlightTrackOperationalStatus {
  const squawk = firstDefined(sorted.map((item) => item.squawk));
  const rawEmergency = firstDefined(sorted.map((item) => item.emergency));
  const emergency = emergencyStatusFor(rawEmergency, squawk);
  const delay = {
    status: "unknown" as const,
    source: "not_available" as const,
    reason: "No authorized scheduled/actual departure-arrival feed is configured; render as normal unless SIM later reports delayed."
  };
  return {
    emergency,
    delay,
    phase: flightPhaseFor(primary)
  };
}

function emergencyStatusFor(
  rawEmergency: string | undefined,
  squawk: string | undefined
): FlightTrackOperationalStatus["emergency"] {
  const normalizedEmergency = rawEmergency?.trim().toLowerCase();
  if (squawk === "7500") {
    return { active: true, code: "unlawful_interference", label: "Unlawful interference", source: "squawk", squawk, rawEmergency };
  }
  if (squawk === "7600") {
    return { active: true, code: "radio_failure", label: "Radio failure", source: "squawk", squawk, rawEmergency };
  }
  if (squawk === "7700") {
    return { active: true, code: "general", label: "General emergency", source: "squawk", squawk, rawEmergency };
  }
  if (normalizedEmergency && normalizedEmergency !== "none" && normalizedEmergency !== "no") {
    const mapped = emergencyCodeFor(normalizedEmergency);
    return { active: true, code: mapped.code, label: mapped.label, source: "adsb_emergency", squawk, rawEmergency };
  }
  return { active: false, label: "No emergency reported", source: "none", squawk, rawEmergency };
}

function emergencyCodeFor(value: string): { code: NonNullable<FlightTrackOperationalStatus["emergency"]["code"]>; label: string } {
  switch (value) {
    case "general":
      return { code: "general", label: "General emergency" };
    case "nordo":
    case "radio":
      return { code: "radio_failure", label: "Radio failure" };
    case "unlawful":
    case "hijack":
      return { code: "unlawful_interference", label: "Unlawful interference" };
    case "minfuel":
      return { code: "minimum_fuel", label: "Minimum fuel" };
    case "lifeguard":
    case "medical":
      return { code: "lifeguard", label: "Medical or lifeguard flight" };
    case "downed":
      return { code: "downed", label: "Downed aircraft" };
    case "reserved":
      return { code: "reserved", label: "Reserved emergency code" };
    default:
      return { code: "unknown", label: `Emergency reported: ${value}` };
  }
}

function flightPhaseFor(primary: RawFlightObservation): FlightTrackOperationalStatus["phase"] {
  if (primary.onGround || primary.altitudeM === 0) {
    return "ground";
  }
  if (typeof primary.verticalRateMps === "number") {
    if (primary.verticalRateMps > 1) {
      return "climb";
    }
    if (primary.verticalRateMps < -1) {
      return "descent";
    }
  }
  if (typeof primary.altitudeM === "number" && primary.altitudeM > 1500) {
    return "cruise";
  }
  return "unknown";
}

function presentationFor(input: {
  label: string;
  iconHint: FlightTrackIconHint;
  iconKey: FlightTrackIconKey;
  headingDeg: number | undefined;
  status: FlightTrackOperationalStatus;
}): FlightTrackPresentation {
  const color =
    input.status.emergency.active
      ? { colorKey: "emergency" as const, colorHex: "#ef4444" as const, colorReason: "emergency_detected" as const, zIndexPriority: 90 }
      : input.status.delay.status === "delayed"
        ? { colorKey: "delayed" as const, colorHex: "#eab308" as const, colorReason: "delay_detected" as const, zIndexPriority: 50 }
        : {
            colorKey: "normal" as const,
            colorHex: "#22c55e" as const,
            colorReason: input.status.delay.status === "unknown" ? ("delay_not_available" as const) : ("normal" as const),
            zIndexPriority: 10
          };

  return {
    label: input.label,
    iconSet: "airspace-icons-mono-v1",
    iconKey: input.iconKey,
    iconFile: `${input.iconKey}.svg`,
    iconHint: input.iconHint,
    rotateWithHeading: true,
    rotationDeg: input.headingDeg,
    ...color
  };
}

function isBusinessJetDesignator(designator: string): boolean {
  return /^(C25|C5[256]|C68|C70|CL3|CL6|E5[05]|F2TH|F900|FA[057]|G[0-9]|GLF|GL[567]|H25|LJ|PRM|SF50)/.test(designator);
}

function isRegionalJetDesignator(designator: string): boolean {
  return /^(CRJ|E1[3579]|E2[79]|ERJ|F70|F100|BCS[13])/.test(designator);
}

function isNarrowbodyDesignator(designator: string): boolean {
  return /^(A19|A20|A21|A22|B70|B71|B72|B73|B38|B39|B75|B752|MD8|MD9|DC9|SU95)/.test(designator);
}

function isWidebodyDesignator(designator: string): boolean {
  return /^(A30|A31|A33|A34|A35|A38|B76|B77|B78|B74|B748|IL9|IL96|MD11)/.test(designator);
}

function isJumboDesignator(designator: string): boolean {
  return /^(A388|B74|B748|AN22|AN124|AN225)/.test(designator);
}

function isCargoDesignator(designator: string): boolean {
  return /^(BLCF|A3ST|A124|AN12|AN26|C130|C17|C5M|IL76)/.test(designator);
}

function isMilitaryFighterDesignator(designator: string): boolean {
  return /^(F1|F2|F3|F4|F5|F6|F7|F8|F9|F15|F16|F18|F22|F35|EUFI|MIG|SU[0-9]|RAFA|TOR|GRIP|L39|L159)/.test(designator);
}

function isMilitaryTransportDesignator(designator: string): boolean {
  return /^(A400|C130|C17|C27J|C295|C5M|KC|IL76|AN12|AN26|AN72)/.test(designator);
}

function isMilitaryBomberDesignator(designator: string): boolean {
  return /^(B1|B2|B52|TU16|TU22|TU95|TU160)/.test(designator);
}

function isMilitaryHelicopterDesignator(designator: string): boolean {
  return /^(AH|H60|UH|CH|MI8|MI17|MI24|MI35|KA)/.test(designator);
}

function isHeavyHelicopterDesignator(designator: string): boolean {
  return /^(CH47|CH53|MI26|S64)/.test(designator);
}

function isLightTwinDesignator(designator: string): boolean {
  return /^(DA42|BE5[568]|BE9|PA3[014]|P68|C310|C340|C414|C421)/.test(designator);
}

function isTurbopropDesignator(designator: string): boolean {
  return /^(AT[457]|DH8|DHC6|SF34|SB20|F50|F27|JS41|L410|E120|PC12|B350|BE20|BE30|BE40|C208)/.test(designator);
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
  if (
    isBusinessJetDesignator(designator) ||
    isRegionalJetDesignator(designator) ||
    isNarrowbodyDesignator(designator) ||
    isWidebodyDesignator(designator) ||
    isJumboDesignator(designator)
  ) {
    return "jet";
  }
  if (isTurbopropDesignator(designator)) {
    return "turboprop";
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

function normalizeIcao24(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[0-9a-f]{6}$/.test(normalized) ? normalized : undefined;
}

function normalizeExternalTrackKey(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized ? normalized.slice(0, 96) : undefined;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
