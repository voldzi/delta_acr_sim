import type { FlightDataConfig } from "./config.js";
import { ManagedResponseCache } from "./response-cache.js";
import type { ManagedResponseCacheStats } from "./response-cache.js";
import type {
  BoundingBox,
  FlightDataLicense,
  FlightDataSourceId,
  FlightQuery,
  RawFlightObservation,
  SourceDescriptor,
  SourceFetchResult
} from "./types.js";

export interface FlightDataSource {
  descriptor: SourceDescriptor;
  fetchObservations(query: FlightQuery): Promise<SourceFetchResult>;
  cacheStats?(): SourceCacheStats[];
}

export interface SourceCacheStats extends ManagedResponseCacheStats {
  sourceId: FlightDataSourceId;
}

const ADSB_LOL_LICENSE: FlightDataLicense = {
  name: "ODbL 1.0",
  url: "https://opendatacommons.org/licenses/odbl/1-0/",
  attribution: "ADSB.lol contributors",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: ["Attribution is required.", "Public adapted databases must remain under ODbL.", "Production use should be coordinated with ADSB.lol."]
};

const OPENSKY_LICENSE: FlightDataLicense = {
  name: "OpenSky Terms of Use",
  url: "https://opensky-network.org/about/terms-of-use",
  attribution: "The OpenSky Network",
  commercialUse: "requires_license",
  operationalUse: "requires_license",
  notes: ["Commercial use requires written permission.", "Operational REST API use requires a written agreement."]
};

const MOCK_LICENSE: FlightDataLicense = {
  name: "Synthetic internal test data",
  attribution: "DELTA ACR SIM",
  commercialUse: "allowed",
  operationalUse: "allowed",
  notes: ["Synthetic data only. No external aviation data is used by this source."]
};

const LOCAL_ADSB_LICENSE: FlightDataLicense = {
  name: "Owner-operated ADS-B receiver feed",
  attribution: "Local ADS-B receiver network",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Use only receivers operated by the project or by partners who explicitly allow redistribution.",
    "Do not proxy third-party commercial/community feeds through this source unless their terms permit it.",
    "ADS-B positions are situational context and can be incomplete for low altitude traffic."
  ]
};

export function createFlightDataSources(config: FlightDataConfig): FlightDataSource[] {
  const allSources: Record<FlightDataSourceId, FlightDataSource> = {
    mock: new MockFlightDataSource(),
    adsb_lol: new AdsbLolSource(config),
    opensky: new OpenSkySource(config),
    local_adsb: new LocalAdsbSource(config)
  };

  return config.enabledSources.map((sourceId) => allSources[sourceId]);
}

export function allSourceDescriptors(config: FlightDataConfig): SourceDescriptor[] {
  const enabled = new Set(config.enabledSources);
  return [
    new MockFlightDataSource().descriptor,
    new AdsbLolSource(config).descriptor,
    new OpenSkySource(config).descriptor,
    new LocalAdsbSource(config).descriptor
  ].map((descriptor) => ({ ...descriptor, enabled: enabled.has(descriptor.sourceId) }));
}

function cacheStatsFor<T>(sourceId: FlightDataSourceId, cache: ManagedResponseCache<T>): SourceCacheStats {
  return {
    sourceId,
    ...cache.stats()
  };
}

class MockFlightDataSource implements FlightDataSource {
  readonly descriptor: SourceDescriptor = {
    sourceId: "mock",
    label: "Synthetic local flight feed",
    enabled: true,
    mode: "mock",
    priority: 10,
    license: MOCK_LICENSE
  };

  async fetchObservations(query: FlightQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const observations: RawFlightObservation[] = [
      {
        sourceId: "mock",
        sourceRecordId: "mock:4d2216:adsb",
        sourcePriority: this.descriptor.priority,
        fetchedAt,
        seenAt: fetchedAt,
        icao24: "4d2216",
        callsign: "CSA42",
        registration: "OK-TSR",
        typeDesignator: "A320",
        originCountry: "Czech Republic",
        lat: 50.1174,
        lon: 14.5121,
        altitudeM: 2743,
        speedMps: 138,
        headingDeg: 268,
        verticalRateMps: 2.1,
        category: "A3"
      },
      {
        sourceId: "mock",
        sourceRecordId: "mock:4d2216:mlat",
        sourcePriority: this.descriptor.priority - 1,
        fetchedAt,
        seenAt: new Date(Date.now() - 4000).toISOString(),
        icao24: "4D2216",
        callsign: "CSA42",
        registration: "OK-TSR",
        typeDesignator: "A320",
        lat: 50.117,
        lon: 14.509,
        altitudeM: 2738,
        speedMps: 137,
        headingDeg: 269
      },
      {
        sourceId: "mock",
        sourceRecordId: "mock:49d304:adsb",
        sourcePriority: this.descriptor.priority,
        fetchedAt,
        seenAt: fetchedAt,
        icao24: "49d304",
        callsign: "TVS8BC",
        registration: "OK-TST",
        typeDesignator: "B738",
        originCountry: "Czech Republic",
        lat: 49.982,
        lon: 14.1842,
        altitudeM: 5182,
        speedMps: 217,
        headingDeg: 116,
        verticalRateMps: -4.6,
        squawk: "2741",
        category: "A3"
      },
      {
        sourceId: "mock",
        sourceRecordId: "mock:440090:adsb",
        sourcePriority: this.descriptor.priority,
        fetchedAt,
        seenAt: fetchedAt,
        icao24: "440090",
        callsign: "AUA7PR",
        registration: "OE-LZD",
        typeDesignator: "A320",
        originCountry: "Austria",
        lat: 48.741,
        lon: 16.044,
        altitudeM: 10668,
        speedMps: 236,
        headingDeg: 338,
        category: "A3"
      }
    ];

    return {
      source: this.descriptor,
      fetchedAt,
      observations: observations.filter((observation) => !query.bbox || isObservationInBbox(observation, query.bbox)),
      warnings: []
    };
  }
}

class AdsbLolSource implements FlightDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<AdsbLolResponse>;

  constructor(private readonly config: FlightDataConfig) {
    this.payloadCache = new ManagedResponseCache<AdsbLolResponse>({
      ttlMs: config.cacheTtlSeconds * 1000,
      staleIfErrorMs: config.staleIfErrorSeconds * 1000,
      maxEntries: config.cacheMaxEntries
    });
    this.descriptor = {
      sourceId: "adsb_lol",
      label: "ADSB.lol open ADS-B feed",
      enabled: config.enabledSources.includes("adsb_lol"),
      mode: "live",
      priority: 80,
      license: ADSB_LOL_LICENSE,
      baseUrl: config.adsbLolBaseUrl
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("adsb_lol", this.payloadCache)];
  }

  async fetchObservations(query: FlightQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const area = query.bbox ? bboxToPointRadius(query.bbox) : { lat: this.config.defaultLat, lon: this.config.defaultLon, radiusNm: this.config.defaultRadiusNm };
    const url = `${this.config.adsbLolBaseUrl}/v2/lat/${area.lat.toFixed(4)}/lon/${area.lon.toFixed(4)}/dist/${Math.min(250, Math.max(1, Math.ceil(area.radiusNm)))}`;
    const payload = await this.payloadCache.getOrLoad(url, () => requestJson<AdsbLolResponse>(url, this.config.requestTimeoutMs));
    const nowMs = typeof payload.now === "number" ? payload.now : Date.now();

    const observations = (payload.ac ?? [])
      .map((item): RawFlightObservation | undefined => {
        const icao24 = normalizeIcao24(item.hex);
        if (!icao24) {
          return undefined;
        }
        const seenMs = Number.isFinite(item.seen) ? nowMs - item.seen * 1000 : nowMs;
        return {
          sourceId: "adsb_lol",
          sourceRecordId: `adsb_lol:${icao24}`,
          sourcePriority: this.descriptor.priority,
          fetchedAt,
          seenAt: new Date(seenMs).toISOString(),
          icao24,
          callsign: cleanString(item.flight),
          registration: cleanString(item.r),
          typeDesignator: cleanString(item.t)?.toUpperCase(),
          lat: optionalNumber(item.lat),
          lon: optionalNumber(item.lon),
          altitudeM: altitudeToMeters(item.alt_baro ?? item.alt_geom),
          speedMps: knotsToMps(item.gs),
          headingDeg: optionalNumber(item.track),
          verticalRateMps: feetPerMinuteToMps(item.baro_rate ?? item.geom_rate),
          squawk: cleanString(item.squawk),
          emergency: cleanString(item.emergency),
          category: cleanString(item.category),
          raw: item
        };
      })
      .filter((item): item is RawFlightObservation => Boolean(item))
      .filter((observation) => !query.bbox || isObservationInBbox(observation, query.bbox));

    return { source: this.descriptor, fetchedAt, observations, warnings: [] };
  }
}

class OpenSkySource implements FlightDataSource {
  readonly descriptor: SourceDescriptor;
  private cachedToken?: { value: string; expiresAtMs: number };
  private readonly payloadCache: ManagedResponseCache<OpenSkyResponse>;

  constructor(private readonly config: FlightDataConfig) {
    this.payloadCache = new ManagedResponseCache<OpenSkyResponse>({
      ttlMs: config.cacheTtlSeconds * 1000,
      staleIfErrorMs: config.staleIfErrorSeconds * 1000,
      maxEntries: config.cacheMaxEntries
    });
    this.descriptor = {
      sourceId: "opensky",
      label: "OpenSky Network REST API",
      enabled: config.enabledSources.includes("opensky"),
      mode: "live",
      priority: 70,
      license: OPENSKY_LICENSE,
      baseUrl: config.openskyBaseUrl
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("opensky", this.payloadCache)];
  }

  async fetchObservations(query: FlightQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const url = new URL(`${this.config.openskyBaseUrl}/states/all`);
    if (query.bbox) {
      url.searchParams.set("lamin", String(query.bbox.south));
      url.searchParams.set("lomin", String(query.bbox.west));
      url.searchParams.set("lamax", String(query.bbox.north));
      url.searchParams.set("lomax", String(query.bbox.east));
    }
    const headers = await this.authHeaders();
    const payload = await this.payloadCache.getOrLoad(`${headers.Authorization ? "auth" : "public"}:${url.toString()}`, () =>
      requestJson<OpenSkyResponse>(url.toString(), this.config.requestTimeoutMs, headers)
    );
    const baseTimeMs = typeof payload.time === "number" ? payload.time * 1000 : Date.now();
    const observations = (payload.states ?? [])
      .map((state): RawFlightObservation | undefined => mapOpenSkyState(state, fetchedAt, baseTimeMs, this.descriptor.priority))
      .filter((item): item is RawFlightObservation => Boolean(item))
      .filter((observation) => !query.bbox || isObservationInBbox(observation, query.bbox));
    return { source: this.descriptor, fetchedAt, observations, warnings: [] };
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.config.openskyAccessToken) {
      return { Authorization: `Bearer ${this.config.openskyAccessToken}` };
    }
    if (!this.config.openskyClientId || !this.config.openskyClientSecret) {
      return {};
    }
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs > now + 30_000) {
      return { Authorization: `Bearer ${this.cachedToken.value}` };
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.openskyClientId,
      client_secret: this.config.openskyClientSecret
    });
    const payload = await requestJson<{ access_token: string; expires_in?: number }>(this.config.openskyAuthUrl, this.config.requestTimeoutMs, {
      "content-type": "application/x-www-form-urlencoded"
    }, body);
    const expiresInMs = Number(payload.expires_in ?? 1800) * 1000;
    this.cachedToken = { value: payload.access_token, expiresAtMs: now + expiresInMs };
    return { Authorization: `Bearer ${payload.access_token}` };
  }
}

class LocalAdsbSource implements FlightDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<ReadsbAircraftResponse>;

  constructor(private readonly config: FlightDataConfig) {
    this.payloadCache = new ManagedResponseCache<ReadsbAircraftResponse>({
      ttlMs: Math.max(1, config.cacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(10, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(1, Math.min(config.cacheMaxEntries, 64))
    });
    this.descriptor = {
      sourceId: "local_adsb",
      label: "Local readsb/dump1090 ADS-B receivers",
      enabled: config.enabledSources.includes("local_adsb"),
      mode: "live",
      priority: 90,
      license: LOCAL_ADSB_LICENSE,
      baseUrl: config.localAdsbAircraftJsonUrls.length <= 1 ? config.localAdsbAircraftJsonUrls[0] : "multiple receivers"
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("local_adsb", this.payloadCache)];
  }

  async fetchObservations(query: FlightQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (this.config.localAdsbAircraftJsonUrls.length === 0) {
      return {
        source: this.descriptor,
        fetchedAt,
        observations: [],
        warnings: ["local_adsb is enabled but LOCAL_ADSB_AIRCRAFT_JSON_URLS is not configured."]
      };
    }

    const settled = await Promise.allSettled(
      this.config.localAdsbAircraftJsonUrls.map((url) =>
        this.payloadCache.getOrLoad(`local_adsb:${url}`, () =>
          requestJson<ReadsbAircraftResponse>(url, this.config.requestTimeoutMs, { accept: "application/json" })
        )
      )
    );
    const observations: RawFlightObservation[] = [];
    const warnings: string[] = [];

    settled.forEach((item, index) => {
      const url = this.config.localAdsbAircraftJsonUrls[index] ?? `receiver-${index + 1}`;
      if (item.status === "rejected") {
        warnings.push(item.reason instanceof Error ? `local_adsb ${receiverLabel(url)} failed: ${item.reason.message}` : `local_adsb ${receiverLabel(url)} failed.`);
        return;
      }
      observations.push(
        ...mapReadsbAircraftResponse(item.value, {
          fetchedAt,
          sourcePriority: this.descriptor.priority,
          receiverId: receiverLabel(url)
        })
      );
    });

    return {
      source: this.descriptor,
      fetchedAt,
      observations: observations.filter((observation) => !query.bbox || isObservationInBbox(observation, query.bbox)),
      warnings
    };
  }
}

interface AdsbLolResponse {
  now?: number;
  ac?: Array<{
    hex?: string;
    flight?: string | null;
    r?: string | null;
    t?: string | null;
    lat?: number | null;
    lon?: number | null;
    alt_baro?: number | string | null;
    alt_geom?: number | null;
    gs?: number | null;
    track?: number | null;
    baro_rate?: number | null;
    geom_rate?: number | null;
    squawk?: string | null;
    emergency?: string | null;
    category?: string | null;
    seen: number;
  }>;
}

interface OpenSkyResponse {
  time?: number;
  states?: unknown[][];
}

interface ReadsbAircraftResponse {
  now?: number;
  aircraft?: ReadsbAircraft[];
}

interface ReadsbAircraft {
  hex?: string;
  flight?: string | null;
  r?: string | null;
  t?: string | null;
  dbFlags?: number | null;
  lat?: number | null;
  lon?: number | null;
  alt_baro?: number | string | null;
  alt_geom?: number | null;
  gs?: number | null;
  track?: number | null;
  true_heading?: number | null;
  mag_heading?: number | null;
  baro_rate?: number | null;
  geom_rate?: number | null;
  squawk?: string | null;
  emergency?: string | null;
  category?: string | null;
  seen?: number | null;
  seen_pos?: number | null;
  type?: string | null;
}

async function requestJson<T>(url: string, timeoutMs: number, headers: Record<string, string> = {}, body?: URLSearchParams): Promise<T> {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return (await response.json()) as T;
}

function mapOpenSkyState(state: unknown[], fetchedAt: string, baseTimeMs: number, priority: number): RawFlightObservation | undefined {
  const icao24 = normalizeIcao24(asString(state[0]));
  const lon = optionalNumber(state[5]);
  const lat = optionalNumber(state[6]);
  if (!icao24) {
    return undefined;
  }
  const lastContact = optionalNumber(state[4]);
  return {
    sourceId: "opensky",
    sourceRecordId: `opensky:${icao24}`,
    sourcePriority: priority,
    fetchedAt,
    seenAt: new Date(lastContact ? lastContact * 1000 : baseTimeMs).toISOString(),
    icao24,
    callsign: cleanString(asString(state[1])),
    originCountry: cleanString(asString(state[2])),
    lon,
    lat,
    altitudeM: optionalNumber(state[13]) ?? optionalNumber(state[7]),
    speedMps: optionalNumber(state[9]),
    headingDeg: optionalNumber(state[10]),
    verticalRateMps: optionalNumber(state[11]),
    onGround: typeof state[8] === "boolean" ? state[8] : undefined,
    squawk: cleanString(asString(state[14])),
    category: typeof state[17] === "number" ? `opensky:${state[17]}` : undefined,
    raw: state
  };
}

function mapReadsbAircraftResponse(
  payload: ReadsbAircraftResponse,
  context: { fetchedAt: string; sourcePriority: number; receiverId: string }
): RawFlightObservation[] {
  const baseTimeMs = epochLikeToMs(payload.now) ?? Date.now();
  return (payload.aircraft ?? [])
    .map((item): RawFlightObservation | undefined => {
      const icao24 = normalizeIcao24(item.hex);
      if (!icao24) {
        return undefined;
      }
      const seenSeconds = optionalNumber(item.seen);
      const seenAtMs = seenSeconds !== undefined ? baseTimeMs - seenSeconds * 1000 : baseTimeMs;
      const typeDesignator = cleanString(item.t)?.toUpperCase();
      return {
        sourceId: "local_adsb",
        sourceRecordId: `local_adsb:${context.receiverId}:${icao24}`,
        sourcePriority: context.sourcePriority,
        fetchedAt: context.fetchedAt,
        seenAt: new Date(seenAtMs).toISOString(),
        icao24,
        callsign: cleanString(item.flight),
        registration: cleanString(item.r),
        typeDesignator,
        lat: optionalNumber(item.lat),
        lon: optionalNumber(item.lon),
        altitudeM: altitudeToMeters(item.alt_baro ?? item.alt_geom),
        speedMps: knotsToMps(optionalNumber(item.gs)),
        headingDeg: optionalNumber(item.track) ?? optionalNumber(item.true_heading) ?? optionalNumber(item.mag_heading),
        verticalRateMps: feetPerMinuteToMps(optionalNumber(item.baro_rate) ?? optionalNumber(item.geom_rate)),
        onGround: item.alt_baro === "ground",
        squawk: cleanString(item.squawk),
        emergency: cleanString(item.emergency),
        category: cleanString(item.category ?? item.type),
        raw: item
      };
    })
    .filter((item): item is RawFlightObservation => Boolean(item));
}

function bboxToPointRadius(bbox: BoundingBox): { lat: number; lon: number; radiusNm: number } {
  const lat = (bbox.south + bbox.north) / 2;
  const lon = (bbox.west + bbox.east) / 2;
  const diagonalKm = haversineKm(bbox.south, bbox.west, bbox.north, bbox.east);
  return { lat, lon, radiusNm: Math.min(250, Math.max(1, diagonalKm / 2 / 1.852)) };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function isObservationInBbox(observation: RawFlightObservation, bbox: BoundingBox): boolean {
  return (
    typeof observation.lat === "number" &&
    typeof observation.lon === "number" &&
    observation.lon >= bbox.west &&
    observation.lon <= bbox.east &&
    observation.lat >= bbox.south &&
    observation.lat <= bbox.north
  );
}

function normalizeIcao24(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[0-9a-f]{6}$/.test(normalized) ? normalized : undefined;
}

function cleanString(value: string | undefined | null): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function altitudeToMeters(value: number | string | undefined | null): number | undefined {
  if (typeof value === "string") {
    return value.toLowerCase() === "ground" ? 0 : undefined;
  }
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 0.3048) : undefined;
}

function knotsToMps(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? round(value * 0.514444, 2) : undefined;
}

function feetPerMinuteToMps(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? round(value * 0.00508, 2) : undefined;
}

function epochLikeToMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function receiverLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.protocol.replace(":", "") || "receiver";
  } catch {
    return "receiver";
  }
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
