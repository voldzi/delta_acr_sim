import type { SituationDataConfig } from "./config.js";
import type {
  BoundingBox,
  PointGeometry,
  SituationDataLicense,
  SituationDataSourceId,
  SituationFeature,
  SituationLayerId,
  SituationQuery,
  SituationSeverity,
  SourceDescriptor,
  SourceFetchResult
} from "./types.js";

export interface SituationDataSource {
  descriptor: SourceDescriptor;
  fetchFeatures(query: SituationQuery): Promise<SourceFetchResult>;
}

const MOCK_LICENSE: SituationDataLicense = {
  name: "Synthetic internal test data",
  attribution: "DELTA ACR SIM",
  commercialUse: "allowed",
  operationalUse: "allowed",
  notes: ["Synthetic situation features for COP integration testing."]
};

const OPEN_METEO_LICENSE: SituationDataLicense = {
  name: "CC BY 4.0 / Open-Meteo Terms",
  url: "https://open-meteo.com/en/terms",
  attribution: "Weather data by Open-Meteo.com",
  commercialUse: "requires_license",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Free API is limited to non-commercial use.",
    "Data is provided under CC BY 4.0 conditions.",
    "Commercial use requires a paid Open-Meteo API plan."
  ]
};

const OSM_LICENSE: SituationDataLicense = {
  name: "ODbL 1.0",
  url: "https://opendatacommons.org/licenses/odbl/1-0/",
  attribution: "OpenStreetMap contributors",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Attribution is required.",
    "Public adapted databases must follow ODbL obligations.",
    "Public Overpass instances are shared resources; keep bbox and cadence conservative."
  ]
};

export function createSituationDataSources(config: SituationDataConfig): SituationDataSource[] {
  const allSources: Record<SituationDataSourceId, SituationDataSource> = {
    mock: new MockSituationDataSource(),
    open_meteo: new OpenMeteoSource(config),
    osm_overpass: new OsmOverpassSource(config)
  };

  return config.enabledSources.map((sourceId) => allSources[sourceId]);
}

export function allSourceDescriptors(config: SituationDataConfig): SourceDescriptor[] {
  const enabled = new Set(config.enabledSources);
  return [
    new MockSituationDataSource().descriptor,
    new OpenMeteoSource(config).descriptor,
    new OsmOverpassSource(config).descriptor
  ].map((descriptor) => ({ ...descriptor, enabled: enabled.has(descriptor.sourceId) }));
}

class MockSituationDataSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor = {
    sourceId: "mock",
    label: "Synthetic local situation feed",
    enabled: true,
    mode: "mock",
    priority: 10,
    layers: ["weather", "ground", "mobile", "traffic"],
    license: MOCK_LICENSE,
    updateCadenceSeconds: 10
  };

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const features = mockFeatures(fetchedAt)
      .filter((feature) => query.layers.includes(feature.properties.layer))
      .filter((feature) => isFeatureInBbox(feature, query.bbox))
      .map((feature) => stripRawIfNeeded(feature, query.includeRaw));

    return {
      source: this.descriptor,
      fetchedAt,
      features,
      warnings: []
    };
  }
}

class OpenMeteoSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;

  constructor(private readonly config: SituationDataConfig) {
    this.descriptor = {
      sourceId: "open_meteo",
      label: "Open-Meteo current weather",
      enabled: config.enabledSources.includes("open_meteo"),
      mode: "live",
      priority: 70,
      layers: ["weather"],
      license: OPEN_METEO_LICENSE,
      baseUrl: config.openMeteoBaseUrl,
      updateCadenceSeconds: 600
    };
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("weather")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const center = bboxCenter(query.bbox);
    const url = new URL(`${this.config.openMeteoBaseUrl}/v1/forecast`);
    url.searchParams.set("latitude", center.lat.toFixed(5));
    url.searchParams.set("longitude", center.lon.toFixed(5));
    url.searchParams.set(
      "current",
      [
        "temperature_2m",
        "relative_humidity_2m",
        "precipitation",
        "weather_code",
        "cloud_cover",
        "wind_speed_10m",
        "wind_direction_10m",
        "wind_gusts_10m"
      ].join(",")
    );
    url.searchParams.set("wind_speed_unit", "ms");
    url.searchParams.set("timezone", "UTC");

    const payload = await requestJson<OpenMeteoResponse>(url.toString(), this.config.requestTimeoutMs);
    const current = payload.current ?? {};
    const observedAt = normalizeOpenMeteoTime(current.time) ?? fetchedAt;
    const windSpeedMps = optionalNumber(current.wind_speed_10m);
    const precipitationMm = optionalNumber(current.precipitation);
    const weatherCode = optionalNumber(current.weather_code);
    const severity = weatherSeverity(windSpeedMps, precipitationMm, weatherCode);

    const feature = makePointFeature({
      id: `weather:open_meteo:${center.lat.toFixed(4)}:${center.lon.toFixed(4)}`,
      lon: center.lon,
      lat: center.lat,
      layer: "weather",
      category: "weather_observation",
      label: "Weather near map center",
      sourceId: "open_meteo",
      license: OPEN_METEO_LICENSE,
      observedAt,
      confidence: 0.86,
      severity,
      metrics: compactMetrics({
        temperatureC: optionalNumber(current.temperature_2m),
        relativeHumidityPercent: optionalNumber(current.relative_humidity_2m),
        precipitationMm,
        cloudCoverPercent: optionalNumber(current.cloud_cover),
        windSpeedMps,
        windDirectionDeg: optionalNumber(current.wind_direction_10m),
        windGustMps: optionalNumber(current.wind_gusts_10m),
        weatherCode
      }),
      raw: query.includeRaw ? { current, current_units: payload.current_units } : undefined
    });

    return { source: this.descriptor, fetchedAt, features: [feature], warnings: [] };
  }
}

class OsmOverpassSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;

  constructor(private readonly config: SituationDataConfig) {
    this.descriptor = {
      sourceId: "osm_overpass",
      label: "OpenStreetMap Overpass ground context",
      enabled: config.enabledSources.includes("osm_overpass"),
      mode: "live",
      priority: 50,
      layers: ["ground", "mobile"],
      license: OSM_LICENSE,
      baseUrl: config.overpassBaseUrl,
      updateCadenceSeconds: 86400
    };
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const requestedLayers = query.layers.filter((layer) => this.descriptor.layers.includes(layer));
    if (requestedLayers.length === 0) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const width = Math.abs(query.bbox.east - query.bbox.west);
    const height = Math.abs(query.bbox.north - query.bbox.south);
    if (Math.max(width, height) > this.config.overpassMaxBboxDegrees) {
      return {
        source: this.descriptor,
        fetchedAt,
        features: [],
        warnings: [`osm_overpass skipped: bbox exceeds ${this.config.overpassMaxBboxDegrees} degrees.`]
      };
    }

    const payload = await requestOverpass(this.config.overpassBaseUrl, overpassQuery(query.bbox), this.config.requestTimeoutMs);
    const features = (payload.elements ?? [])
      .map((element) => mapOverpassElement(element, fetchedAt, query.includeRaw))
      .filter((feature): feature is SituationFeature => Boolean(feature))
      .filter((feature) => query.layers.includes(feature.properties.layer))
      .filter((feature) => isFeatureInBbox(feature, query.bbox))
      .slice(0, query.limit);

    return { source: this.descriptor, fetchedAt, features, warnings: [] };
  }
}

interface FeatureInput {
  id: string;
  lon: number;
  lat: number;
  layer: SituationLayerId;
  category: string;
  label: string;
  sourceId: SituationDataSourceId;
  license: SituationDataLicense;
  observedAt: string;
  validUntil?: string;
  confidence: number;
  severity: SituationSeverity;
  metrics?: Record<string, number | string | boolean>;
  tags?: Record<string, string>;
  raw?: unknown;
}

function makePointFeature(input: FeatureInput): SituationFeature {
  return {
    type: "Feature",
    id: input.id,
    geometry: {
      type: "Point",
      coordinates: [round(input.lon, 6), round(input.lat, 6)]
    },
    properties: {
      featureId: input.id,
      layer: input.layer,
      category: input.category,
      label: input.label,
      sourceId: input.sourceId,
      observedAt: input.observedAt,
      validUntil: input.validUntil,
      confidence: round(Math.max(0, Math.min(1, input.confidence)), 2),
      stale: false,
      severity: input.severity,
      license: {
        name: input.license.name,
        attribution: input.license.attribution,
        url: input.license.url
      },
      metrics: input.metrics,
      tags: input.tags,
      raw: input.raw
    }
  };
}

function mockFeatures(observedAt: string): SituationFeature[] {
  return [
    makePointFeature({
      id: "weather:mock:prague-west",
      lon: 14.2632,
      lat: 50.1008,
      layer: "weather",
      category: "weather_observation",
      label: "Synthetic weather reference",
      sourceId: "mock",
      license: MOCK_LICENSE,
      observedAt,
      confidence: 0.92,
      severity: "info",
      metrics: { temperatureC: 18.2, windSpeedMps: 3.8, precipitationMm: 0 }
    }),
    makePointFeature({
      id: "ground:mock:hospital-motol",
      lon: 14.3405,
      lat: 50.0748,
      layer: "ground",
      category: "hospital",
      label: "Ground reference: major hospital",
      sourceId: "mock",
      license: MOCK_LICENSE,
      observedAt,
      confidence: 0.88,
      severity: "info",
      tags: { role: "reference", sourceKind: "pilot_fixture" }
    }),
    makePointFeature({
      id: "ground:mock:fire-station-smichov",
      lon: 14.4087,
      lat: 50.0732,
      layer: "ground",
      category: "fire_station",
      label: "Ground reference: fire station",
      sourceId: "mock",
      license: MOCK_LICENSE,
      observedAt,
      confidence: 0.84,
      severity: "info",
      tags: { role: "reference", sourceKind: "pilot_fixture" }
    }),
    makePointFeature({
      id: "mobile:mock:ctu-nettest-prague-5",
      lon: 14.3894,
      lat: 50.0719,
      layer: "mobile",
      category: "network_measurement",
      label: "Synthetic mobile network quality sample",
      sourceId: "mock",
      license: MOCK_LICENSE,
      observedAt,
      confidence: 0.72,
      severity: "advisory",
      metrics: { downloadMbps: 38, uploadMbps: 12, latencyMs: 31, signalRsrpDbm: -96 },
      tags: { operator: "pilot", accessTechnology: "LTE" }
    }),
    makePointFeature({
      id: "mobile:mock:cell-reference-zlicin",
      lon: 14.2867,
      lat: 50.0552,
      layer: "mobile",
      category: "cell_site_reference",
      label: "Synthetic mobile cell reference",
      sourceId: "mock",
      license: MOCK_LICENSE,
      observedAt,
      confidence: 0.68,
      severity: "info",
      metrics: { bandMhz: 1800 },
      tags: { accessTechnology: "LTE", role: "coverage_reference" }
    }),
    makePointFeature({
      id: "traffic:mock:d5-restriction",
      lon: 14.2578,
      lat: 50.0525,
      layer: "traffic",
      category: "road_restriction",
      label: "Synthetic road restriction",
      sourceId: "mock",
      license: MOCK_LICENSE,
      observedAt,
      confidence: 0.8,
      severity: "warning",
      metrics: { delayMinutes: 12 },
      tags: { road: "D5", direction: "Prague inbound" }
    })
  ];
}

interface OpenMeteoResponse {
  current?: Record<string, unknown>;
  current_units?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: {
    lat?: number;
    lon?: number;
  };
  tags?: Record<string, string>;
}

async function requestJson<T>(url: string, timeoutMs: number): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return (await response.json()) as T;
}

async function requestOverpass(baseUrl: string, query: string, timeoutMs: number): Promise<OverpassResponse> {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(baseUrl).hostname}`);
  }
  return (await response.json()) as OverpassResponse;
}

function overpassQuery(bbox: BoundingBox): string {
  const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `
[out:json][timeout:8];
(
  node["amenity"~"^(hospital|police|fire_station)$"](${box});
  way["amenity"~"^(hospital|police|fire_station)$"](${box});
  relation["amenity"~"^(hospital|police|fire_station)$"](${box});
  node["emergency"~"^(ambulance_station|fire_hydrant)$"](${box});
  node["man_made"~"^(communications_tower|tower)$"](${box});
  node["tower:type"="communication"](${box});
);
out center 120;
`;
}

function mapOverpassElement(element: OverpassElement, observedAt: string, includeRaw: boolean): SituationFeature | undefined {
  const lon = optionalNumber(element.lon ?? element.center?.lon);
  const lat = optionalNumber(element.lat ?? element.center?.lat);
  if (lon === undefined || lat === undefined) {
    return undefined;
  }
  const tags = element.tags ?? {};
  const category = osmCategory(tags);
  const layer: SituationLayerId = category === "communications_tower" ? "mobile" : "ground";
  const label = tags.name || labelForCategory(category);
  const id = `${layer}:osm:${element.type}:${element.id}`;

  return makePointFeature({
    id,
    lon,
    lat,
    layer,
    category,
    label,
    sourceId: "osm_overpass",
    license: OSM_LICENSE,
    observedAt,
    confidence: element.type === "node" ? 0.82 : 0.74,
    severity: "info",
    tags: compactTags({
      osmType: element.type,
      amenity: tags.amenity,
      emergency: tags.emergency,
      man_made: tags.man_made,
      towerType: tags["tower:type"]
    }),
    raw: includeRaw ? element : undefined
  });
}

function osmCategory(tags: Record<string, string>): string {
  if (tags.amenity === "hospital") {
    return "hospital";
  }
  if (tags.amenity === "police") {
    return "police";
  }
  if (tags.amenity === "fire_station") {
    return "fire_station";
  }
  if (tags.emergency) {
    return tags.emergency;
  }
  if (tags.man_made === "communications_tower" || tags["tower:type"] === "communication") {
    return "communications_tower";
  }
  return "ground_reference";
}

function labelForCategory(category: string): string {
  const labels: Record<string, string> = {
    hospital: "Hospital",
    police: "Police station",
    fire_station: "Fire station",
    ambulance_station: "Ambulance station",
    fire_hydrant: "Fire hydrant",
    communications_tower: "Communication tower"
  };
  return labels[category] ?? "Ground reference";
}

function stripRawIfNeeded(feature: SituationFeature, includeRaw: boolean): SituationFeature {
  if (includeRaw || !feature.properties.raw) {
    return feature;
  }
  return {
    ...feature,
    properties: {
      ...feature.properties,
      raw: undefined
    }
  };
}

function bboxCenter(bbox: BoundingBox): { lat: number; lon: number } {
  return {
    lat: (bbox.south + bbox.north) / 2,
    lon: (bbox.west + bbox.east) / 2
  };
}

function isFeatureInBbox(feature: SituationFeature, bbox: BoundingBox): boolean {
  const point = pointGeometry(feature.geometry);
  if (!point) {
    return true;
  }
  const [lon, lat] = point.coordinates;
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function pointGeometry(geometry: SituationFeature["geometry"]): PointGeometry | undefined {
  return geometry.type === "Point" ? geometry : undefined;
}

function weatherSeverity(windSpeedMps: number | undefined, precipitationMm: number | undefined, weatherCode: number | undefined): SituationSeverity {
  if ((windSpeedMps ?? 0) >= 25 || (precipitationMm ?? 0) >= 20 || severeWeatherCodes.has(weatherCode ?? -1)) {
    return "critical";
  }
  if ((windSpeedMps ?? 0) >= 15 || (precipitationMm ?? 0) >= 5 || warningWeatherCodes.has(weatherCode ?? -1)) {
    return "warning";
  }
  if ((windSpeedMps ?? 0) >= 10 || (precipitationMm ?? 0) > 0) {
    return "advisory";
  }
  return "info";
}

const warningWeatherCodes = new Set([51, 53, 55, 61, 63, 65, 71, 73, 75, 80, 81, 82]);
const severeWeatherCodes = new Set([95, 96, 99]);

function normalizeOpenMeteoTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const withZone = value.endsWith("Z") ? value : `${value}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactMetrics(values: Record<string, number | undefined>): Record<string, number> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, number] => typeof entry[1] === "number");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactTags(values: Record<string, string | undefined>): Record<string, string> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
