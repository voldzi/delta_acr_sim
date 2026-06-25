import type { SituationDataConfig } from "./config.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { BoundingBox, SituationDataLicense, SituationFeature } from "./types.js";

export const CHMI_WEATHER_WEBCAMS_SOURCE_ID = "chmi_weather_webcams" as const;
export const CHMI_WEATHER_WEBCAMS_LAYER_ID = "weather_webcams" as const;
export const CHMI_WEATHER_WEBCAMS_CONTRACT_VERSION = "sim-weather-cameras-v1" as const;

export const CHMI_WEBCAMS_LICENSE: SituationDataLicense = {
  name: "ČHMÚ webové kamery",
  url: "https://www.chmi.cz/namerena-data/webkamery",
  attribution: "Český hydrometeorologický ústav",
  commercialUse: "unknown",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Webcam imagery is fetched and cached server-side by SIM for COP preview only.",
    "Keep CHMI attribution visible in COP camera detail windows.",
    "Use as visual weather context only; webcam imagery is not an official warning or emergency instruction feed."
  ]
};

export interface ChmiWeatherWebcamCatalogQuery {
  bbox?: BoundingBox;
  limit?: number;
  includeRaw?: boolean;
}

export interface ChmiWeatherWebcamCatalogResponse {
  contractVersion: typeof CHMI_WEATHER_WEBCAMS_CONTRACT_VERSION;
  providerId: "sim.situation-data";
  sourceId: typeof CHMI_WEATHER_WEBCAMS_SOURCE_ID;
  generatedAt: string;
  updateCadenceSeconds: number;
  snapshotPolicy: {
    mode: "on_demand_detail_snapshot";
    imagePayloadInFeatureStream: false;
    detailEndpoint: "/api/v1/weather-cameras/{locationId}";
    snapshotEndpoint: "/api/v1/weather-cameras/{locationId}/snapshot";
  };
  locations: ChmiWeatherWebcamLocationSummary[];
  warnings: string[];
}

export interface ChmiWeatherWebcamLocationSummary {
  locationId: string;
  label: string;
  lon: number;
  lat: number;
  sourceDataUrl: string;
  detailUrl: string;
  snapshotUrl: string;
  providerPageUrl: string;
  camerasKnownAfterDetail: boolean;
}

export interface ChmiWeatherWebcamDetailResponse {
  contractVersion: typeof CHMI_WEATHER_WEBCAMS_CONTRACT_VERSION;
  providerId: "sim.situation-data";
  sourceId: typeof CHMI_WEATHER_WEBCAMS_SOURCE_ID;
  generatedAt: string;
  location: ChmiWeatherWebcamLocationSummary;
  cameras: ChmiWeatherWebcamCameraDetail[];
  warnings: string[];
}

export interface ChmiWeatherWebcamCameraDetail {
  cameraId: string;
  name: string;
  providerUrl?: string;
  snapshotUrl: string;
  contentType?: string;
}

export interface ChmiWeatherWebcamSnapshotAsset {
  locationId: string;
  cameraId: string;
  name: string;
  contentType: string;
  body: Buffer;
  cacheSeconds: number;
}

interface ChmiWebcamMapPayload {
  type?: string;
  features?: ChmiWebcamMapFeature[];
}

interface ChmiWebcamMapFeature {
  type?: string;
  geometry?: {
    type?: string;
    coordinates?: unknown[];
  };
  properties?: {
    dataUrl?: string;
    icon?: string;
  };
}

interface ChmiWebcamPointPayload {
  data?: ChmiWebcamPointItem[];
}

interface ChmiWebcamPointItem {
  name?: string;
  url?: string;
  img?: string;
}

interface ChmiWeatherWebcamLocation {
  locationId: string;
  lon: number;
  lat: number;
  sourceDataUrl: string;
  sourceIcon?: string;
}

interface ResolvedCamera {
  cameraId: string;
  name: string;
  providerUrl?: string;
  snapshotUrl: string;
  contentType?: string;
  imageBase64?: string;
}

interface ResolvedDetail {
  location: ChmiWeatherWebcamLocation;
  cameras: ResolvedCamera[];
}

export class ChmiWeatherWebcamCatalog {
  private readonly mapCache: ManagedResponseCache<ChmiWeatherWebcamLocation[]>;
  private readonly detailCache: ManagedResponseCache<ChmiWebcamPointPayload>;

  constructor(private readonly config: SituationDataConfig) {
    const ttlSeconds = Math.max(60, config.chmiWeatherWebcamsCacheTtlSeconds);
    this.mapCache = new ManagedResponseCache<ChmiWeatherWebcamLocation[]>({
      ttlMs: ttlSeconds * 1000,
      staleIfErrorMs: Math.max(ttlSeconds, config.staleIfErrorSeconds, 1800) * 1000,
      maxEntries: 1
    });
    this.detailCache = new ManagedResponseCache<ChmiWebcamPointPayload>({
      ttlMs: ttlSeconds * 1000,
      staleIfErrorMs: Math.max(ttlSeconds, config.staleIfErrorSeconds, 1800) * 1000,
      maxEntries: Math.max(64, Math.min(config.cacheMaxEntries, 512))
    });
  }

  cacheStats(): ManagedResponseCacheStats[] {
    return [this.mapCache.stats(), this.detailCache.stats()];
  }

  async listLocations(): Promise<ChmiWeatherWebcamLocationSummary[]> {
    const locations = await this.resolveLocations();
    return locations.map((location) => this.locationSummary(location));
  }

  async listCatalog(query: ChmiWeatherWebcamCatalogQuery = {}): Promise<ChmiWeatherWebcamCatalogResponse> {
    const generatedAt = new Date().toISOString();
    const locations = this.filterLocations(await this.resolveLocations(), query);
    return {
      contractVersion: CHMI_WEATHER_WEBCAMS_CONTRACT_VERSION,
      providerId: "sim.situation-data",
      sourceId: CHMI_WEATHER_WEBCAMS_SOURCE_ID,
      generatedAt,
      updateCadenceSeconds: this.config.chmiWeatherWebcamsCacheTtlSeconds,
      snapshotPolicy: {
        mode: "on_demand_detail_snapshot",
        imagePayloadInFeatureStream: false,
        detailEndpoint: "/api/v1/weather-cameras/{locationId}",
        snapshotEndpoint: "/api/v1/weather-cameras/{locationId}/snapshot"
      },
      locations: locations.map((location) => this.locationSummary(location)),
      warnings: locations.length === 0 ? ["chmi_weather_webcams returned no camera locations for the requested query."] : []
    };
  }

  async listFeatures(query: Required<Pick<ChmiWeatherWebcamCatalogQuery, "bbox" | "limit" | "includeRaw">>): Promise<{
    fetchedAt: string;
    features: SituationFeature[];
    warnings: string[];
  }> {
    const fetchedAt = new Date().toISOString();
    const locations = this.filterLocations(await this.resolveLocations(), query);
    return {
      fetchedAt,
      features: locations.map((location) => this.locationFeature(location, fetchedAt, query.includeRaw)),
      warnings: locations.length === 0 ? ["chmi_weather_webcams returned no camera locations in the requested bbox."] : []
    };
  }

  async getDetail(locationId: string): Promise<ChmiWeatherWebcamDetailResponse | undefined> {
    const resolved = await this.resolveDetail(locationId);
    if (!resolved) {
      return undefined;
    }
    const generatedAt = new Date().toISOString();
    return {
      contractVersion: CHMI_WEATHER_WEBCAMS_CONTRACT_VERSION,
      providerId: "sim.situation-data",
      sourceId: CHMI_WEATHER_WEBCAMS_SOURCE_ID,
      generatedAt,
      location: this.locationSummary(resolved.location),
      cameras: resolved.cameras.map(({ imageBase64: _imageBase64, ...camera }) => camera),
      warnings: resolved.cameras.length === 0 ? ["CHMI camera detail did not include any image records."] : []
    };
  }

  async snapshot(locationId: string, cameraId?: string): Promise<ChmiWeatherWebcamSnapshotAsset | undefined> {
    const resolved = await this.resolveDetail(locationId);
    if (!resolved) {
      return undefined;
    }
    const camera = cameraId ? resolved.cameras.find((item) => item.cameraId === cameraId) : resolved.cameras[0];
    if (!camera?.imageBase64) {
      return undefined;
    }
    const body = decodeBase64Image(camera.imageBase64);
    if (!body || body.length === 0) {
      return undefined;
    }
    return {
      locationId,
      cameraId: camera.cameraId,
      name: camera.name,
      contentType: camera.contentType ?? imageContentType(body),
      body,
      cacheSeconds: Math.max(60, this.config.chmiWeatherWebcamsCacheTtlSeconds)
    };
  }

  private async resolveLocations(): Promise<ChmiWeatherWebcamLocation[]> {
    return this.mapCache.getOrLoad(this.config.chmiWeatherWebcamsMapUrl, async () => {
      const payload = await requestJson<ChmiWebcamMapPayload>(this.config.chmiWeatherWebcamsMapUrl, this.config.requestTimeoutMs);
      return normalizeLocations(payload, this.config);
    });
  }

  private async resolveDetail(locationId: string): Promise<ResolvedDetail | undefined> {
    const location = (await this.resolveLocations()).find((item) => item.locationId === locationId);
    if (!location) {
      return undefined;
    }
    const payload = await this.detailCache.getOrLoad(location.sourceDataUrl, () =>
      requestJson<ChmiWebcamPointPayload>(location.sourceDataUrl, this.config.requestTimeoutMs)
    );
    return {
      location,
      cameras: this.resolveCameras(location, payload)
    };
  }

  private resolveCameras(location: ChmiWeatherWebcamLocation, payload: ChmiWebcamPointPayload): ResolvedCamera[] {
    const usedIds = new Map<string, number>();
    return (payload.data ?? []).map((item, index) => {
      const baseId = stableId(lastPathSegment(item.url) ?? item.name ?? `camera-${index + 1}`);
      const count = usedIds.get(baseId) ?? 0;
      usedIds.set(baseId, count + 1);
      const cameraId = count === 0 ? baseId : `${baseId}-${count + 1}`;
      const image = typeof item.img === "string" ? item.img : undefined;
      return {
        cameraId,
        name: item.name?.trim() || `ČHMÚ webkamera ${index + 1}`,
        providerUrl: item.url ? absoluteUrl(item.url, this.config.chmiWeatherWebcamsPublicBaseUrl) : undefined,
        snapshotUrl: this.snapshotUrl(location.locationId, cameraId),
        contentType: image ? imageContentType(decodeBase64Image(image)) : undefined,
        imageBase64: image
      };
    });
  }

  private filterLocations(locations: ChmiWeatherWebcamLocation[], query: ChmiWeatherWebcamCatalogQuery): ChmiWeatherWebcamLocation[] {
    return locations
      .filter((location) => !query.bbox || bboxContainsPoint(query.bbox, location.lon, location.lat))
      .slice(0, Math.max(1, Math.min(query.limit ?? 250, 1000)));
  }

  private locationFeature(location: ChmiWeatherWebcamLocation, fetchedAt: string, includeRaw: boolean): SituationFeature {
    const summary = this.locationSummary(location);
    const validUntil = addSecondsIso(fetchedAt, Math.max(600, this.config.chmiWeatherWebcamsCacheTtlSeconds * 2));
    return stripRawIfNeeded(
      {
        type: "Feature",
        id: `weather_webcam:${location.locationId}`,
        geometry: {
          type: "Point",
          coordinates: [round(location.lon, 6), round(location.lat, 6)]
        },
        properties: {
          featureId: `weather_webcam:${location.locationId}`,
          layer: CHMI_WEATHER_WEBCAMS_LAYER_ID,
          category: "weather_webcam",
          label: summary.label,
          labelLocalized: {
            cs: "ČHMÚ webkamera",
            en: "CHMI webcam"
          },
          sourceId: CHMI_WEATHER_WEBCAMS_SOURCE_ID,
          source: CHMI_WEATHER_WEBCAMS_SOURCE_ID,
          sourceName: "ČHMÚ webkamery",
          observedAt: fetchedAt,
          validUntil,
          updatedAt: fetchedAt,
          confidence: 0.72,
          stale: false,
          severity: "info",
          license: {
            name: CHMI_WEBCAMS_LICENSE.name,
            attribution: CHMI_WEBCAMS_LICENSE.attribution,
            url: CHMI_WEBCAMS_LICENSE.url
          },
          metrics: {
            updateCadenceSeconds: this.config.chmiWeatherWebcamsCacheTtlSeconds,
            lon: round(location.lon, 6),
            lat: round(location.lat, 6)
          },
          tags: compactTags({
            sourceSystem: CHMI_WEATHER_WEBCAMS_SOURCE_ID,
            renderAs: "point_with_detail_snapshot",
            snapshotMode: "on_demand",
            imagePayloadInFeatureStream: "false",
            warningSignal: "false"
          }),
          rendering: {
            mode: "feature",
            geometryRole: "feature_geometry"
          },
          basis: [
            "ČHMÚ public webcam map lists high-resolution weather cameras and states that images are refreshed every 5-10 minutes.",
            "SIM fetches camera snapshots only on detail demand and keeps a short server-side cache."
          ],
          summary: "Bod webkamery pro vizuální kontrolu aktuálního počasí; náhled se načítá až v detailu.",
          summaryLocalized: {
            cs: "Bod webkamery pro vizuální kontrolu aktuálního počasí.",
            en: "Webcam point for visual current-weather context."
          },
          notices: [
            "COP should open a custom camera preview window on click and load the snapshot through SIM.",
            "Do not use webcam imagery as an automated warning or alert source.",
            "The feature stream intentionally does not contain the base64 image payload."
          ],
          styleHint: "weather-webcam-point-v1",
          iconHint: "camera",
          sourceRevision: location.sourceDataUrl,
          readModel: true,
          generatedAt: fetchedAt,
          providerProperties: compactProviderProperties({
            camera: {
              locationId: location.locationId,
              detailUrl: summary.detailUrl,
              snapshotUrl: summary.snapshotUrl,
              sourceDataUrl: summary.sourceDataUrl,
              providerPageUrl: summary.providerPageUrl,
              camerasKnownAfterDetail: true,
              contentMode: "on_demand_snapshot",
              imagePayloadInFeatureStream: false,
              updateCadenceSeconds: this.config.chmiWeatherWebcamsCacheTtlSeconds
            },
            copPresentation: {
              onClick: "open_custom_camera_preview",
              previewEndpoint: summary.detailUrl,
              primaryImageEndpoint: summary.snapshotUrl,
              attributionRequired: CHMI_WEBCAMS_LICENSE.attribution
            }
          }),
          disclaimer: "Webkamera je pouze vizuální situační kontext; nenahrazuje oficiální výstrahy ČHMÚ ani pokyny krizových orgánů.",
          raw: includeRaw ? { location } : undefined
        }
      },
      includeRaw
    );
  }

  private locationSummary(location: ChmiWeatherWebcamLocation): ChmiWeatherWebcamLocationSummary {
    return {
      locationId: location.locationId,
      label: `ČHMÚ webkamera ${round(location.lat, 5)}, ${round(location.lon, 5)}`,
      lon: round(location.lon, 6),
      lat: round(location.lat, 6),
      sourceDataUrl: location.sourceDataUrl,
      detailUrl: `/api/v1/weather-cameras/${encodeURIComponent(location.locationId)}`,
      snapshotUrl: this.snapshotUrl(location.locationId),
      providerPageUrl: absoluteUrl("/namerena-data/webkamery", this.config.chmiWeatherWebcamsPublicBaseUrl),
      camerasKnownAfterDetail: true
    };
  }

  private snapshotUrl(locationId: string, cameraId?: string): string {
    const path = `/api/v1/weather-cameras/${encodeURIComponent(locationId)}/snapshot`;
    return cameraId ? `${path}?cameraId=${encodeURIComponent(cameraId)}` : path;
  }
}

function normalizeLocations(payload: ChmiWebcamMapPayload, config: SituationDataConfig): ChmiWeatherWebcamLocation[] {
  const locations = new Map<string, ChmiWeatherWebcamLocation>();
  for (const feature of payload.features ?? []) {
    const sourceDataUrl = feature.properties?.dataUrl;
    if (!sourceDataUrl) {
      continue;
    }
    const absoluteDataUrl = absoluteUrl(sourceDataUrl, config.chmiWeatherWebcamsDataBaseUrl);
    const lonLat = lonLatFromDataUrl(absoluteDataUrl);
    if (!lonLat) {
      continue;
    }
    const locationId = locationIdFor(lonLat.lon, lonLat.lat);
    if (!locations.has(locationId)) {
      locations.set(locationId, {
        locationId,
        lon: lonLat.lon,
        lat: lonLat.lat,
        sourceDataUrl: absoluteDataUrl,
        sourceIcon: feature.properties?.icon
      });
    }
  }
  return [...locations.values()].sort((a, b) => a.locationId.localeCompare(b.locationId));
}

function lonLatFromDataUrl(value: string): { lon: number; lat: number } | undefined {
  try {
    const url = new URL(value);
    const lon = Number(url.searchParams.get("x"));
    const lat = Number(url.searchParams.get("y"));
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      return undefined;
    }
    return { lon, lat };
  } catch {
    return undefined;
  }
}

function locationIdFor(lon: number, lat: number): string {
  return `wgs84_${coordinateToken(lon)}_${coordinateToken(lat)}`;
}

function coordinateToken(value: number): string {
  return value.toFixed(6).replace("-", "m").replace(".", "p");
}

function lastPathSegment(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const path = value.split("?")[0]?.split("#")[0] ?? value;
  return path.split("/").filter(Boolean).pop();
}

function absoluteUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function stableId(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:-]/g, "_").replace(/_+/g, "_").slice(0, 96);
  return normalized.length > 0 ? normalized : "camera";
}

function decodeBase64Image(value: string | undefined): Buffer {
  if (!value) {
    return Buffer.alloc(0);
  }
  const raw = value.includes(",") ? value.split(",").pop() ?? "" : value;
  return Buffer.from(raw.trim(), "base64");
}

function imageContentType(body: Buffer): string {
  if (body.length >= 6 && body.toString("ascii", 0, 3) === "GIF") {
    return "image/gif";
  }
  if (body.length >= 8 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) {
    return "image/png";
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return "image/jpeg";
  }
  return "application/octet-stream";
}

function bboxContainsPoint(bbox: BoundingBox, lon: number, lat: number): boolean {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function addSecondsIso(value: string, seconds: number): string | undefined {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return new Date(timestamp + seconds * 1000).toISOString();
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function compactTags(values: Record<string, string | undefined>): Record<string, string> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactProviderProperties(values: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(values).filter(([, value]) => {
    if (value === undefined || value === null) {
      return false;
    }
    if (typeof value === "string") {
      return value.length > 0;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return true;
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stripRawIfNeeded(feature: SituationFeature, includeRaw: boolean): SituationFeature {
  if (includeRaw) {
    return feature;
  }
  if (!("raw" in feature.properties)) {
    return feature;
  }
  const { raw: _raw, ...properties } = feature.properties;
  return { ...feature, properties };
}

async function requestJson<T>(url: string, timeoutMs: number): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json,*/*",
      "user-agent": "csm-sim-situation-data/0.1"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return (await response.json()) as T;
}
