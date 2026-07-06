import { readFile } from "node:fs/promises";

import type { SituationDataConfig } from "./config.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { BoundingBox, SituationDataLicense, SituationFeature, SituationLayerId } from "./types.js";

export const CHMI_WEATHER_WEBCAMS_SOURCE_ID = "chmi_weather_webcams" as const;
export const CHMI_WEATHER_WEBCAMS_LAYER_ID = "weather_webcams" as const;
export const OUTDOOR_WEBCAMS_LAYER_ID = "outdoor_webcams" as const;
export const CHMI_WEATHER_WEBCAMS_CONTRACT_VERSION = "sim-weather-cameras-v1" as const;

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
  }

  cacheStats(): ManagedResponseCacheStats[] {
    return [this.mapCache.stats(), this.detailCache.stats(), this.directSnapshotCache.stats()];
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
      snapshotAvailable: camera.snapshotAvailable ?? Boolean(camera.imageBase64 || camera.directImageUrl)
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
      snapshotAvailable:
        location.detailMode === "chmi_point" ? true : (location.cameras ?? []).some((camera) => camera.snapshotAvailable ?? Boolean(camera.directImageUrl))
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
      const directImageUrl = validUrl(camera.directImageUrl);
      const providerUrl = validUrl(camera.providerUrl) ?? directImageUrl;
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
        contentType: validImageContentType(camera.contentType),
        snapshotAvailable
      };
    })
    .filter((item): item is ResolvedCamera => Boolean(item));
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
  return new URL(value).toString();
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

function validImageContentType(value: string | undefined): string | undefined {
  const normalized = value?.split(";")[0]?.trim().toLowerCase();
  return normalized?.startsWith("image/") ? normalized : undefined;
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
  const response = await fetch(url, {
    headers: {
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "user-agent": "csm-sim-situation-data/0.1"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  const declaredType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 5_000_000) {
    throw new Error(`Camera snapshot from ${new URL(url).hostname} is too large.`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 5_000_000) {
    throw new Error(`Camera snapshot from ${new URL(url).hostname} is too large.`);
  }
  const contentType = declaredType?.startsWith("image/") ? declaredType : imageContentType(body);
  if (!contentType.startsWith("image/")) {
    throw new Error(`Camera snapshot from ${new URL(url).hostname} is not an image.`);
  }
  return {
    contentType,
    bodyBase64: body.toString("base64")
  };
}
