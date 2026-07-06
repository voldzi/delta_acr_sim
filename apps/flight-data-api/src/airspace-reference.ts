import type { FlightDataConfig } from "./config.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { AirspaceReference, AviationAirspaceType, BoundingBox, GeoJsonPolygon } from "./types.js";

const PROVIDER_ID = "sim.flight-data" as const;
const PROVIDER_LAYER_ID = "flight.airspaces" as const;
const CATALOG_LAYER_ID = "flight.reference.airspaces" as const;
const AIP_SECTION = "AIP CR ENR 5.1";
const EARTH_RADIUS_M = 6_371_008.8;
const NM_TO_M = 1852;

export interface AirspaceQuery {
  bbox?: BoundingBox;
  types?: AviationAirspaceType[];
  limit: number;
}

export interface AirspaceReferenceMetadata {
  airspaceCount: number;
  source: string;
  sourceUrl: string;
  loadedAt: string;
  warnings: string[];
  cache: ManagedResponseCacheStats;
  notForNavigation: true;
}

export interface AirspaceFeatureCollection {
  type: "FeatureCollection";
  contractVersion: "flight-airspace-reference-v1";
  generatedAt: string;
  features: AirspaceFeature[];
  source: {
    sourceId: "czech_aip_airspaces";
    label: string;
    sourceUrl: string;
    sourceSection: string;
    loadedAt: string;
    license: {
      name: string;
      attribution: string;
      commercialUse: "requires_license";
      operationalUse: "requires_license";
      notes: string[];
    };
    warnings: string[];
  };
  summary: {
    totalReferenceAirspaces: number;
    returnedAirspaces: number;
    notForNavigation: true;
    geometryQuality: Record<string, number>;
  };
  warnings: string[];
}

export interface AirspaceFeature {
  type: "Feature";
  id: string;
  geometry: GeoJsonPolygon;
  properties: {
    layerId: typeof CATALOG_LAYER_ID;
    providerId: typeof PROVIDER_ID;
    providerLayerId: typeof PROVIDER_LAYER_ID;
    sourceId: "czech_aip_airspaces";
    category: string;
    label: string;
    observedAt: string;
    stale: boolean;
    confidence: number;
    severity: "info" | "warning";
    airspaceId: string;
    designator: string;
    name: string;
    airspaceType: AviationAirspaceType;
    lowerLimit: string;
    upperLimit: string;
    verticalLimitText: string;
    time?: string;
    notForNavigation: true;
    providerProperties: {
      geometryQuality: AirspaceReference["geometryQuality"];
      sourceSection: string;
      sourceUrl: string;
      activity?: string;
      remarks?: string;
      dataSource: string;
    };
  };
}

interface LoadedAirspaces {
  airspaces: AirspaceReference[];
  source: string;
  sourceUrl: string;
  loadedAt: string;
  warnings: string[];
}

export class AirspaceReferenceService {
  private readonly airspacesCache: ManagedResponseCache<LoadedAirspaces>;

  constructor(private readonly config: FlightDataConfig) {
    this.airspacesCache = new ManagedResponseCache<LoadedAirspaces>({
      ttlMs: Math.max(60, config.aipAirspacesCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.aipAirspacesCacheTtlSeconds, 60 * 60) * 1000,
      maxEntries: 1
    });
  }

  async getFeatureCollection(query: AirspaceQuery): Promise<AirspaceFeatureCollection> {
    const loaded = await this.loadAirspaces();
    const filtered = filterAirspaces(loaded.airspaces, query);
    const generatedAt = new Date().toISOString();
    return {
      type: "FeatureCollection",
      contractVersion: "flight-airspace-reference-v1",
      generatedAt,
      features: filtered.map((airspace) => toFeature(airspace, loaded.warnings.length > 0)),
      source: {
        sourceId: "czech_aip_airspaces",
        label: loaded.source === "aip:enr-5.1" ? "Czech AIP/eAIP ENR 5.1 airspace reference" : "Embedded Czech AIP airspace seed fallback",
        sourceUrl: loaded.sourceUrl,
        sourceSection: AIP_SECTION,
        loadedAt: loaded.loadedAt,
        license: {
          name: "Public AIP/eAIP publication; redistribution rights must be validated",
          attribution: "Air Navigation Services of the Czech Republic / AIP CR",
          commercialUse: "requires_license",
          operationalUse: "requires_license",
          notes: [
            "Use as public situational reference only, not as an operational aeronautical information product.",
            "Production or commercial redistribution should be confirmed with AIS/ANS CR or replaced by a licensed AIXM/AIP feed."
          ]
        },
        warnings: loaded.warnings
      },
      summary: {
        totalReferenceAirspaces: loaded.airspaces.length,
        returnedAirspaces: filtered.length,
        notForNavigation: true,
        geometryQuality: summarizeGeometryQuality(filtered)
      },
      warnings: loaded.warnings
    };
  }

  async metadata(): Promise<AirspaceReferenceMetadata> {
    const loaded = await this.loadAirspaces();
    return {
      airspaceCount: loaded.airspaces.length,
      source: loaded.source,
      sourceUrl: loaded.sourceUrl,
      loadedAt: loaded.loadedAt,
      warnings: loaded.warnings,
      cache: this.airspacesCache.stats(),
      notForNavigation: true
    };
  }

  cacheStats(): ManagedResponseCacheStats {
    return this.airspacesCache.stats();
  }

  private async loadAirspaces(): Promise<LoadedAirspaces> {
    if (!this.config.aipAirspacesEnabled) {
      const loadedAt = new Date().toISOString();
      return {
        airspaces: seedAirspaces(loadedAt, this.config.aipAirspacesSourceUrl),
        source: "seed:aip-enr-5.1",
        sourceUrl: this.config.aipAirspacesSourceUrl,
        loadedAt,
        warnings: ["AIP airspace import is disabled; using embedded seed fallback."]
      };
    }

    return this.airspacesCache.getOrLoad("aip:enr-5.1", async () => {
      const loadedAt = new Date().toISOString();
      try {
        const response = await fetch(this.config.aipAirspacesSourceUrl, {
          headers: {
            accept: "text/html,*/*",
            "user-agent": "csm-sim-flight-data/0.1"
          },
          signal: AbortSignal.timeout(this.config.requestTimeoutMs)
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from ${new URL(this.config.aipAirspacesSourceUrl).hostname}`);
        }
        const airspaces = parseAipEnr51Airspaces(await response.text(), this.config.aipAirspacesSourceUrl, loadedAt);
        if (airspaces.length === 0) {
          throw new Error("No parseable ENR 5.1 airspaces found.");
        }
        return {
          airspaces,
          source: "aip:enr-5.1",
          sourceUrl: this.config.aipAirspacesSourceUrl,
          loadedAt,
          warnings: []
        };
      } catch (error) {
        return {
          airspaces: seedAirspaces(loadedAt, this.config.aipAirspacesSourceUrl),
          source: "seed:aip-enr-5.1",
          sourceUrl: this.config.aipAirspacesSourceUrl,
          loadedAt,
          warnings: [error instanceof Error ? `AIP airspace import failed: ${error.message}` : "AIP airspace import failed."]
        };
      }
    });
  }
}

export function parseAipEnr51Airspaces(html: string, sourceUrl: string, loadedAt: string): AirspaceReference[] {
  return html
    .split(/<tr\b[^>]*>/i)
    .slice(1)
    .map((row) => row.split(/<\/tr>/i)[0] ?? row)
    .filter((row) => /TAIRSPACE;CODE_ID/.test(row))
    .map((row) => parseAirspaceRow(row, sourceUrl, loadedAt))
    .filter((airspace): airspace is AirspaceReference => Boolean(airspace))
    .sort((left, right) => left.designator.localeCompare(right.designator, "en", { numeric: true }));
}

function parseAirspaceRow(row: string, sourceUrl: string, loadedAt: string): AirspaceReference | undefined {
  const cells = row
    .split(/<td\b[^>]*>/i)
    .slice(1)
    .map((cell) => cell.split(/<\/td>/i)[0] ?? cell);
  const header = stripHtml(cells[0]?.match(/<p[\s\S]*?<\/p>/i)?.[0] ?? cells[0] ?? "");
  const designator = header.match(/\bLK[A-Z]{1,4}\d+[A-Z]?\b/)?.[0];
  if (!designator) {
    return undefined;
  }
  const name = header.replace(designator, "").trim() || designator;
  const coordinatePairs = extractCoordinatePairs(row);
  const radiusNm = extractRadiusNm(row);
  const circleCenter = coordinatePairs[0];
  const polygon = radiusNm && circleCenter ? circlePolygon(circleCenter, radiusNm) : polygonFromCoordinates(coordinatePairs);
  if (!polygon) {
    return undefined;
  }
  const verticalLimitText = stripHtml(cells[1] ?? "");
  const remarksText = stripHtml(cells[2] ?? "");
  const lowerUpper = parseVerticalLimits(verticalLimitText);
  return {
    airspaceId: `airspace:cz:aip:${designator.toLowerCase()}`,
    designator,
    name,
    type: airspaceType(designator),
    geometry: polygon,
    geometryQuality: radiusNm
      ? "official_circle_approximation"
      : remarksText.toLowerCase().includes("state boundary")
        ? "official_vertices_with_boundary_simplification"
        : "official_vertices",
    lowerLimit: lowerUpper.lower,
    upperLimit: lowerUpper.upper,
    verticalLimitText,
    activity: extractRemarkPart(remarksText, "Activity"),
    time: extractRemarkPart(remarksText, "Time"),
    remarks: remarksText || undefined,
    sourceUrl,
    sourceSection: AIP_SECTION,
    dataSource: "aip:enr-5.1",
    loadedAt,
    notForNavigation: true
  };
}

function extractCoordinatePairs(row: string): Array<[number, number]> {
  const coordinatePairs: Array<[number, number]> = [];
  const pairRe =
    /<span class="SD"[^>]*>\s*([0-9]{6}(?:\.[0-9]+)?[NS])\s*<\/span>\s*<span class="sdParams"[^>]*>\s*TAIRSPACE_VERTEX;GEO_LAT(?:_ARC)?;[^<]*<\/span>\s*<span class="SD"[^>]*>\s*([0-9]{7}(?:\.[0-9]+)?[EW])\s*<\/span>\s*<span class="sdParams"[^>]*>\s*TAIRSPACE_VERTEX;GEO_LONG(?:_ARC)?;[^<]*<\/span>/gi;
  let match: RegExpExecArray | null;
  while ((match = pairRe.exec(row)) !== null) {
    const latToken = match[1];
    const lonToken = match[2];
    if (!latToken || !lonToken) {
      continue;
    }
    const lat = parseAipDms(latToken);
    const lon = parseAipDms(lonToken);
    if (lat !== undefined && lon !== undefined) {
      coordinatePairs.push([roundCoordinate(lon), roundCoordinate(lat)]);
    }
  }
  if (coordinatePairs.length === 0) {
    const plainText = stripHtml(row);
    const plainPairRe = /([0-9]{6}(?:\.[0-9]+)?[NS])\s+([0-9]{7}(?:\.[0-9]+)?[EW])/g;
    let plainMatch: RegExpExecArray | null;
    while ((plainMatch = plainPairRe.exec(plainText)) !== null) {
      const latToken = plainMatch[1];
      const lonToken = plainMatch[2];
      if (!latToken || !lonToken) {
        continue;
      }
      const lat = parseAipDms(latToken);
      const lon = parseAipDms(lonToken);
      if (lat !== undefined && lon !== undefined) {
        coordinatePairs.push([roundCoordinate(lon), roundCoordinate(lat)]);
      }
    }
  }
  return coordinatePairs;
}

function extractRadiusNm(row: string): number | undefined {
  const match = row.match(/<span class="SD"[^>]*>\s*([0-9]+(?:\.[0-9]+)?)\s*<\/span>\s*<span class="sdParams"[^>]*>\s*TAIRSPACE_VERTEX;VAL_RADIUS_ARC;/i);
  const value = match ? Number(match[1]) : undefined;
  return value && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseAipDms(value: string): number | undefined {
  const match = value.trim().match(/^(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)([NSEW])$/);
  if (!match) {
    return undefined;
  }
  const degrees = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (![degrees, minutes, seconds].every(Number.isFinite)) {
    return undefined;
  }
  let decimal = degrees + minutes / 60 + seconds / 3600;
  if (match[4] === "S" || match[4] === "W") {
    decimal *= -1;
  }
  return decimal;
}

function polygonFromCoordinates(coordinates: Array<[number, number]>): GeoJsonPolygon | undefined {
  if (coordinates.length < 3) {
    return undefined;
  }
  const ring = [...coordinates];
  const first = ring[0];
  const last = ring.at(-1);
  if (!first || !last) {
    return undefined;
  }
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push(first);
  }
  return { type: "Polygon", coordinates: [ring] };
}

function circlePolygon(center: [number, number], radiusNm: number): GeoJsonPolygon {
  const [centerLon, centerLat] = center;
  const latRad = degreesToRadians(centerLat);
  const lonRad = degreesToRadians(centerLon);
  const angularDistance = (radiusNm * NM_TO_M) / EARTH_RADIUS_M;
  const ring: Array<[number, number]> = [];
  for (let index = 0; index <= 64; index += 1) {
    const bearing = (2 * Math.PI * index) / 64;
    const lat = Math.asin(Math.sin(latRad) * Math.cos(angularDistance) + Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(bearing));
    const lon =
      lonRad + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latRad), Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(lat));
    ring.push([roundCoordinate(radiansToDegrees(lon)), roundCoordinate(radiansToDegrees(lat))]);
  }
  return { type: "Polygon", coordinates: [ring] };
}

function filterAirspaces(airspaces: AirspaceReference[], query: AirspaceQuery): AirspaceReference[] {
  const types = new Set(query.types ?? []);
  return airspaces
    .filter((airspace) => (types.size === 0 || types.has(airspace.type)) && (!query.bbox || polygonIntersectsBbox(airspace.geometry, query.bbox)))
    .slice(0, query.limit);
}

function polygonIntersectsBbox(polygon: GeoJsonPolygon, bbox: BoundingBox): boolean {
  const values = polygon.coordinates[0] ?? [];
  if (values.length === 0) {
    return false;
  }
  const west = Math.min(...values.map((item) => item[0]));
  const east = Math.max(...values.map((item) => item[0]));
  const south = Math.min(...values.map((item) => item[1]));
  const north = Math.max(...values.map((item) => item[1]));
  return east >= bbox.west && west <= bbox.east && north >= bbox.south && south <= bbox.north;
}

function toFeature(airspace: AirspaceReference, stale: boolean): AirspaceFeature {
  return {
    type: "Feature",
    id: airspace.airspaceId,
    geometry: airspace.geometry,
    properties: {
      layerId: CATALOG_LAYER_ID,
      providerId: PROVIDER_ID,
      providerLayerId: PROVIDER_LAYER_ID,
      sourceId: "czech_aip_airspaces",
      category: `airspace_${airspace.type}`,
      label: `${airspace.designator} ${airspace.name}`.trim(),
      observedAt: airspace.loadedAt,
      stale,
      confidence: confidenceForGeometry(airspace.geometryQuality),
      severity: airspace.type === "prohibited" || airspace.type === "danger" ? "warning" : "info",
      airspaceId: airspace.airspaceId,
      designator: airspace.designator,
      name: airspace.name,
      airspaceType: airspace.type,
      lowerLimit: airspace.lowerLimit,
      upperLimit: airspace.upperLimit,
      verticalLimitText: airspace.verticalLimitText,
      time: airspace.time,
      notForNavigation: true,
      providerProperties: {
        geometryQuality: airspace.geometryQuality,
        sourceSection: airspace.sourceSection,
        sourceUrl: airspace.sourceUrl,
        activity: airspace.activity,
        remarks: airspace.remarks,
        dataSource: airspace.dataSource
      }
    }
  };
}

function confidenceForGeometry(quality: AirspaceReference["geometryQuality"]): number {
  switch (quality) {
    case "official_vertices":
      return 0.92;
    case "official_circle_approximation":
      return 0.9;
    case "official_vertices_with_boundary_simplification":
      return 0.72;
    case "seed_fallback":
      return 0.6;
  }
}

function summarizeGeometryQuality(airspaces: AirspaceReference[]): Record<string, number> {
  return airspaces.reduce<Record<string, number>>((summary, airspace) => {
    summary[airspace.geometryQuality] = (summary[airspace.geometryQuality] ?? 0) + 1;
    return summary;
  }, {});
}

function parseVerticalLimits(value: string): { upper: string; lower: string } {
  const [upper, lower] = value.split("/").map((item) => item.trim());
  return {
    upper: upper || "UNKNOWN",
    lower: lower || "UNKNOWN"
  };
}

function extractRemarkPart(text: string, label: string): string | undefined {
  const labels = ["Activity", "Time", "Flight restriction", "Entry conditions", "Airspace user", "Remarks"];
  const alternatives = labels.filter((item) => item !== label).join("|");
  const match = text.match(new RegExp(`${label}:\\s*(.*?)(?=\\s+(?:${alternatives}):|$)`, "i"));
  return cleanText(match?.[1]);
}

function airspaceType(designator: string): AviationAirspaceType {
  if (designator.startsWith("LKP")) {
    return "prohibited";
  }
  if (designator.startsWith("LKR")) {
    return "restricted";
  }
  if (designator.startsWith("LKD")) {
    return "danger";
  }
  if (designator.startsWith("LKTRA")) {
    return "temporary_reserved";
  }
  if (designator.startsWith("LKTSA")) {
    return "temporary_segregated";
  }
  return "other";
}

function stripHtml(value: string): string {
  return value
    .replace(/<span class="sdParams"[^>]*>[\s\S]*?<\/span>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|\u00a0/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function seedAirspaces(loadedAt: string, sourceUrl: string): AirspaceReference[] {
  const lkp1 = polygonFromCoordinates([
    [14.410436, 50.098042],
    [14.41595, 50.093511],
    [14.409767, 50.087722],
    [14.4086, 50.084028],
    [14.387347, 50.088344],
    [14.388269, 50.094278],
    [14.410436, 50.098042]
  ]);
  return [
    {
      airspaceId: "airspace:cz:aip:lkp1",
      designator: "LKP1",
      name: "PRAŽSKÝ HRAD",
      type: "prohibited",
      geometry: lkp1 ?? circlePolygon([14.399, 50.091], 0.7),
      geometryQuality: "seed_fallback",
      lowerLimit: "GND",
      upperLimit: "4000 FT AMSL",
      verticalLimitText: "4000 FT AMSL / GND",
      time: "H24",
      remarks: "Seed fallback from AIP ENR 5.1.",
      sourceUrl,
      sourceSection: AIP_SECTION,
      dataSource: "seed:aip-enr-5.1",
      loadedAt,
      notForNavigation: true
    },
    {
      airspaceId: "airspace:cz:aip:lkp2",
      designator: "LKP2",
      name: "TEMELÍN",
      type: "prohibited",
      geometry: circlePolygon([14.375492, 49.180203], 1.1),
      geometryQuality: "seed_fallback",
      lowerLimit: "GND",
      upperLimit: "5000 FT AMSL",
      verticalLimitText: "5000 FT AMSL / GND",
      time: "H24",
      remarks: "Seed fallback from AIP ENR 5.1.",
      sourceUrl,
      sourceSection: AIP_SECTION,
      dataSource: "seed:aip-enr-5.1",
      loadedAt,
      notForNavigation: true
    }
  ];
}
