import { Pool } from "pg";
import { canonicalizeBboxForCache, formatBboxKey } from "./bbox-cache.js";
import type { SituationDataConfig } from "./config.js";
import { DemElevationSampler, type DemTileRef, type ElevationSample } from "./dem-elevation-sampler.js";
import { ManagedResponseCache } from "./response-cache.js";
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

export class MobileCoverageSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<CoveragePayload>;
  private readonly towerCountCache: ManagedResponseCache<number>;
  private pool?: Pool;

  constructor(private readonly config: SituationDataConfig) {
    this.payloadCache = new ManagedResponseCache<CoveragePayload>({
      ttlMs: Math.max(60, config.mobileCoverageCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.mobileCoverageCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(64, Math.min(config.cacheMaxEntries, 4096))
    });
    this.towerCountCache = new ManagedResponseCache<number>({
      ttlMs: 300_000,
      staleIfErrorMs: Math.max(300, config.staleIfErrorSeconds) * 1000,
      maxEntries: 2
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
    return [
      {
        sourceId: "mobile_coverage_model",
        ...this.payloadCache.stats()
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
        const readModelCount = await this.fetchReadModelCount().catch(() => undefined);
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

      create index if not exists mobile_coverage_cells_geom_gix on ${table} using gist (geom);
      create index if not exists mobile_coverage_cells_model_idx on ${table}(model_version, technology, operator);
      create index if not exists mobile_coverage_cells_expires_idx on ${table}(expires_at);
      create index if not exists mobile_coverage_cells_generated_idx on ${table}(generated_at);
    `);
  }

  async replaceReadModelFeatures(
    bbox: BoundingBox,
    technologies: MobileCoverageTechnology[] = DEFAULT_TECHNOLOGIES,
    expiresAt = addSeconds(
      new Date().toISOString(),
      Math.max(this.config.mobileCoverageReadModelMaxAgeSeconds, this.config.mobileCoverageCacheTtlSeconds)
    )
  ): Promise<number> {
    await this.ensureReadModelSchema();
    const payload = await this.buildCoverage(bbox, technologies);
    const table = quoteQualifiedIdentifier(this.config.mobileCoverageReadModelTable);
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
            geom,
            feature_id
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz,
            $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19,
            st_setsrid(st_geomfromgeojson($20), 4326),
            $21
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
          JSON.stringify(feature.geometry),
          feature.properties.featureId
        ]
      );
    }

    return payload.features.length;
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
    const features = payload.features
      .filter((feature) => featureIntersectsBbox(feature, query.bbox))
      .slice(0, query.limit)
      .map((feature) => ({
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
      const result = await this.getPool().query<CoverageCellRow>(
        `
          select
            feature_id,
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
            st_asgeojson(geom)::json as geometry
          from ${table}
          where model_version = $1
            and technology = any($2::text[])
            and operator = any($3::text[])
            and expires_at > now()
            and ($4::int <= 0 or generated_at >= now() - make_interval(secs => $4::int))
            and geom && st_makeenvelope($5, $6, $7, $8, 4326)
            and st_intersects(geom, st_makeenvelope($5, $6, $7, $8, 4326))
          order by generated_at desc, feature_id asc
          limit $9
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
          Math.max(1, query.limit)
        ]
      );
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
        metrics: compactMixedMetrics(row.metrics),
        tags: compactStringTags(row.tags),
        operator: row.operator,
        technology,
        quality,
        estimatedSignalDbm: optionalNumber(row.estimated_signal_dbm),
        modelVersion: row.model_version,
        sourceRevision: cleanString(row.source_revision),
        readModel: true,
        generatedAt,
        resolutionM: optionalNumber(row.resolution_m),
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
        metrics: compactMetrics({
          distanceToNearestTowerM: nearest ? Math.round(nearest.distanceM) : undefined,
          nearestTowerLon: nearest?.tower.lon,
          nearestTowerLat: nearest?.tower.lat,
          baseSignalDbm: estimate?.baseSignalDbm,
          terrainPenaltyDb: terrain?.penaltyDb,
          terrainMaxObstructionM: terrain?.maxObstructionM,
          terrainSamples: terrain?.sampleCount,
          towerElevationM: terrain?.towerElevationM,
          targetElevationM: terrain?.targetElevationM
        }),
        tags: compactTags({
          nearestTowerId: nearest?.tower.id,
          nearestTowerName: nearest?.tower.name,
          nearestTowerOperator: nearest?.tower.operator,
          nearestTowerTechnologyHint: nearest?.tower.technologyHint
        }),
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

  private async fetchTowerCount(): Promise<number> {
    const table = quoteQualifiedIdentifier(this.config.osmPostgisTable);
    const result = await this.getPool().query<{ count: string }>(
      `select count(*)::bigint as count from ${table} where layer = 'mobile' and category = 'communications_tower'`
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async fetchReadModelCount(): Promise<number> {
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

function featureIntersectsBbox(feature: SituationFeature, bbox: BoundingBox): boolean {
  if (feature.geometry.type !== "Polygon") {
    return false;
  }
  const points = feature.geometry.coordinates.flat();
  if (points.length === 0) {
    return false;
  }
  const featureBbox = points.reduce(
    (acc, [lon, lat]) => ({
      west: Math.min(acc.west, lon),
      south: Math.min(acc.south, lat),
      east: Math.max(acc.east, lon),
      north: Math.max(acc.north, lat)
    }),
    { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }
  );
  return featureBbox.west <= bbox.east && featureBbox.east >= bbox.west && featureBbox.south <= bbox.north && featureBbox.north >= bbox.south;
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
