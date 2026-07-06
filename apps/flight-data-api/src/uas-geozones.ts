import type { FlightDataConfig } from "./config.js";
import { asGeoJsonGeometry, geometryIntersectsBbox, isRecord, type GeoJsonFeature, type GeoJsonFeatureCollection } from "./geojson.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { BoundingBox, GeoJsonGeometry } from "./types.js";

const PROVIDER_ID = "sim.flight-data" as const;
const PROVIDER_LAYER_ID = "flight.uas_geozones" as const;
const CATALOG_LAYER_ID = "flight.reference.uas_geozones" as const;

export interface UasGeozoneQuery {
  bbox?: BoundingBox;
  layerIds?: string[];
  limit: number;
}

export interface UasGeozoneMetadata {
  geozoneCount: number;
  source: string;
  catalogUrl: string;
  loadedAt: string;
  importedLayerIds: string[];
  skippedLayerIds: string[];
  warnings: string[];
  cache: ManagedResponseCacheStats;
  notForNavigation: true;
}

export interface LoadedUasGeozones {
  features: UasGeozoneRecord[];
  source: string;
  catalogUrl: string;
  loadedAt: string;
  importedLayerIds: string[];
  skippedLayerIds: string[];
  warnings: string[];
}

export interface UasGeozoneRecord {
  id: string;
  ident: string;
  publication: string;
  geometry: GeoJsonGeometry;
  label: string;
  verticalLimit?: string;
  effectiveDate?: string;
  sourceUrl: string;
  dataSource?: string;
  timestamp?: string;
  crc?: string;
  loadedAt: string;
}

export interface UasGeozoneFeatureCollection {
  type: "FeatureCollection";
  contractVersion: "flight-uas-geozone-reference-v1";
  generatedAt: string;
  features: UasGeozoneFeature[];
  source: {
    sourceId: "czech_uas_geozones";
    label: string;
    catalogUrl: string;
    loadedAt: string;
    importedLayerIds: string[];
    skippedLayerIds: string[];
    license: {
      name: string;
      attribution: string;
      commercialUse: "allowed_with_obligations";
      operationalUse: "allowed_with_obligations";
      notes: string[];
    };
    warnings: string[];
  };
  summary: {
    totalReferenceGeozones: number;
    returnedGeozones: number;
    notForNavigation: true;
    importedLayerIds: string[];
  };
  warnings: string[];
}

export interface UasGeozoneFeature {
  type: "Feature";
  id: string;
  geometry: GeoJsonGeometry;
  properties: {
    layerId: typeof CATALOG_LAYER_ID;
    providerId: typeof PROVIDER_ID;
    providerLayerId: typeof PROVIDER_LAYER_ID;
    sourceId: "czech_uas_geozones";
    category: "uas_geozone";
    label: string;
    observedAt: string;
    stale: boolean;
    confidence: number;
    severity: "info" | "warning";
    geozoneId: string;
    ident: string;
    publication: string;
    verticalLimit?: string;
    effectiveDate?: string;
    notForNavigation: true;
    providerProperties: {
      sourceUrl: string;
      dataSource?: string;
      timestamp?: string;
      crc?: string;
      sourcePurpose: "uas_geoawareness";
    };
  };
}

export class UasGeozoneService {
  private readonly cache: ManagedResponseCache<LoadedUasGeozones>;

  constructor(private readonly config: FlightDataConfig) {
    this.cache = new ManagedResponseCache<LoadedUasGeozones>({
      ttlMs: Math.max(60, config.uasGeozonesCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.uasGeozonesCacheTtlSeconds, 60 * 60) * 1000,
      maxEntries: 1
    });
  }

  async getFeatureCollection(query: UasGeozoneQuery): Promise<UasGeozoneFeatureCollection> {
    const loaded = await this.loadGeozones();
    const filtered = filterGeozones(loaded.features, query);
    return {
      type: "FeatureCollection",
      contractVersion: "flight-uas-geozone-reference-v1",
      generatedAt: new Date().toISOString(),
      features: filtered.map((feature) => toFeature(feature, loaded.warnings.length > 0)),
      source: {
        sourceId: "czech_uas_geozones",
        label: "AIM/ANS CR UAS geographical zones",
        catalogUrl: loaded.catalogUrl,
        loadedAt: loaded.loadedAt,
        importedLayerIds: loaded.importedLayerIds,
        skippedLayerIds: loaded.skippedLayerIds,
        license: uasGeozoneLicense(),
        warnings: loaded.warnings
      },
      summary: {
        totalReferenceGeozones: loaded.features.length,
        returnedGeozones: filtered.length,
        notForNavigation: true,
        importedLayerIds: loaded.importedLayerIds
      },
      warnings: loaded.warnings
    };
  }

  async metadata(): Promise<UasGeozoneMetadata> {
    const loaded = await this.loadGeozones();
    return {
      geozoneCount: loaded.features.length,
      source: loaded.source,
      catalogUrl: loaded.catalogUrl,
      loadedAt: loaded.loadedAt,
      importedLayerIds: loaded.importedLayerIds,
      skippedLayerIds: loaded.skippedLayerIds,
      warnings: loaded.warnings,
      cache: this.cache.stats(),
      notForNavigation: true
    };
  }

  async getLoadedGeozones(): Promise<LoadedUasGeozones> {
    return this.loadGeozones();
  }

  cacheStats(): ManagedResponseCacheStats {
    return this.cache.stats();
  }

  private async loadGeozones(): Promise<LoadedUasGeozones> {
    if (!this.config.uasGeozonesEnabled) {
      const loadedAt = new Date().toISOString();
      return {
        features: [],
        source: "disabled",
        catalogUrl: this.config.uasGeozonesCatalogUrl,
        loadedAt,
        importedLayerIds: [],
        skippedLayerIds: this.config.uasGeozonesLayerIds,
        warnings: ["UAS geozone import is disabled."]
      };
    }

    return this.cache.getOrLoad("aim:uas-geozones", async () => {
      const loadedAt = new Date().toISOString();
      const warnings: string[] = [];
      try {
        const catalogHtml = await requestText(this.config.uasGeozonesCatalogUrl, this.config.requestTimeoutMs);
        const catalog = parseUasGeozoneCatalog(catalogHtml, this.config.uasGeozonesCatalogUrl);
        const selected = new Set(this.config.uasGeozonesLayerIds.map((item) => item.toUpperCase()));
        const links = catalog.filter((item) => selected.has(item.layerId));
        const skippedLayerIds = [...selected].filter((layerId) => !links.some((item) => item.layerId === layerId)).sort();
        if (skippedLayerIds.length > 0) {
          warnings.push(`Configured UAS geozone layers not found in AIM catalog: ${skippedLayerIds.join(", ")}.`);
        }
        const featureSets = await Promise.all(
          links.map(async (link) => {
            try {
              return parseUasGeozoneCollection(await requestJson<unknown>(link.url, this.config.requestTimeoutMs), link, loadedAt);
            } catch (error) {
              warnings.push(
                error instanceof Error ? `UAS geozone ${link.layerId} import failed: ${error.message}` : `UAS geozone ${link.layerId} import failed.`
              );
              return [];
            }
          })
        );
        const features = featureSets.flat();
        return {
          features,
          source: "aim:uas-geozones",
          catalogUrl: this.config.uasGeozonesCatalogUrl,
          loadedAt,
          importedLayerIds: links.map((item) => item.layerId).sort(),
          skippedLayerIds,
          warnings
        };
      } catch (error) {
        return {
          features: [],
          source: "aim:uas-geozones",
          catalogUrl: this.config.uasGeozonesCatalogUrl,
          loadedAt,
          importedLayerIds: [],
          skippedLayerIds: this.config.uasGeozonesLayerIds,
          warnings: [error instanceof Error ? `UAS geozone catalog import failed: ${error.message}` : "UAS geozone catalog import failed."]
        };
      }
    });
  }
}

interface UasGeozoneCatalogLink {
  layerId: string;
  url: string;
}

export function parseUasGeozoneCatalog(html: string, catalogUrl: string): UasGeozoneCatalogLink[] {
  return [...html.matchAll(/href="([^"]+\.json)"[^>]*>\s*([^<]+\.json)\s*<\/a>/gi)]
    .map((match) => {
      const href = match[1];
      const label = match[2];
      if (!href || !label) {
        return undefined;
      }
      return {
        layerId: label
          .replace(/\.json$/i, "")
          .trim()
          .toUpperCase(),
        url: new URL(href.replace(/&amp;/g, "&"), catalogUrl).toString()
      };
    })
    .filter((item): item is UasGeozoneCatalogLink => Boolean(item));
}

function parseUasGeozoneCollection(payload: unknown, link: UasGeozoneCatalogLink, loadedAt: string): UasGeozoneRecord[] {
  if (!isRecord(payload) || payload.type !== "FeatureCollection" || !Array.isArray(payload.features)) {
    throw new Error("Unexpected GeoJSON FeatureCollection.");
  }
  const collection = payload as unknown as GeoJsonFeatureCollection;
  return collection.features
    .map((feature, index) => parseUasGeozoneFeature(feature, link, loadedAt, index))
    .filter((feature): feature is UasGeozoneRecord => Boolean(feature));
}

function parseUasGeozoneFeature(feature: GeoJsonFeature, link: UasGeozoneCatalogLink, loadedAt: string, index: number): UasGeozoneRecord | undefined {
  const geometry = asGeoJsonGeometry(feature.geometry);
  if (!geometry) {
    return undefined;
  }
  const properties = isRecord(feature.properties) ? feature.properties : {};
  const ident = cleanString(properties.ident) ?? `${link.layerId}:${index + 1}`;
  const publication = cleanString(properties.publication)?.toUpperCase() ?? link.layerId;
  return {
    id: `uas-geozone:cz:${publication.toLowerCase()}:${ident.toLowerCase()}`,
    ident,
    publication,
    geometry,
    label: `${publication} ${ident}`.trim(),
    verticalLimit: cleanString(properties.vertical_limit),
    effectiveDate: cleanString(properties.effective_date),
    sourceUrl: link.url,
    dataSource: cleanString(properties.data_source),
    timestamp: cleanString(properties._timestamp),
    crc: cleanString(properties._crc),
    loadedAt
  };
}

function filterGeozones(features: UasGeozoneRecord[], query: UasGeozoneQuery): UasGeozoneRecord[] {
  const layerIds = new Set((query.layerIds ?? []).map((item) => item.toUpperCase()));
  return features
    .filter((feature) => layerIds.size === 0 || layerIds.has(feature.publication.toUpperCase()))
    .filter((feature) => geometryIntersectsBbox(feature.geometry, query.bbox))
    .slice(0, query.limit);
}

function toFeature(feature: UasGeozoneRecord, stale: boolean): UasGeozoneFeature {
  return {
    type: "Feature",
    id: feature.id,
    geometry: feature.geometry,
    properties: {
      layerId: CATALOG_LAYER_ID,
      providerId: PROVIDER_ID,
      providerLayerId: PROVIDER_LAYER_ID,
      sourceId: "czech_uas_geozones",
      category: "uas_geozone",
      label: feature.label,
      observedAt: feature.timestamp ?? feature.effectiveDate ?? feature.loadedAt,
      stale,
      confidence: stale ? 0.68 : 0.86,
      severity: "warning",
      geozoneId: feature.id,
      ident: feature.ident,
      publication: feature.publication,
      verticalLimit: feature.verticalLimit,
      effectiveDate: feature.effectiveDate,
      notForNavigation: true,
      providerProperties: {
        sourceUrl: feature.sourceUrl,
        dataSource: feature.dataSource,
        timestamp: feature.timestamp,
        crc: feature.crc,
        sourcePurpose: "uas_geoawareness"
      }
    }
  };
}

export function uasGeozoneLicense() {
  return {
    name: "AIM/ANS CR UAS geographical zone dataset terms",
    attribution: "Řízení letového provozu České republiky, s.p. / AIM",
    commercialUse: "allowed_with_obligations" as const,
    operationalUse: "allowed_with_obligations" as const,
    notes: [
      "Datasets are published by ANS CR for UAS geoawareness under the published dataset terms.",
      "Reference .geojson files are the precise source for legally binding UAS geographical zone boundaries according to the AIM page.",
      "COM must display this as situational/reference information and preserve source attribution."
    ]
  };
}

async function requestText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,text/plain,*/*",
      "user-agent": "csm-sim-flight-data/0.1"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return response.text();
}

async function requestJson<T>(url: string, timeoutMs: number): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json,*/*",
      "user-agent": "csm-sim-flight-data/0.1"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return response.json() as Promise<T>;
}

function cleanString(value: unknown): string | undefined {
  const cleaned = typeof value === "string" ? value.trim() : undefined;
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}
