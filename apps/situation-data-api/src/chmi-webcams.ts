import { readFile } from "node:fs/promises";
import { isIP } from "node:net";

import type { SituationDataConfig } from "./config.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { BoundingBox, SituationDataLicense, SituationFeature, SituationLayerId } from "./types.js";

export const CHMI_WEATHER_WEBCAMS_SOURCE_ID = "chmi_weather_webcams" as const;
export const CHMI_WEATHER_WEBCAMS_LAYER_ID = "weather_webcams" as const;
export const OUTDOOR_WEBCAMS_LAYER_ID = "outdoor_webcams" as const;
export const CHMI_WEATHER_WEBCAMS_CONTRACT_VERSION = "sim-weather-cameras-v1" as const;

type CameraSnapshotAvailability = "direct" | "embedded" | "origin_page_discovery" | "unavailable";

export const CHMI_WEBCAMS_LICENSE: SituationDataLicense = {
  name: "Veřejné webové kamery přes SIM",
  url: "https://www.chmi.cz/namerena-data/webkamery",
  attribution: "Český hydrometeorologický ústav; Státní plavební správa; Statutární město Ostrava",
  commercialUse: "unknown",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Webcam imagery is fetched from original public source systems and cached server-side by SIM for COP preview only.",
    "Keep the per-camera origin attribution visible in COP camera detail windows.",
    "Use as visual weather context only; webcam imagery is not an official warning or emergency instruction feed."
  ]
};

export interface ChmiWeatherWebcamCatalogQuery {
  bbox?: BoundingBox;
  limit?: number;
  includeRaw?: boolean;
  layers?: SituationLayerId[];
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
  originSourceId?: string;
  originSourceName?: string;
  originAuthority?: string;
  originCategory?: string;
  attribution?: string;
  snapshotAvailable?: boolean;
  snapshotAvailability?: CameraSnapshotAvailability;
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
  snapshotAvailable?: boolean;
  snapshotAvailability?: CameraSnapshotAvailability;
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
  label: string;
  lon: number;
  lat: number;
  sourceDataUrl: string;
  sourceIcon?: string;
  sourceId: string;
  sourceName: string;
  sourceNameEn?: string;
  authority: string;
  attribution: string;
  providerPageUrl: string;
  category: string;
  detailMode: "chmi_point" | "inline_cameras";
  cameras?: ResolvedCamera[];
}

interface ResolvedCamera {
  cameraId: string;
  name: string;
  providerUrl?: string;
  snapshotUrl: string;
  contentType?: string;
  imageBase64?: string;
  directImageUrl?: string;
  originSnapshotDiscovery?: boolean;
  snapshotAvailable?: boolean;
}

interface ResolvedDetail {
  location: ChmiWeatherWebcamLocation;
  cameras: ResolvedCamera[];
}

interface DirectSnapshotCacheEntry {
  bodyBase64: string;
  contentType: string;
}

interface OriginSnapshotDiscoveryEntry {
  directImageUrl?: string;
  bodyBase64?: string;
  contentType?: string;
  unavailableReason?: string;
}

interface PublicCameraFeedConfig {
  sourceId: string;
  label: string;
  category: string;
  authority: string;
  providerPageUrl: string;
  kind: "arcgis_lavdis" | "arcgis_ostrava" | "ostrava_asmx" | "static_json";
  url: string;
}

interface StaticCameraFeedPayload {
  sourceId?: string;
  label?: string;
  authority?: string;
  attribution?: string;
  providerPageUrl?: string;
  category?: string;
  locations?: StaticCameraFeedLocation[];
}

interface StaticCameraFeedLocation {
  locationId?: string;
  label?: string;
  lon?: number;
  lat?: number;
  sourceDataUrl?: string;
  providerPageUrl?: string;
  authority?: string;
  attribution?: string;
  category?: string;
  cameras?: StaticCameraFeedCamera[];
}

interface StaticCameraFeedCamera {
  cameraId?: string;
  name?: string;
  providerUrl?: string;
  directImageUrl?: string;
  contentType?: string;
  snapshotAvailable?: boolean;
}

interface ArcgisCameraFeatureCollection {
  features?: ArcgisCameraFeature[];
}

interface ArcgisCameraFeature {
  id?: string | number;
  geometry?: {
    type?: string;
    coordinates?: unknown[];
  };
  properties?: Record<string, unknown>;
}

interface OstravaAsmxCameraPayload {
  d?: {
    Points?: OstravaAsmxCameraPoint[];
  };
}

interface OstravaAsmxCameraPoint {
  ID?: string;
  Title?: string;
  Latitude?: number;
  Longitude?: number;
  Content?: string;
}

export class ChmiWeatherWebcamCatalog {
  private readonly mapCache: ManagedResponseCache<ChmiWeatherWebcamLocation[]>;
  private readonly detailCache: ManagedResponseCache<ChmiWebcamPointPayload>;
  private readonly directSnapshotCache: ManagedResponseCache<DirectSnapshotCacheEntry>;
  private readonly originSnapshotDiscoveryCache: ManagedResponseCache<OriginSnapshotDiscoveryEntry>;
  private lastLocationWarnings: string[] = [];

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
    this.directSnapshotCache = new ManagedResponseCache<DirectSnapshotCacheEntry>({
      ttlMs: ttlSeconds * 1000,
      staleIfErrorMs: Math.max(ttlSeconds, config.staleIfErrorSeconds, 1800) * 1000,
      maxEntries: Math.max(64, Math.min(config.cacheMaxEntries, 256))
    });
    this.originSnapshotDiscoveryCache = new ManagedResponseCache<OriginSnapshotDiscoveryEntry>({
      ttlMs: ttlSeconds * 1000,
      staleIfErrorMs: Math.max(ttlSeconds, config.staleIfErrorSeconds, 1800) * 1000,
      maxEntries: Math.max(64, Math.min(config.cacheMaxEntries, 256))
    });
  }

  cacheStats(): ManagedResponseCacheStats[] {
    return [this.mapCache.stats(), this.detailCache.stats(), this.directSnapshotCache.stats(), this.originSnapshotDiscoveryCache.stats()];
  }

  async listLocations(): Promise<ChmiWeatherWebcamLocationSummary[]> {
    const locations = await this.resolveLocations();
    return locations.map((location) => this.locationSummary(location));
  }

  locationWarnings(): string[] {
    return [...this.lastLocationWarnings];
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
      warnings: [
        ...this.lastLocationWarnings,
        ...(locations.length === 0 ? ["chmi_weather_webcams returned no camera locations for the requested query."] : [])
      ]
    };
  }

  async listFeatures(
    query: Required<Pick<ChmiWeatherWebcamCatalogQuery, "bbox" | "limit" | "includeRaw">> & Pick<ChmiWeatherWebcamCatalogQuery, "layers">
  ): Promise<{
    fetchedAt: string;
    features: SituationFeature[];
    warnings: string[];
  }> {
    const fetchedAt = new Date().toISOString();
    const locations = this.filterLocationsByLayers(this.filterLocations(await this.resolveLocations(), query), query.layers);
    return {
      fetchedAt,
      features: locations.map((location) => this.locationFeature(location, fetchedAt, query.includeRaw, layerForCameraLocation(location))),
      warnings: [...this.lastLocationWarnings, ...(locations.length === 0 ? ["chmi_weather_webcams returned no camera locations in the requested bbox."] : [])]
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
      cameras: resolved.cameras.map((camera) => this.cameraDetail(resolved.location, camera)),
      warnings: resolved.cameras.length === 0 ? [`${resolved.location.sourceName} camera detail did not include any image records.`] : []
    };
  }

  async snapshot(locationId: string, cameraId?: string): Promise<ChmiWeatherWebcamSnapshotAsset | undefined> {
    const resolved = await this.resolveDetail(locationId);
    if (!resolved) {
      return undefined;
    }
    const camera = cameraId ? resolved.cameras.find((item) => item.cameraId === cameraId) : resolved.cameras[0];
    if (!camera?.imageBase64) {
      if (!camera?.directImageUrl) {
        if (!camera?.originSnapshotDiscovery) {
          return undefined;
        }
        if (!camera?.providerUrl) {
          return undefined;
        }
        const discovered = await this.originSnapshotDiscoveryCache.getOrLoad(camera.providerUrl, () =>
          discoverOriginSnapshot(camera.providerUrl as string, this.config.requestTimeoutMs)
        );
        if (!discovered.bodyBase64 || !discovered.contentType) {
          return undefined;
        }
        return {
          locationId,
          cameraId: camera.cameraId,
          name: camera.name,
          contentType: discovered.contentType,
          body: Buffer.from(discovered.bodyBase64, "base64"),
          cacheSeconds: Math.max(60, this.config.chmiWeatherWebcamsCacheTtlSeconds)
        };
      }
      if (!camera.directImageUrl) {
        return undefined;
      }
      const directImageUrl = camera.directImageUrl;
      const direct = await this.directSnapshotCache.getOrLoad(directImageUrl, () => requestImage(directImageUrl, this.config.requestTimeoutMs));
      return {
        locationId,
        cameraId: camera.cameraId,
        name: camera.name,
        contentType: direct.contentType,
        body: Buffer.from(direct.bodyBase64, "base64"),
        cacheSeconds: Math.max(60, this.config.chmiWeatherWebcamsCacheTtlSeconds)
      };
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
    return this.mapCache.getOrLoad("public-weather-webcam-locations-v2", async () => {
      const configuredFeeds = parsePublicCameraFeeds(this.config.publicCameraFeeds);
      const tasks = [
        { label: "ČHMÚ webkamery", load: () => this.loadChmiLocations() },
        ...configuredFeeds.map((feed) => ({ label: feed.label, load: () => this.loadPublicCameraFeed(feed) }))
      ];
      const loaded = await Promise.allSettled(tasks.map((task) => task.load()));
      const warnings = loaded.flatMap((result, index) =>
        result.status === "rejected"
          ? [`${tasks[index]?.label ?? "public camera feed"} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
          : []
      );
      const locations = loaded
        .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
        .sort((a, b) => a.locationId.localeCompare(b.locationId));
      this.lastLocationWarnings = warnings;
      if (locations.length === 0 && warnings.length > 0) {
        throw new Error(warnings.join("; "));
      }
      return locations;
    });
  }

  private async resolveDetail(locationId: string): Promise<ResolvedDetail | undefined> {
    const location = (await this.resolveLocations()).find((item) => item.locationId === locationId);
    if (!location) {
      return undefined;
    }
    if (location.detailMode === "inline_cameras") {
      return {
        location,
        cameras: location.cameras ?? []
      };
    }
    const payload = await this.detailCache.getOrLoad(location.sourceDataUrl, () =>
      requestJson<ChmiWebcamPointPayload>(location.sourceDataUrl, this.config.requestTimeoutMs)
    );
    return {
      location,
      cameras: this.resolveCameras(location, payload)
    };
  }

  private async loadChmiLocations(): Promise<ChmiWeatherWebcamLocation[]> {
    const payload = await requestJson<ChmiWebcamMapPayload>(this.config.chmiWeatherWebcamsMapUrl, this.config.requestTimeoutMs);
    return normalizeChmiLocations(payload, this.config);
  }

  private async loadPublicCameraFeed(feed: PublicCameraFeedConfig): Promise<ChmiWeatherWebcamLocation[]> {
    if (feed.kind === "arcgis_lavdis") {
      const payload = await requestJson<ArcgisCameraFeatureCollection>(feed.url, this.config.requestTimeoutMs);
      return normalizeLavdisArcgisLocations(payload, feed);
    }
    if (feed.kind === "arcgis_ostrava") {
      const payload = await requestJson<ArcgisCameraFeatureCollection>(feed.url, this.config.requestTimeoutMs);
      return normalizeOstravaArcgisLocations(payload, feed);
    }
    if (feed.kind === "static_json") {
      const payload = await requestStaticCameraJson(feed.url, this.config.requestTimeoutMs);
      return normalizeStaticCameraLocations(payload, feed);
    }
    const payload = await requestJsonPost<OstravaAsmxCameraPayload>(feed.url, this.config.requestTimeoutMs);
    return normalizeOstravaAsmxLocations(payload, feed);
  }

  private cameraDetail(location: ChmiWeatherWebcamLocation, camera: ResolvedCamera): ChmiWeatherWebcamCameraDetail {
    return {
      cameraId: camera.cameraId,
      name: camera.name,
      providerUrl: camera.providerUrl,
      snapshotUrl: this.snapshotUrl(location.locationId, camera.cameraId),
      contentType: camera.contentType,
      snapshotAvailable: cameraSnapshotAvailable(camera),
      snapshotAvailability: cameraSnapshotAvailability(camera)
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
        imageBase64: image,
        snapshotAvailable: Boolean(image)
      };
    });
  }

  private filterLocations(locations: ChmiWeatherWebcamLocation[], query: ChmiWeatherWebcamCatalogQuery): ChmiWeatherWebcamLocation[] {
    return locations
      .filter((location) => !query.bbox || bboxContainsPoint(query.bbox, location.lon, location.lat))
      .slice(0, Math.max(1, Math.min(query.limit ?? 250, 1000)));
  }

  private filterLocationsByLayers(locations: ChmiWeatherWebcamLocation[], layers: SituationLayerId[] | undefined): ChmiWeatherWebcamLocation[] {
    const requestedLayers = new Set(layers ?? [CHMI_WEATHER_WEBCAMS_LAYER_ID]);
    return locations.filter((location) => requestedLayers.has(layerForCameraLocation(location)));
  }

  private locationFeature(location: ChmiWeatherWebcamLocation, fetchedAt: string, includeRaw: boolean, layerId: SituationLayerId): SituationFeature {
    const summary = this.locationSummary(location);
    const validUntil = addSecondsIso(fetchedAt, Math.max(600, this.config.chmiWeatherWebcamsCacheTtlSeconds * 2));
    const isOutdoorWebcam = layerId === OUTDOOR_WEBCAMS_LAYER_ID;
    return stripRawIfNeeded(
      {
        type: "Feature",
        id: `${isOutdoorWebcam ? "outdoor_webcam" : "weather_webcam"}:${location.locationId}`,
        geometry: {
          type: "Point",
          coordinates: [round(location.lon, 6), round(location.lat, 6)]
        },
        properties: {
          featureId: `${isOutdoorWebcam ? "outdoor_webcam" : "weather_webcam"}:${location.locationId}`,
          layer: layerId,
          category: isOutdoorWebcam ? "outdoor_webcam" : "weather_webcam",
          label: summary.label,
          labelLocalized: {
            cs: summary.label,
            en: location.sourceNameEn ?? summary.label
          },
          sourceId: CHMI_WEATHER_WEBCAMS_SOURCE_ID,
          source: CHMI_WEATHER_WEBCAMS_SOURCE_ID,
          sourceName: location.sourceName,
          observedAt: fetchedAt,
          validUntil,
          updatedAt: fetchedAt,
          confidence: 0.72,
          stale: false,
          severity: "info",
          license: {
            name: CHMI_WEBCAMS_LICENSE.name,
            attribution: location.attribution,
            url: location.providerPageUrl
          },
          metrics: {
            updateCadenceSeconds: this.config.chmiWeatherWebcamsCacheTtlSeconds,
            lon: round(location.lon, 6),
            lat: round(location.lat, 6)
          },
          tags: compactTags({
            sourceSystem: CHMI_WEATHER_WEBCAMS_SOURCE_ID,
            originSourceSystem: location.sourceId,
            originCategory: location.category,
            presentationGroup: isOutdoorWebcam ? "outdoor" : "weather",
            renderAs: "point_with_detail_snapshot",
            snapshotMode: "on_demand",
            snapshotAvailability: summary.snapshotAvailability,
            imagePayloadInFeatureStream: "false",
            warningSignal: "false"
          }),
          rendering: {
            mode: "feature",
            geometryRole: "feature_geometry"
          },
          basis: [
            `${location.sourceName} lists public camera locations for visual situational context.`,
            "SIM fetches camera snapshots only on detail demand and keeps a short server-side cache."
          ],
          summary: isOutdoorWebcam
            ? "Bod turistické webkamery s ověřeným originálním provozovatelem; náhled je dostupný jen pokud jej originální zdroj poskytuje přes SIM."
            : "Bod veřejné webkamery pro vizuální kontrolu aktuální situace; náhled se načítá až v detailu.",
          summaryLocalized: {
            cs: isOutdoorWebcam ? "Turistická webkamera z ověřeného originálního zdroje." : "Bod veřejné webkamery pro vizuální kontrolu aktuální situace.",
            en: isOutdoorWebcam ? "Outdoor webcam from a verified origin source." : "Public webcam point for visual current-situation context."
          },
          notices: [
            "COP should open a custom camera preview window on click and load the snapshot through SIM.",
            "Do not use webcam imagery as an automated warning or alert source.",
            "The feature stream intentionally does not contain the base64 image payload."
          ],
          styleHint: isOutdoorWebcam ? "outdoor-webcam-point-v1" : "weather-webcam-point-v1",
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
              originSourceId: location.sourceId,
              originSourceName: location.sourceName,
              originAuthority: location.authority,
              originCategory: location.category,
              presentationGroup: isOutdoorWebcam ? "outdoor" : "weather",
              attribution: location.attribution,
              snapshotAvailable: summary.snapshotAvailable,
              snapshotAvailability: summary.snapshotAvailability,
              snapshotDiscoveryMode: summary.snapshotAvailability === "origin_page_discovery" ? "origin_page_html_candidates" : undefined,
              camerasKnownAfterDetail: true,
              contentMode: "on_demand_snapshot",
              imagePayloadInFeatureStream: false,
              updateCadenceSeconds: this.config.chmiWeatherWebcamsCacheTtlSeconds
            },
            copPresentation: {
              onClick: "open_custom_camera_preview",
              previewEndpoint: summary.detailUrl,
              primaryImageEndpoint: summary.snapshotUrl,
              attributionRequired: location.attribution
            }
          }),
          disclaimer: "Webkamera je pouze vizuální situační kontext; nenahrazuje oficiální výstrahy ani pokyny krizových orgánů.",
          raw: includeRaw ? { location } : undefined
        }
      },
      includeRaw
    );
  }

  private locationSummary(location: ChmiWeatherWebcamLocation): ChmiWeatherWebcamLocationSummary {
    return {
      locationId: location.locationId,
      label: location.label,
      lon: round(location.lon, 6),
      lat: round(location.lat, 6),
      sourceDataUrl: location.sourceDataUrl,
      detailUrl: `/api/v1/weather-cameras/${encodeURIComponent(location.locationId)}`,
      snapshotUrl: this.snapshotUrl(location.locationId),
      providerPageUrl: location.providerPageUrl,
      camerasKnownAfterDetail: true,
      originSourceId: location.sourceId,
      originSourceName: location.sourceName,
      originAuthority: location.authority,
      originCategory: location.category,
      attribution: location.attribution,
      snapshotAvailable: locationSnapshotAvailable(location),
      snapshotAvailability: locationSnapshotAvailability(location)
    };
  }

  private snapshotUrl(locationId: string, cameraId?: string): string {
    const path = `/api/v1/weather-cameras/${encodeURIComponent(locationId)}/snapshot`;
    return cameraId ? `${path}?cameraId=${encodeURIComponent(cameraId)}` : path;
  }
}

function normalizeChmiLocations(payload: ChmiWebcamMapPayload, config: SituationDataConfig): ChmiWeatherWebcamLocation[] {
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
        label: `ČHMÚ webkamera ${round(lonLat.lat, 5)}, ${round(lonLat.lon, 5)}`,
        lon: lonLat.lon,
        lat: lonLat.lat,
        sourceDataUrl: absoluteDataUrl,
        sourceIcon: feature.properties?.icon,
        sourceId: "chmi_webcams",
        sourceName: "ČHMÚ webkamery",
        sourceNameEn: "CHMI webcams",
        authority: "Český hydrometeorologický ústav",
        attribution: "Český hydrometeorologický ústav",
        providerPageUrl: absoluteUrl("/namerena-data/webkamery", config.chmiWeatherWebcamsPublicBaseUrl),
        category: "weather",
        detailMode: "chmi_point"
      });
    }
  }
  return [...locations.values()].sort((a, b) => a.locationId.localeCompare(b.locationId));
}

function normalizeLavdisArcgisLocations(payload: ArcgisCameraFeatureCollection, feed: PublicCameraFeedConfig): ChmiWeatherWebcamLocation[] {
  const locations = new Map<string, ChmiWeatherWebcamLocation>();
  for (const feature of payload.features ?? []) {
    const lonLat = lonLatFromArcgisFeature(feature);
    const directImageUrl = stringProperty(feature.properties, "kamera_link");
    if (!lonLat || !directImageUrl) {
      continue;
    }
    const locationName = stringProperty(feature.properties, "nazev_lok") ?? `LAVDIS kamera ${round(lonLat.lat, 5)}, ${round(lonLat.lon, 5)}`;
    const cameraName = stringProperty(feature.properties, "nazev_kam") ?? "kamera";
    const locationId = `${stableId(feed.sourceId)}_${stableId(locationName)}_${coordinateToken(lonLat.lon)}_${coordinateToken(lonLat.lat)}`.slice(0, 160);
    const location =
      locations.get(locationId) ??
      ({
        locationId,
        label: locationName,
        lon: lonLat.lon,
        lat: lonLat.lat,
        sourceDataUrl: feed.url,
        sourceId: feed.sourceId,
        sourceName: feed.label,
        sourceNameEn: feed.label,
        authority: feed.authority,
        attribution: feed.authority,
        providerPageUrl: feed.providerPageUrl,
        category: feed.category,
        detailMode: "inline_cameras",
        cameras: []
      } satisfies ChmiWeatherWebcamLocation);
    location.cameras?.push({
      cameraId: stableCameraId([feed.sourceId, feature.id, cameraName, directImageUrl]),
      name: `${locationName} ${cameraName}`.trim(),
      providerUrl: directImageUrl,
      snapshotUrl: "",
      directImageUrl,
      snapshotAvailable: true
    });
    locations.set(locationId, location);
  }
  return [...locations.values()].sort((a, b) => a.locationId.localeCompare(b.locationId));
}

function normalizeOstravaArcgisLocations(payload: ArcgisCameraFeatureCollection, feed: PublicCameraFeedConfig): ChmiWeatherWebcamLocation[] {
  return (payload.features ?? [])
    .map((feature): ChmiWeatherWebcamLocation | undefined => {
      const lonLat = lonLatFromArcgisFeature(feature);
      if (!lonLat) {
        return undefined;
      }
      const objectId = stringProperty(feature.properties, "OBJECTID") ?? String(feature.id ?? `${lonLat.lon},${lonLat.lat}`);
      const cameras = [
        ostravaArcgisCamera(feed, objectId, stringProperty(feature.properties, "kamera1"), stringProperty(feature.properties, "smer1")),
        ostravaArcgisCamera(feed, objectId, stringProperty(feature.properties, "kamera2"), stringProperty(feature.properties, "smer2"))
      ].filter((camera): camera is ResolvedCamera => Boolean(camera));
      if (cameras.length === 0) {
        return undefined;
      }
      const label = `Ostrava dopravní kamera ${objectId}`;
      return {
        locationId: `${stableId(feed.sourceId)}_${stableId(objectId)}_${coordinateToken(lonLat.lon)}_${coordinateToken(lonLat.lat)}`.slice(0, 160),
        label,
        lon: lonLat.lon,
        lat: lonLat.lat,
        sourceDataUrl: feed.url,
        sourceId: feed.sourceId,
        sourceName: feed.label,
        sourceNameEn: "Ostrava traffic cameras",
        authority: feed.authority,
        attribution: feed.authority,
        providerPageUrl: feed.providerPageUrl,
        category: feed.category,
        detailMode: "inline_cameras",
        cameras
      };
    })
    .filter((item): item is ChmiWeatherWebcamLocation => Boolean(item))
    .sort((a, b) => a.locationId.localeCompare(b.locationId));
}

function normalizeOstravaAsmxLocations(payload: OstravaAsmxCameraPayload, feed: PublicCameraFeedConfig): ChmiWeatherWebcamLocation[] {
  return (payload.d?.Points ?? [])
    .map((point): ChmiWeatherWebcamLocation | undefined => {
      const lon = point.Longitude;
      const lat = point.Latitude;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        return undefined;
      }
      const title = plainText(point.Title) || ostravaTitleFromContent(point.Content) || `Ostrava kamera ${point.ID ?? ""}`.trim();
      const cameras = ostravaCamerasFromContent(feed, point.Content ?? "");
      if (cameras.length === 0) {
        return undefined;
      }
      return {
        locationId: `${stableId(feed.sourceId)}_${stableId(point.ID ?? title)}_${coordinateToken(lon as number)}_${coordinateToken(lat as number)}`.slice(
          0,
          160
        ),
        label: title,
        lon: lon as number,
        lat: lat as number,
        sourceDataUrl: feed.url,
        sourceId: feed.sourceId,
        sourceName: feed.label,
        sourceNameEn: "Ostrava traffic cameras",
        authority: feed.authority,
        attribution: feed.authority,
        providerPageUrl: feed.providerPageUrl,
        category: feed.category,
        detailMode: "inline_cameras",
        cameras
      };
    })
    .filter((item): item is ChmiWeatherWebcamLocation => Boolean(item))
    .sort((a, b) => a.locationId.localeCompare(b.locationId));
}

function normalizeStaticCameraLocations(payload: StaticCameraFeedPayload, feed: PublicCameraFeedConfig): ChmiWeatherWebcamLocation[] {
  const sourceId = stableId(payload.sourceId ?? feed.sourceId).toLowerCase();
  const sourceName = payload.label?.trim() || feed.label;
  const authority = payload.authority?.trim() || feed.authority;
  const attribution = payload.attribution?.trim() || authority;
  const providerPageUrl = validUrl(payload.providerPageUrl) ?? feed.providerPageUrl;
  const category = stableId(payload.category ?? feed.category).toLowerCase();
  return (payload.locations ?? [])
    .map((location, locationIndex): ChmiWeatherWebcamLocation | undefined => {
      if (!Number.isFinite(location.lon) || !Number.isFinite(location.lat)) {
        return undefined;
      }
      const lon = location.lon as number;
      const lat = location.lat as number;
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        return undefined;
      }
      const label = location.label?.trim() || `Veřejná kamera ${round(lat, 5)}, ${round(lon, 5)}`;
      const locationId = stableId(location.locationId ?? `${sourceId}_${label}_${coordinateToken(lon)}_${coordinateToken(lat)}`).slice(0, 160);
      const cameras = normalizeStaticCameras(location.cameras ?? [], sourceId, locationId);
      if (cameras.length === 0) {
        return undefined;
      }
      return {
        locationId,
        label,
        lon,
        lat,
        sourceDataUrl: validUrl(location.sourceDataUrl) ?? feed.url,
        sourceId,
        sourceName,
        sourceNameEn: sourceName,
        authority: location.authority?.trim() || authority,
        attribution: location.attribution?.trim() || attribution,
        providerPageUrl: validUrl(location.providerPageUrl) ?? providerPageUrl,
        category: stableId(location.category ?? category).toLowerCase(),
        detailMode: "inline_cameras",
        cameras
      };
    })
    .filter((item): item is ChmiWeatherWebcamLocation => Boolean(item))
    .sort((a, b) => a.locationId.localeCompare(b.locationId));
}

function normalizeStaticCameras(cameras: StaticCameraFeedCamera[], sourceId: string, locationId: string): ResolvedCamera[] {
  const usedIds = new Map<string, number>();
  return cameras
    .map((camera, index): ResolvedCamera | undefined => {
      const directImageUrl = validRuntimeFetchUrl(camera.directImageUrl);
      const providerUrl = validRuntimeFetchUrl(camera.providerUrl) ?? directImageUrl;
      if (!providerUrl && !directImageUrl) {
        return undefined;
      }
      const baseId = stableCameraId([sourceId, locationId, camera.cameraId ?? camera.name ?? `camera-${index + 1}`]);
      const count = usedIds.get(baseId) ?? 0;
      usedIds.set(baseId, count + 1);
      const cameraId = count === 0 ? baseId : `${baseId}-${count + 1}`;
      const snapshotAvailable = camera.snapshotAvailable ?? Boolean(directImageUrl);
      return {
        cameraId,
        name: camera.name?.trim() || `Veřejná kamera ${index + 1}`,
        providerUrl,
        snapshotUrl: "",
        directImageUrl: snapshotAvailable ? directImageUrl : undefined,
        originSnapshotDiscovery: !directImageUrl && Boolean(providerUrl),
        contentType: validImageContentType(camera.contentType),
        snapshotAvailable: snapshotAvailable || (!directImageUrl && Boolean(providerUrl))
      };
    })
    .filter((item): item is ResolvedCamera => Boolean(item));
}

function cameraSnapshotAvailability(camera: ResolvedCamera): CameraSnapshotAvailability {
  if (camera.imageBase64) {
    return "embedded";
  }
  if (camera.directImageUrl) {
    return "direct";
  }
  if (camera.originSnapshotDiscovery && camera.providerUrl) {
    return "origin_page_discovery";
  }
  return "unavailable";
}

function cameraSnapshotAvailable(camera: ResolvedCamera): boolean {
  return cameraSnapshotAvailability(camera) !== "unavailable";
}

function locationSnapshotAvailability(location: ChmiWeatherWebcamLocation): CameraSnapshotAvailability {
  if (location.detailMode === "chmi_point") {
    return "embedded";
  }
  const availabilities = (location.cameras ?? []).map((camera) => cameraSnapshotAvailability(camera));
  if (availabilities.includes("direct")) {
    return "direct";
  }
  if (availabilities.includes("embedded")) {
    return "embedded";
  }
  if (availabilities.includes("origin_page_discovery")) {
    return "origin_page_discovery";
  }
  return "unavailable";
}

function locationSnapshotAvailable(location: ChmiWeatherWebcamLocation): boolean {
  return locationSnapshotAvailability(location) !== "unavailable";
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

function parsePublicCameraFeeds(values: string[]): PublicCameraFeedConfig[] {
  return values
    .map((value) => {
      const [sourceId, label, category, authority, providerPageUrl, kind, url] = value.split("|").map((part) => part.trim());
      if (!sourceId || !label || !category || !authority || !providerPageUrl || !kind || !url) {
        return undefined;
      }
      if (kind !== "arcgis_lavdis" && kind !== "arcgis_ostrava" && kind !== "ostrava_asmx" && kind !== "static_json") {
        return undefined;
      }
      try {
        return {
          sourceId: stableId(sourceId).toLowerCase(),
          label,
          category: stableId(category).toLowerCase(),
          authority,
          providerPageUrl: new URL(providerPageUrl).toString(),
          kind,
          url: normalizeFeedUrl(url)
        } satisfies PublicCameraFeedConfig;
      } catch {
        return undefined;
      }
    })
    .filter((item): item is PublicCameraFeedConfig => Boolean(item));
}

function normalizeFeedUrl(value: string): string {
  if (value.startsWith("builtin:")) {
    return value;
  }
  const url = validRuntimeFetchUrl(new URL(value).toString());
  if (!url) {
    throw new Error("PUBLIC_CAMERA_FEEDS URL must be public HTTP(S).");
  }
  return url;
}

function layerForCameraLocation(location: ChmiWeatherWebcamLocation): SituationLayerId {
  return isOutdoorCameraCategory(location.category) ? OUTDOOR_WEBCAMS_LAYER_ID : CHMI_WEATHER_WEBCAMS_LAYER_ID;
}

function isOutdoorCameraCategory(category: string): boolean {
  return ["outdoor", "outdoor_webcam", "tourism", "tourism_webcam", "scenic", "trail", "ski"].includes(category);
}

function lonLatFromArcgisFeature(feature: ArcgisCameraFeature): { lon: number; lat: number } | undefined {
  if (feature.geometry?.type !== "Point") {
    return undefined;
  }
  const [lon, lat] = feature.geometry.coordinates ?? [];
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return undefined;
  }
  const parsedLon = lon as number;
  const parsedLat = lat as number;
  if (parsedLon < -180 || parsedLon > 180 || parsedLat < -90 || parsedLat > 90) {
    return undefined;
  }
  return { lon: parsedLon, lat: parsedLat };
}

function stringProperty(properties: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = properties?.[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function stableCameraId(parts: Array<string | number | undefined>): string {
  return stableId(parts.filter((part): part is string | number => part !== undefined && part !== "").join("-"));
}

function ostravaArcgisCamera(
  feed: PublicCameraFeedConfig,
  objectId: string,
  camera: string | undefined,
  direction: string | undefined
): ResolvedCamera | undefined {
  if (!camera) {
    return undefined;
  }
  return {
    cameraId: stableCameraId([feed.sourceId, objectId, camera]),
    name: direction ? `${direction} (${camera})` : camera,
    providerUrl: feed.providerPageUrl,
    snapshotUrl: "",
    snapshotAvailable: false
  };
}

function ostravaCamerasFromContent(feed: PublicCameraFeedConfig, content: string): ResolvedCamera[] {
  const cameras: ResolvedCamera[] = [];
  const camShowPattern = /CamShow\('([^']*)'\s*,\s*([01])\s*,\s*new Array\((.*?)\)\)/g;
  let groupMatch: RegExpExecArray | null;
  while ((groupMatch = camShowPattern.exec(content))) {
    const [, locationLabel, cameraType, body] = groupMatch;
    const camBePattern = /CamBe\('([^']*)'\s*,\s*'([^']*)'\s*,\s*'[^']*'\s*,\s*'([^']*)'\)/g;
    let cameraMatch: RegExpExecArray | null;
    while ((cameraMatch = camBePattern.exec(body ?? ""))) {
      const [, direction, cameraId, quality] = cameraMatch;
      cameras.push({
        cameraId: stableCameraId([feed.sourceId, locationLabel, cameraType, direction, cameraId]),
        name: [direction, locationLabel].filter(Boolean).join(" - "),
        providerUrl: feed.providerPageUrl,
        snapshotUrl: "",
        snapshotAvailable: false
      });
    }
  }
  return cameras;
}

function plainText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const text = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;?/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : undefined;
}

function ostravaTitleFromContent(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = /class=["']bubNad["'][^>]*>(.*?)<\/td>/i.exec(value);
  return plainText(match?.[1]);
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

function validUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function validRuntimeFetchUrl(value: string | undefined): string | undefined {
  const candidate = validUrl(value);
  if (!candidate) {
    return undefined;
  }
  try {
    const url = new URL(candidate);
    if (url.username || url.password || isBlockedRuntimeFetchHost(url.hostname)) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function assertRuntimeFetchUrl(value: string, label: string): string {
  const url = validRuntimeFetchUrl(value);
  if (!url) {
    throw new Error(`${label} must be a public HTTP(S) URL.`);
  }
  return url;
}

function isBlockedRuntimeFetchHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
  if (
    !normalized ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "metadata.google.internal"
  ) {
    return true;
  }
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isBlockedIpv4(normalized);
  }
  if (ipVersion === 6) {
    return isBlockedIpv6(normalized);
  }
  return false;
}

function isBlockedIpv4(value: string): boolean {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [first = 0, second = 0, third = 0] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function isBlockedIpv6(value: string): boolean {
  const compact = value.toLowerCase();
  return (
    compact === "::" ||
    compact === "::1" ||
    compact.startsWith("0:0:0:0:0:0:0:") ||
    compact.startsWith("fc") ||
    compact.startsWith("fd") ||
    /^fe[89ab]/.test(compact)
  );
}

function validImageContentType(value: string | undefined): string | undefined {
  const normalized = value?.split(";")[0]?.trim().toLowerCase();
  return normalized && validSnapshotContentType(normalized) ? normalized : undefined;
}

function stableId(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 96);
  return normalized.length > 0 ? normalized : "camera";
}

function decodeBase64Image(value: string | undefined): Buffer {
  if (!value) {
    return Buffer.alloc(0);
  }
  const raw = value.includes(",") ? (value.split(",").pop() ?? "") : value;
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
  if (body.length >= 12 && body.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
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

interface OriginImageCandidate {
  url: string;
  score: number;
}

async function discoverOriginSnapshot(pageUrl: string, timeoutMs: number): Promise<OriginSnapshotDiscoveryEntry> {
  try {
    const html = await requestHtml(pageUrl, timeoutMs);
    const candidates = extractOriginImageCandidates(html, pageUrl).slice(0, 8);
    for (const candidate of candidates) {
      try {
        const image = await requestImage(candidate.url, Math.max(1000, Math.min(timeoutMs, 3000)));
        return {
          directImageUrl: candidate.url,
          bodyBase64: image.bodyBase64,
          contentType: image.contentType
        };
      } catch {
        // Try the next candidate. Discovery is best-effort and must not break camera detail.
      }
    }
    return {
      unavailableReason:
        candidates.length === 0 ? "No origin image candidates were found on the provider page." : "Origin image candidates did not return valid images."
    };
  } catch (error) {
    return {
      unavailableReason: error instanceof Error ? error.message : "Origin provider page could not be inspected."
    };
  }
}

function extractOriginImageCandidates(html: string, pageUrl: string): OriginImageCandidate[] {
  const candidates: OriginImageCandidate[] = [];
  const add = (value: string | undefined, baseScore: number, context: string) => {
    const candidateUrl = validOriginSnapshotCandidateUrl(value, pageUrl);
    if (!candidateUrl) {
      return;
    }
    const score = scoreOriginImageCandidate(candidateUrl, context, baseScore);
    if (score < 75) {
      return;
    }
    candidates.push({ url: candidateUrl, score });
  };

  for (const tag of html.matchAll(/<meta\s+([^>]+)>/gim)) {
    const attrs = parseHtmlAttributes(tag[1] ?? "");
    const key = `${attrs.property ?? ""} ${attrs.name ?? ""}`.toLowerCase();
    if (/\b(?:og:image|twitter:image|image)\b/.test(key)) {
      add(attrs.content, 45, `${key} ${attrs.content ?? ""}`);
    }
  }

  for (const tag of html.matchAll(/<link\s+([^>]+)>/gim)) {
    const attrs = parseHtmlAttributes(tag[1] ?? "");
    const rel = attrs.rel?.toLowerCase() ?? "";
    if (rel.includes("image_src")) {
      add(attrs.href, 45, `${rel} ${attrs.href ?? ""}`);
    }
  }

  for (const tag of html.matchAll(/<(img|source)\s+([^>]+)>/gim)) {
    const tagName = tag[1]?.toLowerCase() ?? "img";
    const attrs = parseHtmlAttributes(tag[2] ?? "");
    const context = Object.entries(attrs)
      .filter(([key]) => key !== "src" && key !== "srcset")
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    for (const key of ["src", "data-src", "data-original", "data-lazy-src", "data-url", "data-full", "data-image"]) {
      add(attrs[key], tagName === "img" ? 55 : 45, context);
    }
    for (const url of parseSrcSet(attrs.srcset)) {
      add(url, tagName === "img" ? 55 : 45, context);
    }
  }

  for (const match of html.matchAll(/https?:\\?\/\\?\/[^"'<>\\\s]+?\.(?:jpe?g|png|webp|gif)(?:\?[^"'<>\\\s]*)?/gim)) {
    add(match[0], 35, match[0]);
  }

  return dedupeBy(candidates, (candidate) => candidate.url).sort((a, b) => b.score - a.score);
}

function parseHtmlAttributes(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of value.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const key = match[1]?.toLowerCase();
    const rawValue = match[2] ?? match[3] ?? match[4];
    if (key && rawValue !== undefined) {
      attrs[key] = decodeHtml(rawValue);
    }
  }
  return attrs;
}

function parseSrcSet(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((part): part is string => Boolean(part));
}

function validOriginSnapshotCandidateUrl(value: string | undefined, pageUrl: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = decodeHtml(value).replace(/\\\//g, "/").trim();
  if (!normalized || normalized.startsWith("data:") || normalized.startsWith("blob:")) {
    return undefined;
  }
  const candidate = validRuntimeFetchUrl(absoluteUrl(normalized, pageUrl));
  if (!candidate) {
    return undefined;
  }
  try {
    const url = new URL(candidate);
    if (url.hostname === "webcamlive.cz" || url.hostname.endsWith(".webcamlive.cz")) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function scoreOriginImageCandidate(url: string, context: string, baseScore: number): number {
  const haystack = `${safeDecodeUri(url)} ${context}`.toLowerCase();
  if (!hasOriginCameraUrlSignal(url)) {
    return 0;
  }
  let score = baseScore;
  if (/\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(url)) {
    score += 12;
  }
  if (/(webcam|webkamera|kamera|camera|snapshot|snap|mjpg|live|current|aktual|latest|cam\b|kamera_)/i.test(haystack)) {
    score += 45;
  }
  if (/(meteo|weather|ski|sjezdov|lanov|hotel|obec|radnice|namesti|n[aá]m[eě]st[ií]|trail|tourist|turist)/i.test(haystack)) {
    score += 10;
  }
  if (
    /(logo|favicon|apple-touch-icon|sprite|placeholder|blank|avatar|banner|advert|reklam|facebook|instagram|youtube|mapy|mapbox|google|galerie|gallery|slider|plak[aá]t|poster|aktuality\/20\d{2})/i.test(
      haystack
    )
  ) {
    score -= 80;
  }
  return score;
}

function hasOriginCameraUrlSignal(value: string): boolean {
  const decoded = safeDecodeUri(value).toLowerCase();
  if (isRejectedOriginCameraImageUrl(decoded)) {
    return false;
  }
  if (
    /(?:webcam|webkamera|kamera|camera|snapshot|snap|mjpg|livecam|current|latest|axis-cgi|image\.cgi|video\.mjpg|last_photo|now\.jpe?g|getimage\.php|aktualni_thumb)/i.test(
      decoded
    )
  ) {
    return true;
  }
  return /20\d{6}[_-]\d{6}[^/]*\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(decoded);
}

function isRejectedOriginCameraImageUrl(value: string): boolean {
  return /(?:\/o\/adaptive-media\/image\/|\/documents\/42501\/503062\/webkamera|stocksnap|perex\.jpe?g|webcam[_-]?icon|offer_camera|televize\.png|system_preview|second-menu-webcam|aktualni-(?:informace|otviraci)|akt_prx|ikona|icon|menu|\/wp-content\/uploads\/20\d{2}\/\d{2}\/img_|\/icons?\/|\/modules\/[^?#]*\/img\/webcam\.svg|\.svg(?:[?#]|$)|\/gallery\/|\/galerie\/|\/slider\/|\/aktuality\/20\d{2})/i.test(
    value
  );
}

function validSnapshotContentType(value: string): boolean {
  return value === "image/jpeg" || value === "image/png" || value === "image/gif" || value === "image/webp";
}

function dedupeBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

async function requestHtml(url: string, timeoutMs: number): Promise<string> {
  const safeUrl = assertRuntimeFetchUrl(url, "Camera origin page");
  const response = await fetch(safeUrl, {
    headers: {
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "user-agent": "csm-sim-situation-data/0.1"
    },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(safeUrl).hostname}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 2_000_000) {
    throw new Error(`Provider page from ${new URL(safeUrl).hostname} is too large for camera discovery.`);
  }
  const html = await response.text();
  return html.length > 2_000_000 ? html.slice(0, 2_000_000) : html;
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

async function requestStaticCameraJson(url: string, timeoutMs: number): Promise<StaticCameraFeedPayload> {
  if (url === "builtin:curated_outdoor_webcams_cz") {
    const fileUrl = new URL("../data/curated-outdoor-webcams-cz.json", import.meta.url);
    const content = await readFile(fileUrl, "utf8");
    return JSON.parse(content) as StaticCameraFeedPayload;
  }
  return requestJson<StaticCameraFeedPayload>(url, timeoutMs);
}

async function requestJsonPost<T>(url: string, timeoutMs: number): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json,*/*",
      "content-type": "application/json; charset=utf-8",
      "user-agent": "csm-sim-situation-data/0.1"
    },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return (await response.json()) as T;
}

async function requestImage(url: string, timeoutMs: number): Promise<DirectSnapshotCacheEntry> {
  const safeUrl = assertRuntimeFetchUrl(url, "Camera snapshot");
  const response = await fetch(safeUrl, {
    headers: {
      accept: "image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8",
      "user-agent": "csm-sim-situation-data/0.1"
    },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(safeUrl).hostname}`);
  }
  const declaredType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 5_000_000) {
    throw new Error(`Camera snapshot from ${new URL(safeUrl).hostname} is too large.`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 5_000_000) {
    throw new Error(`Camera snapshot from ${new URL(safeUrl).hostname} is too large.`);
  }
  const contentType = declaredType && validSnapshotContentType(declaredType) ? declaredType : imageContentType(body);
  if (!validSnapshotContentType(contentType)) {
    throw new Error(`Camera snapshot from ${new URL(safeUrl).hostname} is not a supported raster image.`);
  }
  return {
    contentType,
    bodyBase64: body.toString("base64")
  };
}
