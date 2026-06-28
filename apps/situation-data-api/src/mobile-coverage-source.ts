import { Pool, type QueryResult } from "pg";
import { canonicalizeBboxForCache, formatBboxKey } from "./bbox-cache.js";
import type { SituationDataConfig } from "./config.js";
import { DemElevationSampler, type DemTileRef, type ElevationSample } from "./dem-elevation-sampler.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import { spatiallyLimitFeatures } from "./spatial-limit.js";
import type { SituationDataSource, SourceCacheStats } from "./sources.js";
import type {
  BoundingBox,
  MobileBtsStatus,
  MobileCoverageQuality,
  MobileCoverageTechnology,
  SituationDataLicense,
  SituationFeature,
  SituationQuery,
  SourceDescriptor,
  SourceFetchResult,
  SourceHealthStatus
} from "./types.js";

const MOBILE_COVERAGE_LICENSE: SituationDataLicense = {
  name: "Estimated mobile coverage model",
  attribution: "CSM SIM model; OpenStreetMap contributors for tower references",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Coverage is an estimate, not guaranteed service availability.",
    "Phase 1 uses OSM communications tower references and a distance-based path-loss approximation.",
    "OpenStreetMap-derived references require ODbL attribution and database obligations."
  ]
};

const TECHNOLOGIES: MobileCoverageTechnology[] = ["2G", "4G", "5G"];
const DEFAULT_TECHNOLOGIES: MobileCoverageTechnology[] = ["4G"];
const QUALITY_LEVELS: MobileCoverageQuality[] = ["good", "fair", "weak", "none", "unknown"];
const DISCLAIMER = "Coverage is an estimate, not guaranteed service availability.";
const RESOLUTION_STEPS_M = [250, 500, 1000, 2000, 5000, 10_000, 25_000, 50_000] as const;
const RECEIVER_HEIGHT_M = 1.5;
const DEFAULT_VIEWSHED_AZIMUTH_STEP_DEG = 10;
const DEFAULT_VIEWSHED_DISTANCE_STEP_M = 500;
const MAX_VIEWSHED_FEATURES = 2500;
const READ_MODEL_LOOKUP_WORK_MEM = "32MB";

interface TowerRow {
  osm_id: string;
  osm_type: string;
  name: string | null;
  lon: number | string;
  lat: number | string;
  tags: Record<string, unknown> | null;
}

interface CoverageCellRow {
  feature_id: string;
  model_version: string;
  technology: string;
  operator: string;
  quality: string;
  estimated_signal_dbm: number | string | null;
  confidence: number | string;
  resolution_m: number | string;
  dem_dataset_id: string | null;
  generated_at: Date | string;
  expires_at: Date | string;
  assumptions: Record<string, unknown> | null;
  metrics: Record<string, unknown> | null;
  tags: Record<string, unknown> | null;
  data_quality: string | null;
  bts_status: string | null;
  bts_status_source: string | null;
  operator_status_available: boolean | null;
  source_revision: string | null;
  grid_resolution_m: number | string | null;
  grid_row: number | string | null;
  grid_column: number | string | null;
  geometry: unknown;
}

export interface CoveragePayload {
  generatedAt: string;
  effectiveResolutionM: number;
  towerCount: number;
  terrainApplied: boolean;
  warnings: string[];
  features: SituationFeature[];
}

interface ReadModelLookup {
  features: SituationFeature[];
  warnings: string[];
  hit: boolean;
}

export interface MobileCoverageMetadata {
  layerId: "mobile_coverage";
  modelVersion: string;
  generatedAt: string;
  resolutionM: number;
  technologies: MobileCoverageTechnology[];
  operators: string[];
  qualityLevels: MobileCoverageQuality[];
  demSource: string;
  cacheTtlSeconds: number;
  disclaimer: string;
  assumptions: Record<string, string | number | boolean>;
}

export interface MobileCoverageViewshedOptions {
  towerId: string;
  technology?: MobileCoverageTechnology;
  radiusM?: number;
  azimuthStepDeg?: number;
  distanceStepM?: number;
  includeNoSignal?: boolean;
  includeRaw?: boolean;
}

export interface MobileCoverageViewshedPayload {
  contractVersion: "sim-mobile-coverage-tower-viewshed-v1";
  type: "FeatureCollection";
  generatedAt: string;
  source: {
    sourceId: "mobile_coverage_model";
    sourceType: "MODELLED_BTS_VIEWSHED";
    generatedAt: string;
  };
  tower: {
    towerId: string;
    lon: number;
    lat: number;
    name?: string;
    operator?: string;
    technologyHint?: string;
    btsStatus: MobileBtsStatus;
    btsStatusSource: "none";
    operatorStatusAvailable: false;
  };
  query: {
    technology: MobileCoverageTechnology;
    radiusM: number;
    azimuthStepDeg: number;
    distanceStepM: number;
    antennaHeightM: number;
    receiverHeightM: number;
    includeNoSignal: boolean;
  };
  summary: {
    featureCount: number;
    qualityCounts: Record<MobileCoverageQuality, number>;
    computedSectorCount: number;
    computedQualityCounts: Record<MobileCoverageQuality, number>;
    omittedNoSignalSectorCount: number;
    lineOfSightClearSectorCount: number;
    lineOfSightBlockedSectorCount: number;
    lineOfSightUnknownSectorCount: number;
    renderPolicy: ViewshedRenderPolicy;
    terrainAware: boolean;
    terrainApplied: boolean;
    demSource: string;
    warningCount: number;
    disclaimer: string;
  };
  features: SituationFeature[];
  warnings: string[];
}

interface NormalizedMobileCoverageViewshedOptions {
  towerId: string;
  technology: MobileCoverageTechnology;
  radiusM: number;
  azimuthStepDeg: number;
  distanceStepM: number;
  includeNoSignal: boolean;
  includeRaw: boolean;
}

export class MobileCoverageSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<CoveragePayload>;
  private readonly viewshedCache: ManagedResponseCache<MobileCoverageViewshedPayload | null>;
  private readonly towerCountCache: ManagedResponseCache<number>;
  private readonly readModelCountCache: ManagedResponseCache<number>;
  private readonly schemaCache: ManagedResponseCache<boolean>;
  private pool?: Pool;

  constructor(private readonly config: SituationDataConfig) {
    this.payloadCache = new ManagedResponseCache<CoveragePayload>({
      ttlMs: Math.max(60, config.mobileCoverageCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.mobileCoverageCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(64, Math.min(config.cacheMaxEntries, 4096))
    });
    this.viewshedCache = new ManagedResponseCache<MobileCoverageViewshedPayload | null>({
      ttlMs: Math.max(60, config.mobileCoverageCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.mobileCoverageCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(128, Math.min(config.cacheMaxEntries, 4096))
    });
    this.towerCountCache = new ManagedResponseCache<number>({
      ttlMs: 300_000,
      staleIfErrorMs: Math.max(300, config.staleIfErrorSeconds) * 1000,
      maxEntries: 2
    });
    this.readModelCountCache = new ManagedResponseCache<number>({
      ttlMs: 300_000,
      staleIfErrorMs: Math.max(300, config.staleIfErrorSeconds) * 1000,
      maxEntries: 2
    });
    this.schemaCache = new ManagedResponseCache<boolean>({
      ttlMs: 3_600_000,
      staleIfErrorMs: Math.max(300, config.staleIfErrorSeconds) * 1000,
      maxEntries: 1
    });
    this.descriptor = {
      sourceId: "mobile_coverage_model",
      label: "Mobile coverage estimate model",
      enabled: config.enabledSources.includes("mobile_coverage_model"),
      mode: "live",
      priority: 64,
      layers: ["mobile_coverage"],
      license: MOBILE_COVERAGE_LICENSE,
      baseUrl: publicPostgisBaseUrl(config.osmPostgisConnectionString),
      updateCadenceSeconds: config.mobileCoverageCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    const stats = mergeCacheStats([
      this.payloadCache.stats(),
      this.viewshedCache.stats(),
      this.towerCountCache.stats(),
      this.readModelCountCache.stats(),
      this.schemaCache.stats()
    ]);
    return [
      {
        sourceId: "mobile_coverage_model",
        ...stats
      }
    ];
  }

  async healthStatus(): Promise<SourceHealthStatus> {
    if (!this.config.osmPostgisConnectionString) {
      return {
        sourceId: "mobile_coverage_model",
        status: "degraded",
        backend: this.config.osmPostgisBackend,
        warnings: ["mobile_coverage_model requires OSM_POSTGIS_DATABASE_URL for tower references."]
      };
    }
    try {
      const objectCount = await this.towerCountCache.getOrLoad("tower-count", () => this.fetchTowerCount());
      const warnings: string[] = [];
      if (objectCount <= 0) {
        warnings.push("mobile_coverage_model has no communications_tower references.");
      }
      if (this.config.demEnabled && !this.config.mobileCoverageTerrainAware) {
        warnings.push("DEM catalog is available but coverage-v1 does not apply terrain line-of-sight yet.");
      }
      if (this.config.mobileCoverageReadModelEnabled) {
        const readModelCount = await this.readModelCountCache.getOrLoad("read-model-count", () => this.fetchReadModelCount()).catch(() => undefined);
        if (readModelCount === 0) {
          warnings.push("mobile_coverage_model read-model table is empty; runtime queries fall back to on-demand coverage calculation.");
        } else if (readModelCount === undefined) {
          warnings.push("mobile_coverage_model read-model table is not available yet; runtime queries fall back to on-demand coverage calculation.");
        }
      }
      return {
        sourceId: "mobile_coverage_model",
        status: objectCount > 0 ? "ok" : "degraded",
        backend: this.config.osmPostgisBackend,
        objectCount,
        warnings
      };
    } catch (error) {
      return {
        sourceId: "mobile_coverage_model",
        status: "degraded",
        backend: this.config.osmPostgisBackend,
        warnings: [error instanceof Error ? error.message : "Unknown mobile coverage health check failure."]
      };
    }
  }

  metadata(generatedAt = new Date().toISOString()): MobileCoverageMetadata {
    return {
      layerId: "mobile_coverage",
      modelVersion: this.config.mobileCoverageModelVersion,
      generatedAt,
      resolutionM: this.config.mobileCoverageResolutionM,
      technologies: TECHNOLOGIES,
      operators: ["unknown"],
      qualityLevels: QUALITY_LEVELS,
      demSource: this.effectiveDemSource(),
      cacheTtlSeconds: this.config.mobileCoverageCacheTtlSeconds,
      disclaimer: DISCLAIMER,
      assumptions: this.assumptions(false)
    };
  }

  async buildCoverageForBbox(bbox: BoundingBox, technologies: MobileCoverageTechnology[] = DEFAULT_TECHNOLOGIES): Promise<CoveragePayload> {
    return this.buildCoverage(bbox, technologies);
  }

  async buildTowerViewshed(options: MobileCoverageViewshedOptions): Promise<MobileCoverageViewshedPayload | undefined> {
    if (!this.config.osmPostgisConnectionString) {
      throw new Error("mobile_coverage_model requires OSM_POSTGIS_DATABASE_URL for tower viewshed.");
    }
    const normalized = normalizeViewshedOptions(options);
    const payload = await this.viewshedCache.getOrLoad(this.viewshedCacheKey(normalized), () => this.buildTowerViewshedUncached(normalized));
    return payload ?? undefined;
  }

  private async buildTowerViewshedUncached(options: NormalizedMobileCoverageViewshedOptions): Promise<MobileCoverageViewshedPayload | null> {
    const tower = await this.fetchTowerById(options.towerId);
    if (!tower) {
      return null;
    }

    const generatedAt = new Date().toISOString();
    const { technology, radiusM, azimuthStepDeg, distanceStepM, includeNoSignal } = options;
    const renderPolicy = includeNoSignal ? "diagnostic_all_sectors" : "coverage_only";
    const requestedSectorCount = Math.ceil(360 / azimuthStepDeg) * Math.ceil(radiusM / distanceStepM);
    const terrainSampler = this.createTerrainSampler();
    const demTiles = terrainSampler ? await terrainSampler.tilesForBbox(bboxAroundPoint(tower.lon, tower.lat, radiusM)) : [];
    const terrainApplied = Boolean(terrainSampler && demTiles.length > 0);
    const warnings =
      this.config.mobileCoverageTerrainAware && !terrainApplied
        ? ["mobile_coverage_model terrain-aware mode is enabled but DEM tiles are not available for the requested tower viewshed."]
        : [];
    const qualityCounts = emptyQualityCounts();
    const computedQualityCounts = emptyQualityCounts();
    let computedSectorCount = 0;
    let omittedNoSignalSectorCount = 0;
    let lineOfSightClearSectorCount = 0;
    let lineOfSightBlockedSectorCount = 0;
    let lineOfSightUnknownSectorCount = 0;
    const features: SituationFeature[] = [];

    for (let bearingDeg = 0; bearingDeg < 360 && computedSectorCount < MAX_VIEWSHED_FEATURES; bearingDeg += azimuthStepDeg) {
      const endBearingDeg = Math.min(360, bearingDeg + azimuthStepDeg);
      for (let innerRadiusM = 0; innerRadiusM < radiusM && computedSectorCount < MAX_VIEWSHED_FEATURES; innerRadiusM += distanceStepM) {
        computedSectorCount += 1;
        const outerRadiusM = Math.min(radiusM, innerRadiusM + distanceStepM);
        const sampleDistanceM = (innerRadiusM + outerRadiusM) / 2;
        const bearingCenterDeg = bearingDeg + (endBearingDeg - bearingDeg) / 2;
        const samplePoint = destinationPoint(tower.lon, tower.lat, bearingCenterDeg, sampleDistanceM);
        const nearest: NearestTower = {
          tower,
          distanceM: sampleDistanceM
        };
        const terrain =
          terrainSampler && demTiles.length > 0
            ? await terrainAssessment(terrainSampler, demTiles, nearest, samplePoint, this.config.mobileCoverageAntennaHeightM)
            : undefined;
        const estimate = estimateSignal(sampleDistanceM, technology, terrain?.penaltyDb);
        const quality = qualityForSignal(estimate.signalDbm);
        computedQualityCounts[quality] += 1;
        if (terrain?.lineOfSightClear === true) {
          lineOfSightClearSectorCount += 1;
        } else if (terrain?.lineOfSightClear === false) {
          lineOfSightBlockedSectorCount += 1;
        } else {
          lineOfSightUnknownSectorCount += 1;
        }

        if (!includeNoSignal && quality === "none") {
          omittedNoSignalSectorCount += 1;
          continue;
        }

        qualityCounts[quality] += 1;
        const confidence = confidenceForEstimate(sampleDistanceM, technology, terrain);
        const featureId = [
          "viewshed",
          "mobile",
          technology.toLowerCase(),
          sanitizeFeatureId(tower.id),
          `a${Math.round(bearingDeg)}`,
          `r${Math.round(outerRadiusM)}`
        ].join(":");
        const display = viewshedDisplayProperties({
          technology,
          quality,
          signalDbm: estimate.signalDbm,
          terrain,
          innerRadiusM,
          outerRadiusM,
          renderPolicy,
          includeNoSignal
        });

        features.push({
          type: "Feature",
          id: featureId,
          geometry: {
            type: "Polygon",
            coordinates: [sectorPolygon(tower.lon, tower.lat, bearingDeg, endBearingDeg, innerRadiusM, outerRadiusM)]
          },
          properties: {
            featureId,
            layer: "mobile_coverage",
            category: "mobile_coverage_viewshed",
            label: `${technology} estimated BTS radio reach`,
            sourceId: "mobile_coverage_model",
            observedAt: generatedAt,
            confidence,
            stale: false,
            severity: severityForQuality(quality),
            license: {
              name: MOBILE_COVERAGE_LICENSE.name,
              attribution: MOBILE_COVERAGE_LICENSE.attribution
            },
            metrics: compactMetrics({
              bearingDeg: round(bearingCenterDeg, 2),
              startBearingDeg: round(bearingDeg, 2),
              endBearingDeg: round(endBearingDeg, 2),
              innerRadiusM: Math.round(innerRadiusM),
              outerRadiusM: Math.round(outerRadiusM),
              distanceM: Math.round(sampleDistanceM),
              baseSignalDbm: estimate.baseSignalDbm,
              terrainPenaltyDb: terrain?.penaltyDb,
              terrainMaxObstructionM: terrain?.maxObstructionM,
              terrainSamples: terrain?.sampleCount,
              lineOfSightClear: terrain?.lineOfSightClear,
              towerElevationM: terrain?.towerElevationM,
              targetElevationM: terrain?.targetElevationM,
              targetLon: round(samplePoint.lon, 6),
              targetLat: round(samplePoint.lat, 6)
            }),
            tags: compactTags({
              towerId: tower.id,
              towerName: tower.name,
              towerOperator: tower.operator,
              towerTechnologyHint: tower.technologyHint,
              btsStatus: "operator_feed_unavailable",
              renderAs: "coverage_sector",
              renderPolicy,
              coverageVisible: quality === "none" ? "false" : "true",
              lineOfSight: terrain ? (terrain.lineOfSightClear ? "clear" : "blocked") : "not_evaluated"
            }),
            rendering: {
              mode: "feature",
              geometryRole: "feature_geometry",
              opacity: display.style.fillOpacity
            },
            providerProperties: {
              display
            },
            operator: tower.operator ?? "unknown",
            technology,
            quality,
            estimatedSignalDbm: estimate.signalDbm,
            modelVersion: `${this.config.mobileCoverageModelVersion}+tower-viewshed-v1`,
            sourceRevision: this.viewshedSourceRevision(terrainApplied),
            readModel: false,
            generatedAt,
            resolutionM: distanceStepM,
            demSource: this.effectiveDemSource(Boolean(terrain)),
            assumptions: this.viewshedAssumptions(Boolean(terrain), radiusM, azimuthStepDeg, distanceStepM),
            dataQuality: "modelled",
            btsStatus: "operator_feed_unavailable",
            btsStatusSource: "none",
            operatorStatusAvailable: false,
            disclaimer: DISCLAIMER,
            raw: options.includeRaw
              ? {
                  tower,
                  terrain,
                  phase: terrain ? "tower-viewshed-terrain-aware-distance-model" : "tower-viewshed-distance-model"
                }
              : undefined
          }
        });
      }
    }

    if (computedSectorCount < requestedSectorCount) {
      warnings.push("mobile_coverage_model tower viewshed reached the sector calculation cap; increase step sizes or reduce radius for complete output.");
    }

    return {
      contractVersion: "sim-mobile-coverage-tower-viewshed-v1",
      type: "FeatureCollection",
      generatedAt,
      source: {
        sourceId: "mobile_coverage_model",
        sourceType: "MODELLED_BTS_VIEWSHED",
        generatedAt
      },
      tower: {
        towerId: tower.id,
        lon: tower.lon,
        lat: tower.lat,
        ...(tower.name ? { name: tower.name } : {}),
        ...(tower.operator ? { operator: tower.operator } : {}),
        ...(tower.technologyHint ? { technologyHint: tower.technologyHint } : {}),
        btsStatus: "operator_feed_unavailable",
        btsStatusSource: "none",
        operatorStatusAvailable: false
      },
      query: {
        technology,
        radiusM,
        azimuthStepDeg,
        distanceStepM,
        antennaHeightM: this.config.mobileCoverageAntennaHeightM,
        receiverHeightM: RECEIVER_HEIGHT_M,
        includeNoSignal
      },
      summary: {
        featureCount: features.length,
        qualityCounts,
        computedSectorCount,
        computedQualityCounts,
        omittedNoSignalSectorCount,
        lineOfSightClearSectorCount,
        lineOfSightBlockedSectorCount,
        lineOfSightUnknownSectorCount,
        renderPolicy,
        terrainAware: this.config.mobileCoverageTerrainAware,
        terrainApplied,
        demSource: this.effectiveDemSource(terrainApplied),
        warningCount: warnings.length,
        disclaimer: DISCLAIMER
      },
      features,
      warnings
    };
  }

  async ensureReadModelSchema(): Promise<void> {
    const table = quoteQualifiedIdentifier(this.config.mobileCoverageReadModelTable);
    await this.getPool().query(`
      create extension if not exists postgis;

      create table if not exists ${table} (
        dataset_id text,
        model_version text not null,
        technology text not null,
        operator text not null default 'unknown',
        quality text not null,
        estimated_signal_dbm integer,
        confidence double precision not null,
        resolution_m integer not null,
        dem_dataset_id text,
        generated_at timestamptz not null,
        expires_at timestamptz not null,
        assumptions jsonb not null default '{}'::jsonb,
        metrics jsonb not null default '{}'::jsonb,
        tags jsonb not null default '{}'::jsonb,
        data_quality text not null default 'modelled',
        bts_status text not null default 'operator_feed_unavailable',
        bts_status_source text not null default 'none',
        operator_status_available boolean not null default false,
        source_revision text,
        grid_resolution_m integer,
        grid_row integer,
        grid_column integer,
        bbox_west double precision,
        bbox_south double precision,
        bbox_east double precision,
        bbox_north double precision,
        geom geometry(Polygon, 4326) not null,
        feature_id text primary key
      );

      alter table ${table} add column if not exists metrics jsonb not null default '{}'::jsonb;
      alter table ${table} add column if not exists tags jsonb not null default '{}'::jsonb;
      alter table ${table} add column if not exists data_quality text not null default 'modelled';
      alter table ${table} add column if not exists bts_status text not null default 'operator_feed_unavailable';
      alter table ${table} add column if not exists bts_status_source text not null default 'none';
      alter table ${table} add column if not exists operator_status_available boolean not null default false;
      alter table ${table} add column if not exists source_revision text;
      alter table ${table} add column if not exists grid_resolution_m integer;
      alter table ${table} add column if not exists grid_row integer;
      alter table ${table} add column if not exists grid_column integer;
      alter table ${table} add column if not exists bbox_west double precision;
      alter table ${table} add column if not exists bbox_south double precision;
      alter table ${table} add column if not exists bbox_east double precision;
      alter table ${table} add column if not exists bbox_north double precision;

      update ${table}
      set
        grid_resolution_m = nullif(substring(feature_id from 'm([0-9]+)-r'), '')::integer,
        grid_row = nullif(substring(feature_id from '-r(-?[0-9]+)-c'), '')::integer,
        grid_column = nullif(substring(feature_id from '-c(-?[0-9]+)$'), '')::integer
      where (grid_resolution_m is null or grid_row is null or grid_column is null)
        and feature_id ~ 'm[0-9]+-r-?[0-9]+-c-?[0-9]+$';

      update ${table}
      set
        bbox_west = st_xmin(box3d(geom)),
        bbox_south = st_ymin(box3d(geom)),
        bbox_east = st_xmax(box3d(geom)),
        bbox_north = st_ymax(box3d(geom))
      where bbox_west is null
        or bbox_south is null
        or bbox_east is null
        or bbox_north is null;

      create index if not exists mobile_coverage_cells_geom_gix on ${table} using gist (geom);
      create index if not exists mobile_coverage_cells_model_idx on ${table}(model_version, technology, operator);
      create index if not exists mobile_coverage_cells_expires_idx on ${table}(expires_at);
      create index if not exists mobile_coverage_cells_generated_idx on ${table}(generated_at);
      create index if not exists mobile_coverage_cells_grid_idx on ${table}(model_version, technology, operator, grid_resolution_m, grid_row, grid_column);
      create index if not exists mobile_coverage_cells_lookup_idx on ${table}(
        model_version,
        technology,
        operator,
        grid_resolution_m,
        bbox_west,
        bbox_east,
        bbox_south,
        bbox_north,
        grid_row,
        grid_column
      ) include (feature_id, quality, confidence, generated_at, expires_at)
      where grid_resolution_m is not null
        and grid_row is not null
        and grid_column is not null
        and bbox_west is not null
        and bbox_south is not null
        and bbox_east is not null
        and bbox_north is not null;
      create index if not exists mobile_coverage_cells_candidate_idx on ${table}(
        model_version,
        technology,
        operator,
        grid_resolution_m
      ) include (
        feature_id,
        quality,
        confidence,
        generated_at,
        expires_at,
        grid_row,
        grid_column,
        bbox_west,
        bbox_east,
        bbox_south,
        bbox_north
      )
      where grid_resolution_m is not null
        and grid_row is not null
        and grid_column is not null
        and bbox_west is not null
        and bbox_south is not null
        and bbox_east is not null
        and bbox_north is not null;
    `);
  }

  private async ensureReadModelSchemaCached(): Promise<void> {
    await this.schemaCache.getOrLoad("read-model-schema", async () => {
      await this.ensureReadModelSchema();
      return true;
    });
  }

  async replaceReadModelFeatures(
    bbox: BoundingBox,
    technologies: MobileCoverageTechnology[] = DEFAULT_TECHNOLOGIES,
    expiresAt = addSeconds(
      new Date().toISOString(),
      Math.max(this.config.mobileCoverageReadModelMaxAgeSeconds, this.config.mobileCoverageCacheTtlSeconds)
    )
  ): Promise<number> {
    await this.ensureReadModelSchemaCached();
    const payload = await this.buildCoverage(bbox, technologies);
    const table = quoteQualifiedIdentifier(this.config.mobileCoverageReadModelTable);
    let written = 0;
    await this.getPool().query(
      `
        delete from ${table}
        where model_version = $1
          and technology = any($2::text[])
          and operator = 'unknown'
          and geom && st_makeenvelope($3, $4, $5, $6, 4326)
          and st_intersects(geom, st_makeenvelope($3, $4, $5, $6, 4326))
      `,
      [this.config.mobileCoverageModelVersion, technologies, bbox.west, bbox.south, bbox.east, bbox.north]
    );

    for (const feature of payload.features) {
      const gridCell = parseCoverageGridFeatureId(String(feature.properties.featureId ?? feature.id ?? ""));
      const cellBbox = polygonFeatureBbox(feature);
      if (!cellBbox) {
        continue;
      }
      await this.getPool().query(
        `
          insert into ${table} (
            dataset_id,
            model_version,
            technology,
            operator,
            quality,
            estimated_signal_dbm,
            confidence,
            resolution_m,
            dem_dataset_id,
            generated_at,
            expires_at,
            assumptions,
            metrics,
            tags,
            data_quality,
            bts_status,
            bts_status_source,
            operator_status_available,
            source_revision,
            grid_resolution_m,
            grid_row,
            grid_column,
            bbox_west,
            bbox_south,
            bbox_east,
            bbox_north,
            geom,
            feature_id
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz,
            $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19,
            $20, $21, $22, $23, $24, $25, $26,
            st_setsrid(st_geomfromgeojson($27), 4326),
            $28
          )
          on conflict (feature_id) do update set
            dataset_id = excluded.dataset_id,
            model_version = excluded.model_version,
            technology = excluded.technology,
            operator = excluded.operator,
            quality = excluded.quality,
            estimated_signal_dbm = excluded.estimated_signal_dbm,
            confidence = excluded.confidence,
            resolution_m = excluded.resolution_m,
            dem_dataset_id = excluded.dem_dataset_id,
            generated_at = excluded.generated_at,
            expires_at = excluded.expires_at,
            assumptions = excluded.assumptions,
            metrics = excluded.metrics,
            tags = excluded.tags,
            data_quality = excluded.data_quality,
            bts_status = excluded.bts_status,
            bts_status_source = excluded.bts_status_source,
            operator_status_available = excluded.operator_status_available,
            source_revision = excluded.source_revision,
            grid_resolution_m = excluded.grid_resolution_m,
            grid_row = excluded.grid_row,
            grid_column = excluded.grid_column,
            bbox_west = excluded.bbox_west,
            bbox_south = excluded.bbox_south,
            bbox_east = excluded.bbox_east,
            bbox_north = excluded.bbox_north,
            geom = excluded.geom
        `,
        [
          "osm_postgis",
          feature.properties.modelVersion ?? this.config.mobileCoverageModelVersion,
          feature.properties.technology ?? "unknown",
          feature.properties.operator ?? "unknown",
          feature.properties.quality ?? "unknown",
          feature.properties.estimatedSignalDbm ?? null,
          feature.properties.confidence,
          feature.properties.resolutionM ?? this.config.mobileCoverageResolutionM,
          feature.properties.demSource ?? this.config.demDatasetId,
          feature.properties.generatedAt ?? feature.properties.observedAt,
          expiresAt,
          JSON.stringify(feature.properties.assumptions ?? {}),
          JSON.stringify(feature.properties.metrics ?? {}),
          JSON.stringify(feature.properties.tags ?? {}),
          feature.properties.dataQuality ?? "modelled",
          feature.properties.btsStatus ?? "operator_feed_unavailable",
          feature.properties.btsStatusSource ?? "none",
          feature.properties.operatorStatusAvailable ?? false,
          feature.properties.sourceRevision ?? this.sourceRevision(Boolean(feature.properties.assumptions?.terrainApplied)),
          gridCell?.resolutionM ?? feature.properties.resolutionM ?? this.config.mobileCoverageResolutionM,
          gridCell?.row ?? null,
          gridCell?.column ?? null,
          cellBbox.west,
          cellBbox.south,
          cellBbox.east,
          cellBbox.north,
          JSON.stringify(feature.geometry),
          feature.properties.featureId
        ]
      );
      written += 1;
    }

    return written;
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("mobile_coverage")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }
    if (!this.config.osmPostgisConnectionString) {
      return {
        source: this.descriptor,
        fetchedAt,
        features: [],
        warnings: ["mobile_coverage_model requires OSM_POSTGIS_DATABASE_URL for tower references."]
      };
    }

    const technologies = query.mobileCoverageTechnologies?.length ? query.mobileCoverageTechnologies : DEFAULT_TECHNOLOGIES;
    const operators = query.mobileCoverageOperators?.length ? query.mobileCoverageOperators : ["unknown"];
    const readModel = await this.fetchReadModelFeatures(query, technologies, operators);
    if (readModel.hit) {
      const features = readModel.features.map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          raw: query.includeRaw ? feature.properties.raw : undefined
        }
      }));

      return {
        source: this.descriptor,
        fetchedAt,
        features,
        warnings: readModel.warnings
      };
    }

    if (!operators.includes("unknown")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const cacheBbox = canonicalizeBboxForCache(query.bbox, this.config.bboxCachePaddingDegrees);
    const cacheKey = JSON.stringify({
      bbox: formatBboxKey(cacheBbox),
      technologies,
      operators: ["unknown"],
      resolutionM: this.config.mobileCoverageResolutionM,
      maxCells: this.config.mobileCoverageMaxCells,
      modelVersion: this.config.mobileCoverageModelVersion,
      readModelFallback: true
    });
    const payload = await this.payloadCache.getOrLoad(cacheKey, () => this.buildCoverage(cacheBbox, technologies));
    const features = spatiallyLimitFeatures(
      payload.features.filter((feature) => featureIntersectsBbox(feature, query.bbox)),
      query.limit,
      query.bbox
    ).map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          raw: query.includeRaw ? feature.properties.raw : undefined
        }
      }));

    return {
      source: this.descriptor,
      fetchedAt,
      features,
      warnings: [
        ...payload.warnings,
        ...(payload.towerCount > 0
          ? []
          : ["mobile_coverage_model has no communications_tower references in the requested area; features are marked unknown."])
      ]
    };
  }

  private async fetchReadModelFeatures(
    query: SituationQuery,
    technologies: MobileCoverageTechnology[],
    operators: string[]
  ): Promise<ReadModelLookup> {
    if (!this.config.mobileCoverageReadModelEnabled || !this.config.osmPostgisConnectionString) {
      return { features: [], warnings: [], hit: false };
    }
    const table = quoteQualifiedIdentifier(this.config.mobileCoverageReadModelTable);
    const normalizedOperators = operators.includes("aggregate") ? ["unknown"] : operators;
    try {
      await this.ensureReadModelSchemaCached();
      const client = await this.getPool().connect();
      let result: QueryResult<CoverageCellRow> | undefined;
      try {
        await client.query("begin");
        await client.query(`set local work_mem = '${READ_MODEL_LOOKUP_WORK_MEM}'`);
        result = await client.query<CoverageCellRow>(
          `
          with constants as (
            select greatest(1, ceil(sqrt($9::double precision))::int) as bucket_count
          ),
          candidate_keys as (
            select
              feature_id,
              quality,
              confidence,
              generated_at,
              grid_row,
              grid_column
            from ${table}
            where model_version = $1
              and technology = any($2::text[])
              and operator = any($3::text[])
              and expires_at > now()
              and ($4::int <= 0 or generated_at >= now() - make_interval(secs => $4::int))
              and grid_resolution_m = $10::int
              and grid_row is not null
              and grid_column is not null
              and bbox_west is not null
              and bbox_south is not null
              and bbox_east is not null
              and bbox_north is not null
              and bbox_west <= $7::double precision
              and bbox_east >= $5::double precision
              and bbox_south <= $8::double precision
              and bbox_north >= $6::double precision
          ),
          extents as (
            select
              min(grid_column) as min_column,
              max(grid_column) as max_column,
              min(grid_row) as min_row,
              max(grid_row) as max_row
            from candidate_keys
          ),
          bucketed as (
            select
              candidate_keys.*,
              least(
                constants.bucket_count - 1,
                greatest(
                  0,
                  floor(
                    ((grid_column - extents.min_column)::double precision / nullif(extents.max_column - extents.min_column + 1, 0))
                    * constants.bucket_count
                  )::int
                )
              ) as bucket_x,
              least(
                constants.bucket_count - 1,
                greatest(
                  0,
                  floor(
                    ((grid_row - extents.min_row)::double precision / nullif(extents.max_row - extents.min_row + 1, 0))
                    * constants.bucket_count
                  )::int
                )
              ) as bucket_y
            from candidate_keys, constants, extents
          ),
          ranked_keys as (
            select
              distinct on (bucket_y, bucket_x)
              *
            from bucketed
            order by
              bucket_y,
              bucket_x,
              case quality
                when 'good' then 5
                when 'fair' then 4
                when 'weak' then 3
                when 'unknown' then 2
                when 'none' then 1
                else 0
              end desc,
              confidence desc,
              generated_at desc,
              feature_id asc
          ),
          limited_keys as (
            select feature_id
            from ranked_keys
            order by bucket_y asc, bucket_x asc, feature_id asc
            limit $9
          )
          select
            cells.feature_id,
            cells.model_version,
            cells.technology,
            cells.operator,
            cells.quality,
            cells.estimated_signal_dbm,
            cells.confidence,
            cells.resolution_m,
            cells.dem_dataset_id,
            cells.generated_at,
            cells.expires_at,
            cells.assumptions,
            cells.metrics,
            cells.tags,
            cells.data_quality,
            cells.bts_status,
            cells.bts_status_source,
            cells.operator_status_available,
            cells.source_revision,
            cells.grid_resolution_m,
            cells.grid_row,
            cells.grid_column,
            st_asgeojson(cells.geom)::json as geometry
          from limited_keys
          join ${table} cells on cells.feature_id = limited_keys.feature_id
          order by cells.grid_row asc, cells.grid_column asc, cells.feature_id asc
        `,
        [
          this.config.mobileCoverageModelVersion,
          technologies,
          normalizedOperators,
          this.config.mobileCoverageReadModelMaxAgeSeconds,
          query.bbox.west,
          query.bbox.south,
          query.bbox.east,
          query.bbox.north,
          Math.max(1, query.limit),
          this.config.mobileCoverageResolutionM
        ]
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      if (!result) {
        return { features: [], warnings: ["mobile_coverage_model read-model lookup did not return a result."], hit: false };
      }
      if (result.rows.length === 0) {
        return { features: [], warnings: [], hit: false };
      }
      const features = result.rows.flatMap((row) => {
        const feature = this.readModelFeature(row);
        return feature ? [feature] : [];
      });
      return {
        features,
        warnings: [],
        hit: features.length > 0
      };
    } catch (error) {
      if (isMissingRelationError(error)) {
        return { features: [], warnings: [], hit: false };
      }
      return {
        features: [],
        warnings: [`mobile_coverage_model read-model lookup failed; using on-demand model: ${errorMessage(error)}`],
        hit: false
      };
    }
  }

  private readModelFeature(row: CoverageCellRow): SituationFeature | undefined {
    const technology = mobileCoverageTechnology(row.technology);
    const quality = mobileCoverageQuality(row.quality);
    if (!technology || !quality || !isPolygonGeometry(row.geometry)) {
      return undefined;
    }
    const generatedAt = toIsoTimestamp(row.generated_at);
    const validUntil = toIsoTimestamp(row.expires_at);
    const metrics = compactMixedMetrics(row.metrics);
    const sourceTags = compactStringTags(row.tags) ?? {};
    const signalDbm = optionalNumber(row.estimated_signal_dbm);
    const resolutionM = optionalNumber(row.resolution_m);
    const display = coverageDisplayProperties({
      technology,
      quality,
      signalDbm,
      metrics,
      readModel: true,
      resolutionM
    });
    return {
      type: "Feature",
      id: row.feature_id,
      geometry: row.geometry,
      properties: {
        featureId: row.feature_id,
        layer: "mobile_coverage",
        category: "mobile_coverage",
        label: `${technology} coverage estimate`,
        sourceId: "mobile_coverage_model",
        observedAt: generatedAt,
        validUntil,
        confidence: Number(row.confidence),
        stale: false,
        severity: severityForQuality(quality),
        license: {
          name: MOBILE_COVERAGE_LICENSE.name,
          attribution: MOBILE_COVERAGE_LICENSE.attribution
        },
        metrics,
        tags: compactTags({
          ...sourceTags,
          renderAs: "coverage_grid_cell",
          renderPolicy: "quality_fill"
        }),
        rendering: {
          mode: "feature",
          geometryRole: "grid_cell",
          opacity: display.style.fillOpacity
        },
        styleHint: "mobile-coverage-diagnostic-v1",
        providerProperties: {
          display
        },
        operator: row.operator,
        technology,
        quality,
        estimatedSignalDbm: signalDbm,
        modelVersion: row.model_version,
        sourceRevision: cleanString(row.source_revision),
        readModel: true,
        generatedAt,
        resolutionM,
        demSource: cleanString(row.dem_dataset_id) ?? this.effectiveDemSource(true),
        assumptions: compactAssumptions(row.assumptions),
        dataQuality: row.data_quality === "observed" || row.data_quality === "mixed" || row.data_quality === "unknown" ? row.data_quality : "modelled",
        btsStatus: mobileBtsStatus(row.bts_status),
        btsStatusSource: cleanString(row.bts_status_source) ?? "none",
        operatorStatusAvailable: row.operator_status_available === true,
        disclaimer: DISCLAIMER
      }
    };
  }

  private async buildCoverage(bbox: BoundingBox, technologies: MobileCoverageTechnology[]): Promise<CoveragePayload> {
    const generatedAt = new Date().toISOString();
    const maxCells = Math.max(1, Math.floor(this.config.mobileCoverageMaxCells / Math.max(1, technologies.length)));
    const maxFeatures = Math.max(1, this.config.mobileCoverageMaxCells);
    const grid = buildGrid(bbox, this.config.mobileCoverageResolutionM, maxCells);
    const towers = await this.fetchTowers(expandBboxByMeters(bbox, 30_000), 10_000);
    const terrainSampler = this.createTerrainSampler();
    const demTiles = terrainSampler ? await terrainSampler.tilesForBbox(expandBboxByMeters(bbox, 30_000)) : [];
    const terrainApplied = Boolean(terrainSampler && demTiles.length > 0);
    const warnings =
      this.config.mobileCoverageTerrainAware && !terrainApplied
        ? ["mobile_coverage_model terrain-aware mode is enabled but DEM tiles are not available for the requested area."]
        : [];
    const features: SituationFeature[] = [];

    for (const cell of grid.cells) {
      const nearest = nearestTower(cell.center, towers);
      for (const technology of technologies) {
        if (features.length >= maxFeatures) {
          break;
        }
        features.push(await this.coverageFeature(cell, nearest, technology, generatedAt, grid.resolutionM, terrainSampler, demTiles));
      }
      if (features.length >= maxFeatures) {
        break;
      }
    }

    return {
      generatedAt,
      effectiveResolutionM: grid.resolutionM,
      towerCount: towers.length,
      terrainApplied,
      warnings,
      features
    };
  }

  private async coverageFeature(
    cell: CoverageCell,
    nearest: NearestTower | undefined,
    technology: MobileCoverageTechnology,
    generatedAt: string,
    resolutionM: number,
    terrainSampler: DemElevationSampler | undefined,
    demTiles: DemTileRef[]
  ): Promise<SituationFeature> {
    const terrain = nearest && terrainSampler && demTiles.length > 0 ? await terrainAssessment(terrainSampler, demTiles, nearest, cell.center, this.config.mobileCoverageAntennaHeightM) : undefined;
    const estimate = nearest ? estimateSignal(nearest.distanceM, technology, terrain?.penaltyDb) : undefined;
    const quality = estimate ? qualityForSignal(estimate.signalDbm) : "unknown";
    const confidence = estimate && nearest ? confidenceForEstimate(nearest.distanceM, technology, terrain) : 0.2;
    const featureId = `coverage:mobile:${technology.toLowerCase()}:${cell.id}`;
    const metrics = compactMetrics({
      distanceToNearestTowerM: nearest ? Math.round(nearest.distanceM) : undefined,
      nearestTowerLon: nearest?.tower.lon,
      nearestTowerLat: nearest?.tower.lat,
      baseSignalDbm: estimate?.baseSignalDbm,
      terrainPenaltyDb: terrain?.penaltyDb,
      terrainMaxObstructionM: terrain?.maxObstructionM,
      terrainSamples: terrain?.sampleCount,
      towerElevationM: terrain?.towerElevationM,
      targetElevationM: terrain?.targetElevationM
    });
    const display = coverageDisplayProperties({
      technology,
      quality,
      signalDbm: estimate?.signalDbm,
      metrics,
      readModel: false,
      resolutionM
    });
    return {
      type: "Feature",
      id: featureId,
      geometry: {
        type: "Polygon",
        coordinates: [cell.coordinates]
      },
      properties: {
        featureId,
        layer: "mobile_coverage",
        category: "mobile_coverage",
        label: `${technology} coverage estimate`,
        sourceId: "mobile_coverage_model",
        observedAt: generatedAt,
        confidence,
        stale: false,
        severity: severityForQuality(quality),
        license: {
          name: MOBILE_COVERAGE_LICENSE.name,
          attribution: MOBILE_COVERAGE_LICENSE.attribution
        },
        metrics,
        tags: compactTags({
          nearestTowerId: nearest?.tower.id,
          nearestTowerName: nearest?.tower.name,
          nearestTowerOperator: nearest?.tower.operator,
          nearestTowerTechnologyHint: nearest?.tower.technologyHint,
          renderAs: "coverage_grid_cell",
          renderPolicy: "quality_fill"
        }),
        rendering: {
          mode: "feature",
          geometryRole: "grid_cell",
          opacity: display.style.fillOpacity
        },
        styleHint: "mobile-coverage-diagnostic-v1",
        providerProperties: {
          display
        },
        operator: "unknown",
        technology,
        quality,
        estimatedSignalDbm: estimate?.signalDbm,
        modelVersion: this.config.mobileCoverageModelVersion,
        sourceRevision: this.sourceRevision(Boolean(terrain)),
        readModel: false,
        generatedAt,
        resolutionM,
        demSource: this.effectiveDemSource(Boolean(terrain)),
        assumptions: this.assumptions(Boolean(terrain)),
        dataQuality: "modelled",
        btsStatus: "operator_feed_unavailable",
        btsStatusSource: "none",
        operatorStatusAvailable: false,
        disclaimer: DISCLAIMER,
        raw: {
          nearestTower: nearest,
          terrain,
          phase: terrain ? "phase-2-terrain-aware-distance-model" : "phase-1-distance-model"
        }
      }
    };
  }

  private assumptions(terrainApplied: boolean): Record<string, string | number | boolean> {
    return {
      antennaHeightM: this.config.mobileCoverageAntennaHeightM,
      receiverHeightM: RECEIVER_HEIGHT_M,
      propagationModel: terrainApplied ? "distance-path-loss-lite+terrain-los-v1" : "distance-path-loss-lite",
      terrainAware: this.config.mobileCoverageTerrainAware,
      terrainDataAvailable: this.config.demEnabled,
      terrainApplied,
      demDatasetId: this.config.demDatasetId,
      landCoverAware: false,
      btsRealtimeStatus: false
    };
  }

  private sourceRevision(terrainApplied: boolean): string {
    return [
      `model=${this.config.mobileCoverageModelVersion}`,
      `osmTable=${this.config.osmPostgisTable}`,
      `dem=${terrainApplied ? this.config.demDatasetId : "not-applied"}`,
      `terrain=${terrainApplied ? "line-of-sight-v1" : "none"}`,
      `resolutionM=${this.config.mobileCoverageResolutionM}`,
      `antennaM=${this.config.mobileCoverageAntennaHeightM}`
    ].join("|");
  }

  private viewshedSourceRevision(terrainApplied: boolean): string {
    return `${this.sourceRevision(terrainApplied)}|viewshed=tower-radial-v1`;
  }

  private viewshedAssumptions(
    terrainApplied: boolean,
    radiusM: number,
    azimuthStepDeg: number,
    distanceStepM: number
  ): Record<string, string | number | boolean> {
    return {
      ...this.assumptions(terrainApplied),
      viewshedModel: "tower-radial-v1",
      radiusM,
      azimuthStepDeg,
      distanceStepM,
      sectorAware: false,
      buildingAware: false,
      vegetationAware: false,
      operatorRfPlanAvailable: false
    };
  }

  private effectiveDemSource(terrainApplied = false): string {
    if (terrainApplied) {
      return this.config.mobileCoverageDemSource === "not-used-phase-1" ? this.config.demDatasetId : this.config.mobileCoverageDemSource;
    }
    if (this.config.mobileCoverageTerrainAware && this.config.demEnabled) {
      return `${this.config.demDatasetId} available; terrain sampling requested but not applied`;
    }
    if (this.config.demEnabled) {
      return `${this.config.demDatasetId} available; not applied by coverage-v1`;
    }
    return this.config.mobileCoverageDemSource;
  }

  private createTerrainSampler(): DemElevationSampler | undefined {
    if (!this.config.mobileCoverageTerrainAware || !this.config.demEnabled || !this.config.demPostgisConnectionString) {
      return undefined;
    }
    return new DemElevationSampler(this.config);
  }

  private viewshedCacheKey(options: NormalizedMobileCoverageViewshedOptions): string {
    return JSON.stringify({
      towerId: options.towerId,
      technology: options.technology,
      radiusM: options.radiusM,
      azimuthStepDeg: options.azimuthStepDeg,
      distanceStepM: options.distanceStepM,
      includeNoSignal: options.includeNoSignal,
      includeRaw: options.includeRaw,
      modelVersion: this.config.mobileCoverageModelVersion,
      osmTable: this.config.osmPostgisTable,
      terrainAware: this.config.mobileCoverageTerrainAware,
      demEnabled: this.config.demEnabled,
      demDatasetId: this.config.demDatasetId,
      antennaHeightM: this.config.mobileCoverageAntennaHeightM,
      receiverHeightM: RECEIVER_HEIGHT_M
    });
  }

  private async fetchTowerCount(): Promise<number> {
    const table = quoteQualifiedIdentifier(this.config.osmPostgisTable);
    const result = await this.getPool().query<{ count: string }>(
      `select count(*)::bigint as count from ${table} where layer = 'mobile' and category = 'communications_tower'`
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async fetchTowerById(towerId: string): Promise<Tower | undefined> {
    const parsed = parseTowerId(towerId);
    if (!parsed) {
      return undefined;
    }
    const table = quoteQualifiedIdentifier(this.config.osmPostgisTable);
    const result = await this.getPool().query<TowerRow>(
      `
        select
          osm_id::text,
          osm_type,
          name,
          lon,
          lat,
          tags
        from ${table}
        where osm_type = $1
          and osm_id::text = $2
          and layer = 'mobile'
          and category = 'communications_tower'
        limit 1
      `,
      [parsed.osmType, parsed.osmId]
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    const lon = optionalNumber(row.lon);
    const lat = optionalNumber(row.lat);
    if (lon === undefined || lat === undefined) {
      return undefined;
    }
    return {
      id: `${row.osm_type}:${row.osm_id}`,
      name: cleanString(row.name),
      lon,
      lat,
      operator: towerOperator(row.tags),
      technologyHint: towerTechnologyHint(row.tags)
    };
  }

  private async fetchReadModelCount(): Promise<number> {
    await this.ensureReadModelSchemaCached();
    const table = quoteQualifiedIdentifier(this.config.mobileCoverageReadModelTable);
    const result = await this.getPool().query<{ count: string }>(
      `
        select count(*)::bigint as count
        from ${table}
        where model_version = $1
          and expires_at > now()
          and ($2::int <= 0 or generated_at >= now() - make_interval(secs => $2::int))
      `,
      [this.config.mobileCoverageModelVersion, this.config.mobileCoverageReadModelMaxAgeSeconds]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async fetchTowers(bbox: BoundingBox, limit: number): Promise<Tower[]> {
    const table = quoteQualifiedIdentifier(this.config.osmPostgisTable);
    const sql = `
      select
        osm_id::text,
        osm_type,
        name,
        lon,
        lat,
        tags
      from ${table}
      where geom && st_makeenvelope($1, $2, $3, $4, 4326)
        and layer = 'mobile'
        and category = 'communications_tower'
      limit $5
    `;
    const result = await this.getPool().query<TowerRow>(sql, [bbox.west, bbox.south, bbox.east, bbox.north, Math.max(1, limit)]);
    return result.rows.flatMap((row) => {
      const lon = optionalNumber(row.lon);
      const lat = optionalNumber(row.lat);
      if (lon === undefined || lat === undefined) {
        return [];
      }
      return [
        {
          id: `${row.osm_type}:${row.osm_id}`,
          name: cleanString(row.name),
          lon,
          lat,
          operator: towerOperator(row.tags),
          technologyHint: towerTechnologyHint(row.tags)
        }
      ];
    });
  }

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.config.osmPostgisConnectionString,
        max: 4,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: this.config.requestTimeoutMs
      });
    }
    return this.pool;
  }
}

interface Tower {
  id: string;
  name?: string;
  lon: number;
  lat: number;
  operator?: string;
  technologyHint?: string;
}

interface NearestTower {
  tower: Tower;
  distanceM: number;
}

interface TerrainAssessment {
  applied: true;
  lineOfSightClear: boolean;
  penaltyDb: number;
  maxObstructionM: number;
  sampleCount: number;
  towerElevationM: number;
  targetElevationM: number;
  towerTileId: string;
  targetTileId: string;
}

type ViewshedRenderPolicy = "coverage_only" | "diagnostic_all_sectors";

interface ViewshedStyle {
  fillColor: string;
  strokeColor: string;
  fillOpacity: number;
  strokeOpacity: number;
  strokeWidth: number;
  lineDash: number[];
}

interface ViewshedDisplayProperties extends Record<string, unknown> {
  style: ViewshedStyle;
}

interface CoverageCell {
  id: string;
  center: { lon: number; lat: number };
  coordinates: Array<[number, number]>;
}

function buildGrid(bbox: BoundingBox, requestedResolutionM: number, maxCells: number): { resolutionM: number; cells: CoverageCell[] } {
  const centerLat = (bbox.south + bbox.north) / 2;
  const metersPerLon = metersPerDegreeLon(centerLat);
  const widthM = Math.max(1, (bbox.east - bbox.west) * metersPerLon);
  const heightM = Math.max(1, (bbox.north - bbox.south) * 111_320);
  const requested = Math.max(100, requestedResolutionM);
  const requestedCells = Math.ceil(widthM / requested) * Math.ceil(heightM / requested);
  const minimumResolutionM = requestedCells > maxCells ? requested * Math.sqrt(requestedCells / Math.max(1, maxCells)) : requested;
  const resolutionM = nearestResolutionStep(minimumResolutionM);
  const lonStep = resolutionM / metersPerLon;
  const latStep = resolutionM / 111_320;
  const minColumn = Math.floor(bbox.west / lonStep);
  const maxColumn = Math.ceil(bbox.east / lonStep) - 1;
  const minRow = Math.floor(bbox.south / latStep);
  const maxRow = Math.ceil(bbox.north / latStep) - 1;
  const cells: CoverageCell[] = [];

  for (let row = minRow; row <= maxRow && cells.length < maxCells; row += 1) {
    for (let column = minColumn; column <= maxColumn && cells.length < maxCells; column += 1) {
      const west = Math.max(-180, column * lonStep);
      const east = Math.min(180, (column + 1) * lonStep);
      const south = Math.max(-90, row * latStep);
      const north = Math.min(90, (row + 1) * latStep);
      cells.push({
        id: `m${Math.round(resolutionM)}-r${row}-c${column}`,
        center: {
          lon: (west + east) / 2,
          lat: (south + north) / 2
        },
        coordinates: [
          [round(west, 6), round(south, 6)],
          [round(east, 6), round(south, 6)],
          [round(east, 6), round(north, 6)],
          [round(west, 6), round(north, 6)],
          [round(west, 6), round(south, 6)]
        ]
      });
    }
  }
  return { resolutionM, cells };
}

function parseCoverageGridFeatureId(featureId: string): { resolutionM: number; row: number; column: number } | undefined {
  const match = featureId.match(/m([0-9]+)-r(-?[0-9]+)-c(-?[0-9]+)$/);
  if (!match) {
    return undefined;
  }
  const resolutionM = Number(match[1]);
  const row = Number(match[2]);
  const column = Number(match[3]);
  if (!Number.isFinite(resolutionM) || !Number.isFinite(row) || !Number.isFinite(column)) {
    return undefined;
  }
  return { resolutionM, row, column };
}

function nearestResolutionStep(minimumResolutionM: number): number {
  const requested = Math.max(100, Math.ceil(minimumResolutionM));
  return RESOLUTION_STEPS_M.find((step) => step >= requested) ?? requested;
}

function nearestTower(point: { lon: number; lat: number }, towers: Tower[]): NearestTower | undefined {
  let nearest: NearestTower | undefined;
  for (const tower of towers) {
    const distanceM = distanceMeters(point.lon, point.lat, tower.lon, tower.lat);
    if (!nearest || distanceM < nearest.distanceM) {
      nearest = { tower, distanceM };
    }
  }
  return nearest;
}

async function terrainAssessment(
  sampler: DemElevationSampler,
  demTiles: DemTileRef[],
  nearest: NearestTower,
  target: { lon: number; lat: number },
  antennaHeightM: number
): Promise<TerrainAssessment | undefined> {
  const towerSample = await sampler.sample(nearest.tower.lon, nearest.tower.lat, demTiles);
  const targetSample = await sampler.sample(target.lon, target.lat, demTiles);
  if (!towerSample || !targetSample) {
    return undefined;
  }

  const sampleCount = terrainProfileSampleCount(nearest.distanceM);
  const towerHeightM = towerSample.elevationM + antennaHeightM;
  const targetHeightM = targetSample.elevationM + RECEIVER_HEIGHT_M;
  let maxObstructionM = -Infinity;
  let successfulSamples = 0;

  for (let index = 1; index < sampleCount - 1; index += 1) {
    const ratio = index / (sampleCount - 1);
    const lon = nearest.tower.lon + (target.lon - nearest.tower.lon) * ratio;
    const lat = nearest.tower.lat + (target.lat - nearest.tower.lat) * ratio;
    const sample = await sampler.sample(lon, lat, demTiles);
    if (!sample) {
      continue;
    }
    successfulSamples += 1;
    const expectedClearanceM = towerHeightM + (targetHeightM - towerHeightM) * ratio;
    maxObstructionM = Math.max(maxObstructionM, sample.elevationM - expectedClearanceM);
  }

  if (successfulSamples === 0) {
    return undefined;
  }

  const normalizedObstructionM = Math.max(0, Math.round(maxObstructionM));
  return {
    applied: true,
    lineOfSightClear: normalizedObstructionM <= 0,
    penaltyDb: terrainPenaltyDb(normalizedObstructionM, nearest.distanceM),
    maxObstructionM: normalizedObstructionM,
    sampleCount: successfulSamples + 2,
    towerElevationM: towerSample.elevationM,
    targetElevationM: targetSample.elevationM,
    towerTileId: towerSample.tileId,
    targetTileId: targetSample.tileId
  };
}

function terrainProfileSampleCount(distanceM: number): number {
  if (distanceM <= 1500) {
    return 5;
  }
  if (distanceM <= 5000) {
    return 7;
  }
  if (distanceM <= 15_000) {
    return 9;
  }
  return 11;
}

function terrainPenaltyDb(obstructionM: number, distanceM: number): number {
  if (obstructionM <= 0) {
    return 0;
  }
  const distanceFactor = distanceM > 10_000 ? 1.15 : distanceM > 4000 ? 1 : 0.85;
  return Math.round(Math.min(30, (7 + obstructionM * 0.42) * distanceFactor));
}

function estimateSignal(distanceM: number, technology: MobileCoverageTechnology, terrainPenaltyDb = 0): { signalDbm: number; baseSignalDbm: number } {
  const distance = Math.max(100, distanceM);
  const technologyPenalty = technology === "2G" ? 0 : technology === "4G" ? 7 : 14;
  const pathLoss = 10 * 3.2 * Math.log10(distance / 100);
  const baseSignalDbm = Math.round(-58 - pathLoss - technologyPenalty);
  return { signalDbm: baseSignalDbm - terrainPenaltyDb, baseSignalDbm };
}

function qualityForSignal(signalDbm: number): MobileCoverageQuality {
  if (signalDbm >= -85) {
    return "good";
  }
  if (signalDbm >= -100) {
    return "fair";
  }
  if (signalDbm >= -112) {
    return "weak";
  }
  return "none";
}

function confidenceForEstimate(distanceM: number, technology: MobileCoverageTechnology, terrain: TerrainAssessment | undefined): number {
  const rangeM = technology === "2G" ? 25_000 : technology === "4G" ? 12_000 : 4_000;
  const base = Math.max(0.28, Math.min(0.72, 0.72 - (distanceM / rangeM) * 0.38));
  if (!terrain) {
    return round(base, 2);
  }
  const terrainAdjustment = terrain.lineOfSightClear ? 0.04 : -Math.min(0.18, terrain.penaltyDb / 120);
  return round(Math.max(0.24, Math.min(0.78, base + terrainAdjustment)), 2);
}

function severityForQuality(quality: MobileCoverageQuality): "info" | "advisory" | "warning" | "critical" {
  if (quality === "none") {
    return "critical";
  }
  if (quality === "weak") {
    return "warning";
  }
  if (quality === "unknown") {
    return "advisory";
  }
  return "info";
}

function emptyQualityCounts(): Record<MobileCoverageQuality, number> {
  return {
    good: 0,
    fair: 0,
    weak: 0,
    none: 0,
    unknown: 0
  };
}

function normalizeViewshedOptions(options: MobileCoverageViewshedOptions): NormalizedMobileCoverageViewshedOptions {
  const technology = options.technology ?? "4G";
  const radiusM = normalizeViewshedRadius(options.radiusM, technology);
  const azimuthStepDeg = normalizeViewshedAzimuthStep(options.azimuthStepDeg);
  const distanceStepM = normalizeViewshedDistanceStep(options.distanceStepM, radiusM, azimuthStepDeg);
  return {
    towerId: options.towerId,
    technology,
    radiusM,
    azimuthStepDeg,
    distanceStepM,
    includeNoSignal: options.includeNoSignal === true,
    includeRaw: options.includeRaw === true
  };
}

function mergeCacheStats(stats: ManagedResponseCacheStats[]): ManagedResponseCacheStats {
  const latestSuccessAt = latestIsoTimestamp(stats.flatMap((item) => (item.lastSuccessAt ? [item.lastSuccessAt] : [])));
  const latestErrorAt = latestIsoTimestamp(stats.flatMap((item) => (item.lastErrorAt ? [item.lastErrorAt] : [])));
  return {
    entries: sumStats(stats, "entries"),
    inflight: sumStats(stats, "inflight"),
    maxEntries: sumStats(stats, "maxEntries"),
    hits: sumStats(stats, "hits"),
    misses: sumStats(stats, "misses"),
    coalescedHits: sumStats(stats, "coalescedHits"),
    staleHits: sumStats(stats, "staleHits"),
    refreshes: sumStats(stats, "refreshes"),
    errors: sumStats(stats, "errors"),
    evictions: sumStats(stats, "evictions"),
    sharedEnabled: stats.some((item) => item.sharedEnabled),
    sharedAvailable: stats.some((item) => item.sharedAvailable),
    sharedHits: sumStats(stats, "sharedHits"),
    sharedMisses: sumStats(stats, "sharedMisses"),
    sharedStaleHits: sumStats(stats, "sharedStaleHits"),
    sharedWrites: sumStats(stats, "sharedWrites"),
    sharedErrors: sumStats(stats, "sharedErrors"),
    ...(latestSuccessAt ? { lastSuccessAt: latestSuccessAt } : {}),
    ...(latestErrorAt ? { lastErrorAt: latestErrorAt } : {})
  };
}

function sumStats(stats: ManagedResponseCacheStats[], key: keyof Pick<ManagedResponseCacheStats, "entries" | "inflight" | "maxEntries" | "hits" | "misses" | "coalescedHits" | "staleHits" | "refreshes" | "errors" | "evictions" | "sharedHits" | "sharedMisses" | "sharedStaleHits" | "sharedWrites" | "sharedErrors">): number {
  return stats.reduce((sum, item) => sum + item[key], 0);
}

function latestIsoTimestamp(values: string[]): string | undefined {
  return values.sort().at(-1);
}

function coverageDisplayProperties(options: {
  technology: MobileCoverageTechnology;
  quality: MobileCoverageQuality;
  signalDbm: number | undefined;
  metrics: Record<string, number | string | boolean> | undefined;
  readModel: boolean;
  resolutionM: number | undefined;
}): ViewshedDisplayProperties {
  const style = coverageStyle(options.quality);
  const terrainPenaltyDb = metricNumber(options.metrics, "terrainPenaltyDb");
  const obstructionM = metricNumber(options.metrics, "terrainMaxObstructionM");
  const distanceM = metricNumber(options.metrics, "distanceToNearestTowerM");
  return {
    contractVersion: "sim-mobile-coverage-display-v1",
    renderer: "mobile_coverage_grid_cell_v1",
    renderOnly: true,
    renderPolicy: "quality_fill",
    visible: true,
    label: `${options.technology} ${viewshedQualityLabel(options.quality)}`,
    subtitle: coverageSubtitle(options.signalDbm, terrainPenaltyDb, obstructionM),
    primaryValue: options.signalDbm === undefined ? viewshedQualityLabel(options.quality) : `${options.signalDbm} dBm`,
    secondaryValue: terrainPenaltyDb === undefined ? "terrain not evaluated" : `${terrainPenaltyDb} dB terrain loss`,
    tertiaryValue: distanceM === undefined ? undefined : `${Math.round(distanceM)} m to nearest tower`,
    quality: options.quality,
    signalDbm: options.signalDbm,
    terrainPenaltyDb,
    terrainObstructionM: obstructionM,
    resolutionM: options.resolutionM,
    readModel: options.readModel,
    style,
    legend: [
      { quality: "good", label: "Good estimated coverage", color: "#22c55e" },
      { quality: "fair", label: "Usable estimated coverage", color: "#eab308" },
      { quality: "weak", label: "Weak estimated coverage", color: "#f97316" },
      { quality: "none", label: "No estimated coverage", color: "#ef4444" },
      { quality: "unknown", label: "Unknown coverage", color: "#94a3b8" }
    ],
    copInstructions: {
      defaultLayerBehavior: "Render polygon cells using providerProperties.display.style.",
      colorField: "providerProperties.display.style.fillColor",
      opacityField: "providerProperties.display.style.fillOpacity",
      labelField: "providerProperties.display.label"
    }
  };
}

function coverageStyle(quality: MobileCoverageQuality): ViewshedStyle {
  const palette: Record<MobileCoverageQuality, { fillColor: string; strokeColor: string; fillOpacity: number; strokeOpacity: number }> = {
    good: { fillColor: "#22c55e", strokeColor: "#15803d", fillOpacity: 0.34, strokeOpacity: 0.72 },
    fair: { fillColor: "#eab308", strokeColor: "#a16207", fillOpacity: 0.28, strokeOpacity: 0.66 },
    weak: { fillColor: "#f97316", strokeColor: "#c2410c", fillOpacity: 0.24, strokeOpacity: 0.62 },
    none: { fillColor: "#ef4444", strokeColor: "#b91c1c", fillOpacity: 0.12, strokeOpacity: 0.42 },
    unknown: { fillColor: "#94a3b8", strokeColor: "#475569", fillOpacity: 0.16, strokeOpacity: 0.45 }
  };
  return {
    ...palette[quality],
    strokeWidth: 0.6,
    lineDash: quality === "unknown" ? [4, 4] : []
  };
}

function coverageSubtitle(signalDbm: number | undefined, terrainPenaltyDb: number | undefined, obstructionM: number | undefined): string {
  const signal = signalDbm === undefined ? "signal unknown" : `estimated signal ${signalDbm} dBm`;
  if (terrainPenaltyDb === undefined) {
    return `${signal}; terrain not evaluated.`;
  }
  if ((obstructionM ?? 0) > 0) {
    return `${signal}; terrain obstruction ${obstructionM} m.`;
  }
  return `${signal}; terrain line of sight clear.`;
}

function metricNumber(metrics: Record<string, number | string | boolean> | undefined, key: string): number | undefined {
  const value = metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function viewshedDisplayProperties(options: {
  technology: MobileCoverageTechnology;
  quality: MobileCoverageQuality;
  signalDbm: number;
  terrain: TerrainAssessment | undefined;
  innerRadiusM: number;
  outerRadiusM: number;
  renderPolicy: ViewshedRenderPolicy;
  includeNoSignal: boolean;
}): ViewshedDisplayProperties {
  const style = viewshedStyle(options.quality, options.includeNoSignal);
  const lineOfSightStatus = options.terrain ? (options.terrain.lineOfSightClear ? "clear" : "blocked") : "not_evaluated";
  return {
    contractVersion: "sim-mobile-coverage-viewshed-display-v1",
    renderer: "mobile_coverage_viewshed_sector_v1",
    renderOnly: true,
    renderPolicy: options.renderPolicy,
    visible: options.quality !== "none" || options.includeNoSignal,
    label: `${options.technology} ${viewshedQualityLabel(options.quality)}`,
    subtitle: viewshedSubtitle(options.terrain, options.signalDbm),
    primaryValue: `${options.signalDbm} dBm`,
    secondaryValue: options.terrain ? `${options.terrain.penaltyDb} dB terrain loss` : "terrain not evaluated",
    quality: options.quality,
    lineOfSightStatus,
    terrainObstructionM: options.terrain?.maxObstructionM,
    innerRadiusM: Math.round(options.innerRadiusM),
    outerRadiusM: Math.round(options.outerRadiusM),
    style,
    legend: [
      { quality: "good", label: "Good estimate", color: "#22c55e" },
      { quality: "fair", label: "Usable estimate", color: "#eab308" },
      { quality: "weak", label: "Weak estimate", color: "#f97316" },
      { quality: "none", label: "No estimated reach / hidden by default", color: "#ef4444" }
    ],
    copInstructions: {
      defaultLayerBehavior: "Render returned features only. Do not draw omitted no-signal sectors.",
      diagnosticLayerBehavior: "Request includeNoSignal=true only when the operator explicitly wants the full diagnostic radial grid.",
      colorField: "providerProperties.display.style.fillColor",
      opacityField: "providerProperties.display.style.fillOpacity"
    }
  };
}

function viewshedStyle(quality: MobileCoverageQuality, includeNoSignal: boolean): ViewshedStyle {
  const palette: Record<MobileCoverageQuality, { fillColor: string; strokeColor: string; fillOpacity: number; strokeOpacity: number }> = {
    good: { fillColor: "#22c55e", strokeColor: "#15803d", fillOpacity: 0.42, strokeOpacity: 0.85 },
    fair: { fillColor: "#eab308", strokeColor: "#a16207", fillOpacity: 0.34, strokeOpacity: 0.78 },
    weak: { fillColor: "#f97316", strokeColor: "#c2410c", fillOpacity: 0.28, strokeOpacity: 0.72 },
    none: { fillColor: "#ef4444", strokeColor: "#b91c1c", fillOpacity: includeNoSignal ? 0.1 : 0, strokeOpacity: includeNoSignal ? 0.35 : 0 },
    unknown: { fillColor: "#94a3b8", strokeColor: "#475569", fillOpacity: 0.18, strokeOpacity: 0.45 }
  };
  return {
    ...palette[quality],
    strokeWidth: quality === "none" ? 0.5 : 1,
    lineDash: quality === "none" ? [4, 4] : []
  };
}

function viewshedQualityLabel(quality: MobileCoverageQuality): string {
  switch (quality) {
    case "good":
      return "good estimated reach";
    case "fair":
      return "usable estimated reach";
    case "weak":
      return "weak estimated reach";
    case "none":
      return "no estimated reach";
    default:
      return "unknown estimated reach";
  }
}

function viewshedSubtitle(terrain: TerrainAssessment | undefined, signalDbm: number): string {
  if (!terrain) {
    return `Estimated signal ${signalDbm} dBm; terrain not evaluated.`;
  }
  if (terrain.lineOfSightClear) {
    return `Estimated signal ${signalDbm} dBm; terrain line of sight clear.`;
  }
  return `Estimated signal ${signalDbm} dBm; terrain obstruction ${terrain.maxObstructionM} m.`;
}

function expandBboxByMeters(bbox: BoundingBox, meters: number): BoundingBox {
  const centerLat = (bbox.south + bbox.north) / 2;
  const lonDelta = meters / metersPerDegreeLon(centerLat);
  const latDelta = meters / 111_320;
  return {
    west: Math.max(-180, bbox.west - lonDelta),
    south: Math.max(-90, bbox.south - latDelta),
    east: Math.min(180, bbox.east + lonDelta),
    north: Math.min(90, bbox.north + latDelta)
  };
}

function bboxAroundPoint(lon: number, lat: number, radiusM: number): BoundingBox {
  return expandBboxByMeters({ west: lon, south: lat, east: lon, north: lat }, radiusM);
}

function featureIntersectsBbox(feature: SituationFeature, bbox: BoundingBox): boolean {
  const featureBbox = polygonFeatureBbox(feature);
  if (!featureBbox) {
    return false;
  }
  return featureBbox.west <= bbox.east && featureBbox.east >= bbox.west && featureBbox.south <= bbox.north && featureBbox.north >= bbox.south;
}

function polygonFeatureBbox(feature: SituationFeature): BoundingBox | undefined {
  if (feature.geometry.type !== "Polygon") {
    return undefined;
  }
  const points = feature.geometry.coordinates.flat();
  if (points.length === 0) {
    return undefined;
  }
  return points.reduce(
    (acc, [lon, lat]) => ({
      west: Math.min(acc.west, lon),
      south: Math.min(acc.south, lat),
      east: Math.max(acc.east, lon),
      north: Math.max(acc.north, lat)
    }),
    { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }
  );
}

function distanceMeters(lonA: number, latA: number, lonB: number, latB: number): number {
  const centerLat = (latA + latB) / 2;
  const dx = (lonA - lonB) * metersPerDegreeLon(centerLat);
  const dy = (latA - latB) * 111_320;
  return Math.sqrt(dx * dx + dy * dy);
}

function metersPerDegreeLon(lat: number): number {
  return Math.max(1, 111_320 * Math.cos((lat * Math.PI) / 180));
}

function defaultViewshedRadiusM(technology: MobileCoverageTechnology): number {
  if (technology === "2G") {
    return 25_000;
  }
  if (technology === "5G") {
    return 5000;
  }
  return 12_000;
}

function normalizeViewshedRadius(value: number | undefined, technology: MobileCoverageTechnology): number {
  if (value === undefined || !Number.isFinite(value)) {
    return defaultViewshedRadiusM(technology);
  }
  return Math.max(500, Math.min(30_000, Math.trunc(value)));
}

function normalizeViewshedAzimuthStep(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_VIEWSHED_AZIMUTH_STEP_DEG;
  }
  return Math.max(2, Math.min(90, Math.trunc(value)));
}

function normalizeViewshedDistanceStep(value: number | undefined, radiusM: number, azimuthStepDeg: number): number {
  const raw = value === undefined || !Number.isFinite(value) ? DEFAULT_VIEWSHED_DISTANCE_STEP_M : Math.trunc(value);
  const normalized = Math.max(100, Math.min(2500, raw));
  const azimuthBands = Math.ceil(360 / azimuthStepDeg);
  const distanceBands = Math.ceil(radiusM / normalized);
  if (azimuthBands * distanceBands <= MAX_VIEWSHED_FEATURES) {
    return normalized;
  }
  return Math.ceil(radiusM / Math.max(1, Math.floor(MAX_VIEWSHED_FEATURES / azimuthBands)));
}

function destinationPoint(lon: number, lat: number, bearingDeg: number, distanceM: number): { lon: number; lat: number } {
  const bearingRad = (bearingDeg * Math.PI) / 180;
  const dy = Math.cos(bearingRad) * distanceM;
  const dx = Math.sin(bearingRad) * distanceM;
  return {
    lon: Math.max(-180, Math.min(180, lon + dx / metersPerDegreeLon(lat))),
    lat: Math.max(-90, Math.min(90, lat + dy / 111_320))
  };
}

function sectorPolygon(
  lon: number,
  lat: number,
  startBearingDeg: number,
  endBearingDeg: number,
  innerRadiusM: number,
  outerRadiusM: number
): Array<[number, number]> {
  const arcSegments = Math.max(1, Math.ceil((endBearingDeg - startBearingDeg) / 5));
  const outerArc: Array<[number, number]> = [];
  for (let index = 0; index <= arcSegments; index += 1) {
    const bearing = startBearingDeg + ((endBearingDeg - startBearingDeg) * index) / arcSegments;
    const point = destinationPoint(lon, lat, bearing, outerRadiusM);
    outerArc.push([round(point.lon, 6), round(point.lat, 6)]);
  }

  if (innerRadiusM <= 0) {
    return [[round(lon, 6), round(lat, 6)], ...outerArc, [round(lon, 6), round(lat, 6)]];
  }

  const innerArc: Array<[number, number]> = [];
  for (let index = arcSegments; index >= 0; index -= 1) {
    const bearing = startBearingDeg + ((endBearingDeg - startBearingDeg) * index) / arcSegments;
    const point = destinationPoint(lon, lat, bearing, innerRadiusM);
    innerArc.push([round(point.lon, 6), round(point.lat, 6)]);
  }

  return [...outerArc, ...innerArc, outerArc[0] ?? [round(lon, 6), round(lat, 6)]];
}

function parseTowerId(value: string): { osmType: string; osmId: string } | undefined {
  const [osmType, osmId, ...rest] = value.split(":");
  if (rest.length > 0 || !osmType || !osmId || !/^(node|way|relation)$/.test(osmType) || !/^-?\d+$/.test(osmId)) {
    return undefined;
  }
  return { osmType, osmId };
}

function sanitizeFeatureId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function quoteQualifiedIdentifier(value: string): string {
  const parts = value.split(".").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 2 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    throw new Error("Invalid OSM_POSTGIS_TABLE identifier.");
  }
  return parts.map((part) => `"${part.replace(/"/g, '""')}"`).join(".");
}

function publicPostgisBaseUrl(connectionString: string | undefined): string | undefined {
  if (!connectionString) {
    return undefined;
  }
  try {
    const url = new URL(connectionString);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "postgresql://configured";
  }
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function towerOperator(tags: Record<string, unknown> | null): string | undefined {
  return cleanString(tags?.operator) ?? cleanString(tags?.brand) ?? cleanString(tags?.network);
}

function towerTechnologyHint(tags: Record<string, unknown> | null): string | undefined {
  if (!tags) {
    return undefined;
  }
  const hints = [
    cleanString(tags["communication:mobile_phone"]),
    cleanString(tags["telecom:medium"]),
    cleanString(tags["tower:type"]),
    cleanString(tags.man_made)
  ].filter((value): value is string => Boolean(value));
  return hints.length > 0 ? hints.join(",") : undefined;
}

function compactTags(values: Record<string, string | undefined>): Record<string, string> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactMetrics(values: Record<string, number | string | boolean | undefined>): Record<string, number | string | boolean> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, number | string | boolean] => entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactMixedMetrics(values: Record<string, unknown> | null): Record<string, number | string | boolean> | undefined {
  if (!values) {
    return undefined;
  }
  const entries = Object.entries(values).filter((entry): entry is [string, number | string | boolean] =>
    typeof entry[1] === "number" || typeof entry[1] === "string" || typeof entry[1] === "boolean"
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactStringTags(values: Record<string, unknown> | null): Record<string, string> | undefined {
  if (!values) {
    return undefined;
  }
  const entries = Object.entries(values).flatMap(([key, value]): Array<[string, string]> => {
    if (typeof value === "string" && value.length > 0) {
      return [[key, value]];
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return [[key, String(value)]];
    }
    return [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactAssumptions(values: Record<string, unknown> | null): Record<string, string | number | boolean> | undefined {
  if (!values) {
    return undefined;
  }
  const entries = Object.entries(values).filter((entry): entry is [string, string | number | boolean] =>
    typeof entry[1] === "number" || typeof entry[1] === "string" || typeof entry[1] === "boolean"
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mobileCoverageTechnology(value: string): MobileCoverageTechnology | undefined {
  return value === "2G" || value === "4G" || value === "5G" ? value : undefined;
}

function mobileCoverageQuality(value: string): MobileCoverageQuality | undefined {
  return value === "good" || value === "fair" || value === "weak" || value === "none" || value === "unknown" ? value : undefined;
}

function mobileBtsStatus(value: string | null): MobileBtsStatus {
  if (value === "operator_feed_unavailable" || value === "unverified" || value === "reported_outage" || value === "unknown") {
    return value;
  }
  return "operator_feed_unavailable";
}

function isPolygonGeometry(value: unknown): value is SituationFeature["geometry"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const geometry = value as { type?: unknown; coordinates?: unknown };
  return geometry.type === "Polygon" && Array.isArray(geometry.coordinates);
}

function toIsoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + Math.max(1, seconds) * 1000).toISOString();
}

function isMissingRelationError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "42P01";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown failure";
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
