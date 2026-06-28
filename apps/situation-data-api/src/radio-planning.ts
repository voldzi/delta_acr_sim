import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DemElevationSampler, type DemTileRef } from "./dem-elevation-sampler.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { BoundingBox, LineStringGeometry, PointGeometry, PolygonGeometry } from "./types.js";
import type { SituationDataConfig } from "./config.js";

export type RadioProfileCategory =
  | "civil"
  | "amateur"
  | "business"
  | "public_safety"
  | "military_generic"
  | "iot"
  | "data_link";
export type RadioProfileSource = "builtin" | "custom";
export type RadioQuality = "good" | "fair" | "weak" | "none" | "unknown";
export type RadioLinkStatus = "clear" | "marginal" | "obstructed" | "unknown";
export type RadioPlanningCacheOperation = "link_check" | "coverage" | "site_search";

export interface RadioProfile {
  profileId: string;
  name: string;
  category: RadioProfileCategory;
  source: RadioProfileSource;
  frequencyMhz: number;
  txPowerW: number;
  antennaHeightM: number;
  receiverHeightM: number;
  antennaGainDbi: number;
  receiverAntennaGainDbi: number;
  systemLossDb: number;
  receiverSensitivityDbm: number;
  requiredFresnelClearancePct: number;
  maxRadiusM: number;
  defaultAzimuthStepDeg: number;
  defaultDistanceStepM: number;
  modelApplicability: "terrain_los" | "limited_for_beyond_line_of_sight";
  sensitiveUse: boolean;
  notes: string[];
}

export interface RadioProfileCatalog {
  contractVersion: "sim-radio-profile-catalog-v1";
  generatedAt: string;
  profiles: RadioProfile[];
  warnings: string[];
}

export interface RadioFeature {
  type: "Feature";
  id: string;
  geometry: PointGeometry | LineStringGeometry | PolygonGeometry;
  properties: Record<string, unknown>;
}

export interface RadioFeatureCollection {
  contractVersion: "sim-radio-coverage-v1" | "sim-radio-site-search-v1";
  type: "FeatureCollection";
  generatedAt: string;
  source: {
    sourceId: "radio_planning_model";
    sourceType: "MODELLED_RADIO_ANALYSIS";
    generatedAt: string;
  };
  profile: RadioProfile;
  query: Record<string, unknown>;
  summary: Record<string, unknown>;
  features: RadioFeature[];
  warnings: string[];
}

export interface RadioLinkCheckResponse {
  contractVersion: "sim-radio-link-check-v1";
  generatedAt: string;
  source: {
    sourceId: "radio_planning_model";
    sourceType: "MODELLED_RADIO_ANALYSIS";
    generatedAt: string;
  };
  profile: RadioProfile;
  query: Record<string, unknown>;
  result: LinkAssessment;
  profileSamples: TerrainProfileSample[];
  warnings: string[];
}

export interface RadioPlanningCacheStats extends ManagedResponseCacheStats {
  operation: RadioPlanningCacheOperation;
}

export class RadioPlanningError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

interface RadioStation {
  lon: number;
  lat: number;
  antennaHeightM: number;
  label?: string;
}

interface LinkAssessment {
  linkStatus: RadioLinkStatus;
  quality: RadioQuality;
  lineOfSightClear?: boolean;
  distanceM: number;
  azimuthDeg: number;
  reverseAzimuthDeg: number;
  estimatedRxPowerDbm?: number;
  linkMarginDb?: number;
  freeSpacePathLossDb: number;
  terrainPenaltyDb?: number;
  maxObstructionM?: number;
  minFresnelClearanceM?: number;
  minTerrainClearanceM?: number;
  requiredExtraAntennaHeightM?: number;
  fresnelClearancePct?: number;
  terrainApplied: boolean;
}

interface TerrainProfileSample {
  lon: number;
  lat: number;
  distanceM: number;
  terrainElevationM?: number;
  lineHeightM?: number;
  fresnelRadiusM?: number;
  terrainClearanceM?: number;
  fresnelClearanceM?: number;
  tileId?: string;
}

interface TerrainContext {
  sampler?: DemElevationSampler;
  demTiles: DemTileRef[];
  terrainAvailable: boolean;
  warnings: string[];
}

interface NormalizedRadioLinkCheckRequest {
  profile: RadioProfile;
  radioName?: string;
  from: RadioStation;
  to: RadioStation;
  sampleStepM?: number;
}

interface NormalizedRadioCoverageRequest {
  profile: RadioProfile;
  radioName?: string;
  station: RadioStation;
  radiusM?: number;
  azimuthStepDeg?: number;
  distanceStepM?: number;
}

interface NormalizedRadioSiteSearchRequest {
  profile: RadioProfile;
  radioName?: string;
  searchArea: BoundingBox;
  targets: RadioStation[];
  stationAntennaHeightM?: number;
  gridStepM?: number;
  maxCandidates: number;
}

const RADIO_DISCLAIMER =
  "Radio result is a modelled DEM line-of-sight estimate. It does not include buildings, vegetation, interference, spectrum occupancy, encryption, network load, or classified/operator RF parameters.";
const RADIO_MODEL_VERSION = "radio-los-v1";
const MAX_COVERAGE_FEATURES = 2500;
const MAX_SITE_EVALUATION_POINTS = 2500;
const DEFAULT_REQUIRED_FRESNEL_CLEARANCE_PCT = 60;

const BUILTIN_RADIO_PROFILES: RadioProfile[] = [
  builtin("pmr446_handheld", "PMR446 handheld", "civil", 446, 0.5, 1.5, 1.5, 0, 0, 2, -116, 5000, 10, 250, [
    "Common licence-free handheld profile for short-range civil use in the Czech Republic."
  ]),
  builtin("pmr446_elevated", "PMR446 elevated antenna", "civil", 446, 0.5, 5, 1.5, 2, 0, 2, -116, 8000, 10, 250, [
    "Licence-free PMR446 estimate with an elevated operator-side antenna."
  ]),
  builtin("cb_27_handheld", "CB 27 MHz handheld", "civil", 27, 4, 1.5, 1.5, 0, 0, 2, -112, 10000, 10, 500, [
    "Terrain LoS is only a partial indicator for 27 MHz; propagation may differ materially."
  ], "limited_for_beyond_line_of_sight"),
  builtin("cb_27_vehicle", "CB 27 MHz vehicle", "civil", 27, 4, 2.5, 1.5, 1, 0, 2, -112, 20000, 10, 500, [
    "Vehicle CB estimate. Low-band propagation can exceed or underperform DEM LoS."
  ], "limited_for_beyond_line_of_sight"),
  builtin("cb_27_base", "CB 27 MHz base", "civil", 27, 4, 10, 1.5, 2, 0, 2, -112, 30000, 10, 500, [
    "Base CB estimate; terrain LoS is indicative only for this band."
  ], "limited_for_beyond_line_of_sight"),
  builtin("ham_50_mobile", "HAM 50 MHz mobile", "amateur", 50, 10, 2.5, 1.5, 1, 0, 2, -120, 30000, 10, 500, [
    "Amateur 6 m mobile profile. Requires appropriate licence."
  ], "limited_for_beyond_line_of_sight"),
  builtin("ham_50_base", "HAM 50 MHz base", "amateur", 50, 50, 12, 1.5, 5, 0, 2, -120, 60000, 10, 1000, [
    "Amateur 6 m base profile. Requires appropriate licence."
  ], "limited_for_beyond_line_of_sight"),
  builtin("ham_70_mobile", "HAM 70 MHz mobile", "amateur", 70, 10, 2.5, 1.5, 1, 0, 2, -120, 25000, 10, 500, [
    "Amateur 4 m mobile-style profile where locally permitted."
  ]),
  builtin("ham_145_handheld", "HAM VHF 145 MHz handheld", "amateur", 145, 5, 1.5, 1.5, 0, 0, 2, -120, 15000, 10, 500, [
    "Amateur 2 m handheld profile. Requires appropriate licence."
  ]),
  builtin("ham_145_mobile", "HAM VHF 145 MHz mobile", "amateur", 145, 25, 2.5, 1.5, 2, 0, 2, -120, 30000, 10, 500, [
    "Amateur 2 m mobile profile. Requires appropriate licence."
  ]),
  builtin("ham_145_base", "HAM VHF 145 MHz base", "amateur", 145, 50, 15, 1.5, 6, 0, 2, -120, 60000, 10, 1000, [
    "Amateur 2 m elevated base or repeater-style estimate. Requires appropriate licence."
  ]),
  builtin("ham_433_handheld", "HAM UHF 433 MHz handheld", "amateur", 433, 5, 1.5, 1.5, 0, 0, 2, -118, 10000, 10, 250, [
    "Amateur 70 cm handheld profile. Requires appropriate licence."
  ]),
  builtin("ham_433_mobile", "HAM UHF 433 MHz mobile", "amateur", 433, 25, 2.5, 1.5, 2, 0, 2, -118, 20000, 10, 500, [
    "Amateur 70 cm mobile profile. Requires appropriate licence."
  ]),
  builtin("ham_433_base", "HAM UHF 433 MHz base", "amateur", 433, 50, 15, 1.5, 8, 0, 2, -118, 40000, 10, 500, [
    "Amateur 70 cm elevated base or repeater-style estimate. Requires appropriate licence."
  ]),
  builtin("ham_1296_ptp", "HAM 1296 MHz point-to-point", "amateur", 1296, 10, 10, 5, 10, 10, 3, -110, 25000, 5, 250, [
    "Amateur 23 cm directional point-to-point estimate. Requires appropriate licence."
  ]),
  builtin("business_vhf_handheld", "Business VHF handheld", "business", 160, 5, 1.5, 1.5, 0, 0, 2, -118, 12000, 10, 500, [
    "Generic licensed professional VHF handheld profile."
  ]),
  builtin("business_vhf_vehicle", "Business VHF vehicle", "business", 160, 25, 2.5, 1.5, 2, 0, 2, -118, 30000, 10, 500, [
    "Generic licensed professional VHF vehicle profile."
  ]),
  builtin("business_vhf_repeater", "Business VHF elevated repeater", "business", 160, 25, 20, 1.5, 5, 0, 2, -118, 60000, 10, 1000, [
    "Generic licensed professional VHF elevated repeater estimate."
  ]),
  builtin("business_uhf_handheld", "Business UHF handheld", "business", 450, 4, 1.5, 1.5, 0, 0, 2, -118, 10000, 10, 250, [
    "Generic licensed professional UHF handheld profile."
  ]),
  builtin("business_uhf_vehicle", "Business UHF vehicle", "business", 450, 25, 2.5, 1.5, 2, 0, 2, -118, 25000, 10, 500, [
    "Generic licensed professional UHF vehicle profile."
  ]),
  builtin("business_uhf_repeater", "Business UHF elevated repeater", "business", 450, 25, 20, 1.5, 6, 0, 2, -118, 45000, 10, 500, [
    "Generic licensed professional UHF elevated repeater estimate."
  ]),
  builtin("tetra_handheld", "TETRA generic handheld", "public_safety", 390, 1, 1.5, 1.5, 0, 0, 2, -112, 10000, 10, 250, [
    "Generic non-sensitive TETRA handheld profile. Not a live PEGAS/BTS state."
  ]),
  builtin("tetra_vehicle", "TETRA generic vehicle", "public_safety", 390, 10, 2.5, 1.5, 2, 0, 2, -112, 25000, 10, 500, [
    "Generic non-sensitive TETRA vehicle profile. Not a live network state."
  ]),
  builtin("tetra_repeater", "TETRA generic elevated relay", "public_safety", 390, 10, 20, 1.5, 5, 0, 2, -112, 50000, 10, 500, [
    "Generic non-sensitive TETRA elevated relay estimate. Not a live network state."
  ]),
  builtin("marine_vhf_handheld", "Marine VHF handheld", "civil", 156, 5, 1.5, 1.5, 0, 0, 2, -116, 12000, 10, 500, [
    "Generic marine VHF handheld profile for legal maritime/riparian contexts."
  ]),
  builtin("marine_vhf_vessel", "Marine VHF vessel", "civil", 156, 25, 5, 1.5, 3, 0, 2, -116, 30000, 10, 500, [
    "Generic marine VHF vessel profile."
  ]),
  builtin("aviation_vhf_ground", "Aviation VHF ground radio", "civil", 125, 10, 3, 1000, 2, 0, 2, -107, 80000, 10, 1000, [
    "Generic airband ground-to-air planning profile. Operational use requires legal authorization."
  ]),
  builtin("lora_433_sensor", "LoRa 433 MHz sensor", "iot", 433, 0.025, 2, 2, 2, 2, 2, -137, 15000, 10, 500, [
    "Generic low-power IoT profile; link budget is indicative and depends on spreading factor."
  ]),
  builtin("lora_868_sensor", "LoRa 868 MHz sensor", "iot", 868, 0.025, 2, 2, 2, 2, 2, -137, 10000, 10, 500, [
    "Generic low-power IoT profile for the 868 MHz ISM band."
  ]),
  builtin("wifi_24_ptp", "Wi-Fi 2.4 GHz point-to-point", "data_link", 2400, 0.1, 5, 5, 8, 8, 3, -90, 10000, 5, 250, [
    "Generic directional 2.4 GHz point-to-point data link estimate."
  ]),
  builtin("wifi_5_ptp", "Wi-Fi 5 GHz point-to-point", "data_link", 5500, 0.1, 5, 5, 16, 16, 4, -88, 8000, 5, 250, [
    "Generic directional 5 GHz point-to-point data link estimate."
  ]),
  builtin("wifi_6_ptp", "Wi-Fi 6 GHz point-to-point", "data_link", 6000, 0.1, 5, 5, 16, 16, 4, -86, 6000, 5, 250, [
    "Generic 6 GHz point-to-point data link estimate; regulatory constraints apply."
  ]),
  builtin("mil_vhf_manpack", "Generic VHF manpack", "military_generic", 50, 5, 2, 1.5, 0, 0, 3, -116, 25000, 10, 500, [
    "Non-sensitive generic VHF manpack planning profile; not a specific military system."
  ]),
  builtin("mil_vhf_vehicle", "Generic VHF vehicle", "military_generic", 50, 25, 3, 1.5, 2, 0, 3, -116, 40000, 10, 1000, [
    "Non-sensitive generic VHF vehicle planning profile; not a specific military system."
  ]),
  builtin("mil_vhf_relay", "Generic VHF elevated relay", "military_generic", 50, 25, 15, 1.5, 4, 0, 3, -116, 60000, 10, 1000, [
    "Non-sensitive generic VHF elevated relay planning profile; not a specific military system."
  ]),
  builtin("mil_uhf_handheld", "Generic UHF handheld", "military_generic", 400, 5, 1.5, 1.5, 0, 0, 3, -115, 12000, 10, 250, [
    "Non-sensitive generic UHF handheld planning profile; not a specific military system."
  ]),
  builtin("mil_uhf_vehicle", "Generic UHF vehicle", "military_generic", 400, 20, 3, 1.5, 2, 0, 3, -115, 25000, 10, 500, [
    "Non-sensitive generic UHF vehicle planning profile; not a specific military system."
  ]),
  builtin("mil_lband_short_range", "Generic L-band short-range radio", "military_generic", 1250, 1, 1.5, 1.5, 2, 2, 3, -105, 5000, 5, 250, [
    "Non-sensitive generic short-range data/radio profile; not a specific military system."
  ])
];

export class RadioPlanningService {
  private readonly customProfilePath: string;
  private readonly linkCheckCache: ManagedResponseCache<RadioLinkCheckResponse>;
  private readonly coverageCache: ManagedResponseCache<RadioFeatureCollection>;
  private readonly siteSearchCache: ManagedResponseCache<RadioFeatureCollection>;

  constructor(private readonly config: SituationDataConfig) {
    this.customProfilePath = join(config.dataDir, "radio-profiles.json");
    const ttlMs = Math.max(30, config.radioPlanningCacheTtlSeconds) * 1000;
    const staleIfErrorMs = Math.max(config.radioPlanningCacheTtlSeconds, config.staleIfErrorSeconds) * 1000;
    const maxEntries = Math.max(32, Math.min(config.radioPlanningCacheMaxEntries, 4096));
    this.linkCheckCache = new ManagedResponseCache<RadioLinkCheckResponse>({
      ttlMs,
      staleIfErrorMs,
      maxEntries
    });
    this.coverageCache = new ManagedResponseCache<RadioFeatureCollection>({
      ttlMs,
      staleIfErrorMs,
      maxEntries
    });
    this.siteSearchCache = new ManagedResponseCache<RadioFeatureCollection>({
      ttlMs,
      staleIfErrorMs,
      maxEntries
    });
  }

  cacheStats(): RadioPlanningCacheStats[] {
    return [
      { operation: "link_check", ...this.linkCheckCache.stats() },
      { operation: "coverage", ...this.coverageCache.stats() },
      { operation: "site_search", ...this.siteSearchCache.stats() }
    ];
  }

  async listProfiles(): Promise<RadioProfileCatalog> {
    const custom = await this.loadCustomProfiles();
    return {
      contractVersion: "sim-radio-profile-catalog-v1",
      generatedAt: new Date().toISOString(),
      profiles: [...BUILTIN_RADIO_PROFILES, ...custom].sort((left, right) => left.name.localeCompare(right.name, "cs")),
      warnings: [
        "Military profiles are generic non-sensitive planning templates, not exact equipment configurations.",
        RADIO_DISCLAIMER
      ]
    };
  }

  async saveCustomProfile(raw: unknown): Promise<RadioProfile> {
    const profile = normalizeProfile(raw, "custom");
    if (BUILTIN_RADIO_PROFILES.some((item) => item.profileId === profile.profileId)) {
      throw new RadioPlanningError(409, "CONFLICT", "Custom radio profileId conflicts with a built-in profile.");
    }
    const existing = await this.loadCustomProfiles();
    const next = [...existing.filter((item) => item.profileId !== profile.profileId), profile].sort((left, right) =>
      left.name.localeCompare(right.name, "cs")
    );
    await this.writeCustomProfiles(next);
    return profile;
  }

  async linkCheck(raw: unknown): Promise<RadioLinkCheckResponse> {
    const request = await this.parseLinkCheckRequest(raw);
    return this.linkCheckCache.getOrLoad(this.cacheKey("link_check", request), () => this.buildLinkCheck(request));
  }

  private async buildLinkCheck(request: NormalizedRadioLinkCheckRequest): Promise<RadioLinkCheckResponse> {
    const generatedAt = new Date().toISOString();
    const bbox = expandBboxByMeters(bboxForPoints([request.from, request.to]), 2000);
    const terrain = await this.createTerrainContext(bbox, "radio link-check");
    const result = await this.assessLink(request.profile, request.from, request.to, terrain, request.sampleStepM);
    return {
      contractVersion: "sim-radio-link-check-v1",
      generatedAt,
      source: {
        sourceId: "radio_planning_model",
        sourceType: "MODELLED_RADIO_ANALYSIS",
        generatedAt
      },
      profile: request.profile,
      query: {
        radioName: request.radioName,
        from: publicStation(request.from),
        to: publicStation(request.to),
        sampleStepM: request.sampleStepM
      },
      result: result.assessment,
      profileSamples: result.samples,
      warnings: [...terrain.warnings, ...profileWarnings(request.profile)]
    };
  }

  async coverage(raw: unknown): Promise<RadioFeatureCollection> {
    const request = await this.parseCoverageRequest(raw);
    return this.coverageCache.getOrLoad(this.cacheKey("coverage", request), () => this.buildCoverage(request));
  }

  private async buildCoverage(request: NormalizedRadioCoverageRequest): Promise<RadioFeatureCollection> {
    const generatedAt = new Date().toISOString();
    const radiusM = clamp(request.radiusM ?? request.profile.maxRadiusM, 250, Math.min(100_000, request.profile.maxRadiusM));
    const azimuthStepDeg = clamp(request.azimuthStepDeg ?? request.profile.defaultAzimuthStepDeg, 2, 90);
    const distanceStepM = normalizedDistanceStep(request.distanceStepM ?? request.profile.defaultDistanceStepM, radiusM, azimuthStepDeg);
    const terrain = await this.createTerrainContext(bboxAroundPoint(request.station.lon, request.station.lat, radiusM), "radio coverage");
    const features: RadioFeature[] = [];
    const qualityCounts = emptyQualityCounts();

    for (let bearingDeg = 0; bearingDeg < 360 && features.length < MAX_COVERAGE_FEATURES; bearingDeg += azimuthStepDeg) {
      const endBearingDeg = Math.min(360, bearingDeg + azimuthStepDeg);
      for (let innerRadiusM = 0; innerRadiusM < radiusM && features.length < MAX_COVERAGE_FEATURES; innerRadiusM += distanceStepM) {
        const outerRadiusM = Math.min(radiusM, innerRadiusM + distanceStepM);
        const centerBearingDeg = bearingDeg + (endBearingDeg - bearingDeg) / 2;
        const targetPoint = destinationPoint(request.station.lon, request.station.lat, centerBearingDeg, (innerRadiusM + outerRadiusM) / 2);
        const target: RadioStation = {
          lon: targetPoint.lon,
          lat: targetPoint.lat,
          antennaHeightM: request.profile.receiverHeightM
        };
        const link = await this.assessLink(request.profile, request.station, target, terrain);
        qualityCounts[link.assessment.quality] += 1;
        const featureId = `radio:coverage:${sanitizeId(request.profile.profileId)}:a${Math.round(bearingDeg)}:r${Math.round(outerRadiusM)}`;
        features.push({
          type: "Feature",
          id: featureId,
          geometry: {
            type: "Polygon",
            coordinates: [sectorPolygon(request.station.lon, request.station.lat, bearingDeg, endBearingDeg, innerRadiusM, outerRadiusM)]
          },
          properties: {
            featureId,
            analysisLayer: "radio_coverage",
            category: "radio_coverage_sector",
            label: `${request.profile.name} coverage estimate`,
            radioName: request.radioName,
            profileId: request.profile.profileId,
            quality: link.assessment.quality,
            linkStatus: link.assessment.linkStatus,
            confidence: confidenceForLink(link.assessment),
            estimatedRxPowerDbm: link.assessment.estimatedRxPowerDbm,
            linkMarginDb: link.assessment.linkMarginDb,
            lineOfSightClear: link.assessment.lineOfSightClear,
            terrainApplied: link.assessment.terrainApplied,
            terrainPenaltyDb: link.assessment.terrainPenaltyDb,
            maxObstructionM: link.assessment.maxObstructionM,
            minFresnelClearanceM: link.assessment.minFresnelClearanceM,
            distanceM: link.assessment.distanceM,
            bearingDeg: centerBearingDeg,
            modelVersion: RADIO_MODEL_VERSION,
            demSource: terrain.terrainAvailable ? this.config.demDatasetId : "not-applied",
            disclaimer: RADIO_DISCLAIMER
          }
        });
      }
    }

    const warnings = [...terrain.warnings, ...profileWarnings(request.profile)];
    if (features.length >= MAX_COVERAGE_FEATURES) {
      warnings.push("radio coverage reached the feature cap; increase step sizes or reduce radius for complete output.");
    }

    return {
      contractVersion: "sim-radio-coverage-v1",
      type: "FeatureCollection",
      generatedAt,
      source: {
        sourceId: "radio_planning_model",
        sourceType: "MODELLED_RADIO_ANALYSIS",
        generatedAt
      },
      profile: request.profile,
      query: {
        radioName: request.radioName,
        station: publicStation(request.station),
        radiusM,
        azimuthStepDeg,
        distanceStepM
      },
      summary: {
        featureCount: features.length,
        qualityCounts,
        terrainApplied: terrain.terrainAvailable,
        demSource: terrain.terrainAvailable ? this.config.demDatasetId : "not-applied",
        disclaimer: RADIO_DISCLAIMER
      },
      features,
      warnings
    };
  }

  async siteSearch(raw: unknown): Promise<RadioFeatureCollection> {
    const request = await this.parseSiteSearchRequest(raw);
    return this.siteSearchCache.getOrLoad(this.cacheKey("site_search", request), () => this.buildSiteSearch(request));
  }

  private async buildSiteSearch(request: NormalizedRadioSiteSearchRequest): Promise<RadioFeatureCollection> {
    const generatedAt = new Date().toISOString();
    const gridStepM = normalizeGridStep(request.gridStepM, request.searchArea);
    const candidates = candidateGrid(request.searchArea, gridStepM).slice(0, MAX_SITE_EVALUATION_POINTS);
    const terrain = await this.createTerrainContext(expandBboxByMeters(request.searchArea, 2000), "radio site-search");
    const scored: Array<{ feature: RadioFeature; score: number }> = [];

    for (const candidate of candidates) {
      const station: RadioStation = {
        lon: candidate.lon,
        lat: candidate.lat,
        antennaHeightM: request.stationAntennaHeightM ?? request.profile.antennaHeightM
      };
      const links = [];
      for (const target of request.targets) {
        links.push(await this.assessLink(request.profile, station, target, terrain));
      }
      const summary = summarizeCandidate(links.map((item) => item.assessment));
      const featureId = `radio:site:${sanitizeId(request.profile.profileId)}:${round(candidate.lon, 5)}:${round(candidate.lat, 5)}`;
      scored.push({
        score: summary.score,
        feature: {
          type: "Feature",
          id: featureId,
          geometry: {
            type: "Point",
            coordinates: [round(candidate.lon, 6), round(candidate.lat, 6)]
          },
          properties: {
            featureId,
            analysisLayer: "radio_site_search",
            category: "radio_site_candidate",
            label: `Candidate ${scored.length + 1}`,
            radioName: request.radioName,
            profileId: request.profile.profileId,
            score: summary.score,
            quality: summary.quality,
            worstLinkStatus: summary.worstLinkStatus,
            visibleTargetCount: summary.visibleTargetCount,
            targetCount: request.targets.length,
            coveredTargetPct: summary.coveredTargetPct,
            meanLinkMarginDb: summary.meanLinkMarginDb,
            minFresnelClearanceM: summary.minFresnelClearanceM,
            terrainApplied: terrain.terrainAvailable,
            modelVersion: RADIO_MODEL_VERSION,
            demSource: terrain.terrainAvailable ? this.config.demDatasetId : "not-applied",
            disclaimer: RADIO_DISCLAIMER
          }
        }
      });
    }

    const ranked = scored.sort((left, right) => right.score - left.score);
    const bestScore = ranked[0]?.score;
    const selected = ranked
      .slice(0, request.maxCandidates)
      .map((item, index) => ({
        ...item.feature,
        properties: {
          ...item.feature.properties,
          rank: index + 1,
          recommended: index < Math.min(3, request.maxCandidates)
        }
      }));

    const warnings = [...terrain.warnings, ...profileWarnings(request.profile)];
    if (candidates.length >= MAX_SITE_EVALUATION_POINTS) {
      warnings.push("radio site-search reached the evaluation cap; increase gridStepM or reduce the search area for exhaustive evaluation.");
    }

    return {
      contractVersion: "sim-radio-site-search-v1",
      type: "FeatureCollection",
      generatedAt,
      source: {
        sourceId: "radio_planning_model",
        sourceType: "MODELLED_RADIO_ANALYSIS",
        generatedAt
      },
      profile: request.profile,
      query: {
        radioName: request.radioName,
        searchArea: request.searchArea,
        targetCount: request.targets.length,
        gridStepM,
        maxCandidates: request.maxCandidates
      },
      summary: {
        evaluatedCandidateCount: candidates.length,
        returnedCandidateCount: selected.length,
        bestScore,
        terrainApplied: terrain.terrainAvailable,
        demSource: terrain.terrainAvailable ? this.config.demDatasetId : "not-applied",
        disclaimer: RADIO_DISCLAIMER
      },
      features: selected,
      warnings
    };
  }

  private async parseProfileRef(raw: Record<string, unknown>): Promise<RadioProfile> {
    if (isRecord(raw.profile)) {
      return normalizeProfile(raw.profile, "custom");
    }
    const profileId = cleanString(raw.profileId);
    if (!profileId) {
      throw new RadioPlanningError(400, "VALIDATION_ERROR", "profileId or profile is required.");
    }
    const catalog = await this.listProfiles();
    const profile = catalog.profiles.find((item) => item.profileId === profileId);
    if (!profile) {
      throw new RadioPlanningError(404, "NOT_FOUND", "Radio profile was not found.");
    }
    return profile;
  }

  private async parseLinkCheckRequest(raw: unknown): Promise<NormalizedRadioLinkCheckRequest> {
    if (!isRecord(raw)) {
      throw new RadioPlanningError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
    }
    const profile = await this.parseProfileRef(raw);
    return {
      profile,
      radioName: cleanString(raw.radioName),
      from: parseStation(raw.from, profile.antennaHeightM, "from"),
      to: parseStation(raw.to, profile.receiverHeightM, "to"),
      sampleStepM: optionalClampedNumber(raw.sampleStepM, 50, 2000)
    };
  }

  private async parseCoverageRequest(raw: unknown): Promise<NormalizedRadioCoverageRequest> {
    if (!isRecord(raw)) {
      throw new RadioPlanningError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
    }
    const profile = await this.parseProfileRef(raw);
    return {
      profile,
      radioName: cleanString(raw.radioName),
      station: parseStation(raw.station, profile.antennaHeightM, "station"),
      radiusM: optionalClampedNumber(raw.radiusM, 250, Math.min(100_000, profile.maxRadiusM)),
      azimuthStepDeg: optionalClampedNumber(raw.azimuthStepDeg, 2, 90),
      distanceStepM: optionalClampedNumber(raw.distanceStepM, 100, 5000)
    };
  }

  private async parseSiteSearchRequest(raw: unknown): Promise<NormalizedRadioSiteSearchRequest> {
    if (!isRecord(raw)) {
      throw new RadioPlanningError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
    }
    const profile = await this.parseProfileRef(raw);
    const targetsRaw = Array.isArray(raw.targets) ? raw.targets : [];
    const targets = targetsRaw.map((target, index) => parseStation(target, profile.receiverHeightM, `targets[${index}]`));
    if (targets.length === 0) {
      throw new RadioPlanningError(400, "VALIDATION_ERROR", "targets must contain at least one target point.");
    }
    return {
      profile,
      radioName: cleanString(raw.radioName),
      searchArea: parseSearchArea(raw.searchArea),
      targets,
      stationAntennaHeightM: optionalClampedNumber(raw.stationAntennaHeightM, 0.5, 100),
      gridStepM: optionalClampedNumber(raw.gridStepM, 100, 5000),
      maxCandidates: Math.trunc(optionalClampedNumber(raw.maxCandidates, 1, 100) ?? 20)
    };
  }

  private async assessLink(
    profile: RadioProfile,
    from: RadioStation,
    to: RadioStation,
    terrain: TerrainContext,
    sampleStepM?: number
  ): Promise<{ assessment: LinkAssessment; samples: TerrainProfileSample[] }> {
    const distanceM = distanceMeters(from.lon, from.lat, to.lon, to.lat);
    const azimuthDeg = bearingDegrees(from.lon, from.lat, to.lon, to.lat);
    const reverseAzimuthDeg = bearingDegrees(to.lon, to.lat, from.lon, from.lat);
    const fspl = freeSpacePathLossDb(distanceM, profile.frequencyMhz);
    const terrainProfile = terrain.terrainAvailable
      ? await sampleTerrainProfile(profile, from, to, terrain, sampleStepM ?? defaultSampleStep(distanceM))
      : undefined;
    const terrainPenalty = terrainProfile ? terrainPenaltyDb(terrainProfile.maxObstructionM, distanceM) : undefined;
    const txDbm = wattsToDbm(profile.txPowerW);
    const rxPowerDbm = Math.round(
      txDbm + profile.antennaGainDbi + profile.receiverAntennaGainDbi - profile.systemLossDb - fspl - (terrainPenalty ?? 0)
    );
    const marginDb = Math.round(rxPowerDbm - profile.receiverSensitivityDbm);
    const quality = qualityForMargin(marginDb);
    const linkStatus = linkStatusFor(quality, terrainProfile);

    return {
      assessment: {
        linkStatus,
        quality,
        lineOfSightClear: terrainProfile?.lineOfSightClear,
        distanceM: Math.round(distanceM),
        azimuthDeg: round(azimuthDeg, 1),
        reverseAzimuthDeg: round(reverseAzimuthDeg, 1),
        estimatedRxPowerDbm: rxPowerDbm,
        linkMarginDb: marginDb,
        freeSpacePathLossDb: Math.round(fspl),
        terrainPenaltyDb: terrainPenalty,
        maxObstructionM: terrainProfile?.maxObstructionM,
        minFresnelClearanceM: terrainProfile?.minFresnelClearanceM,
        minTerrainClearanceM: terrainProfile?.minTerrainClearanceM,
        requiredExtraAntennaHeightM: terrainProfile ? Math.max(0, Math.ceil(-terrainProfile.minFresnelClearanceM)) : undefined,
        fresnelClearancePct: terrainProfile?.fresnelClearancePct,
        terrainApplied: Boolean(terrainProfile)
      },
      samples: terrainProfile?.samples ?? []
    };
  }

  private cacheKey(
    operation: RadioPlanningCacheOperation,
    request: NormalizedRadioLinkCheckRequest | NormalizedRadioCoverageRequest | NormalizedRadioSiteSearchRequest
  ): string {
    return stableJson({
      operation,
      request,
      modelVersion: RADIO_MODEL_VERSION,
      terrain: {
        demEnabled: this.config.demEnabled,
        demConfigured: Boolean(this.config.demPostgisConnectionString),
        demDatasetId: this.config.demDatasetId,
        demLocalCacheDir: this.config.demLocalCacheDir
      }
    });
  }

  private async createTerrainContext(bbox: BoundingBox, purpose: string): Promise<TerrainContext> {
    if (!this.config.demEnabled || !this.config.demPostgisConnectionString) {
      return {
        demTiles: [],
        terrainAvailable: false,
        warnings: [`DEM is not enabled for ${purpose}; SIM returned a distance/link-budget estimate without terrain LoS.`]
      };
    }
    const sampler = new DemElevationSampler(this.config);
    const demTiles = await sampler.tilesForBbox(bbox);
    if (demTiles.length === 0) {
      return {
        sampler,
        demTiles,
        terrainAvailable: false,
        warnings: [`DEM tiles are not available for ${purpose}; SIM returned a distance/link-budget estimate without terrain LoS.`]
      };
    }
    return { sampler, demTiles, terrainAvailable: true, warnings: [] };
  }

  private async loadCustomProfiles(): Promise<RadioProfile[]> {
    try {
      const parsed = JSON.parse(await readFile(this.customProfilePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.flatMap((item) => {
        try {
          return [normalizeProfile(item, "custom")];
        } catch {
          return [];
        }
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async writeCustomProfiles(profiles: RadioProfile[]): Promise<void> {
    await mkdir(dirname(this.customProfilePath), { recursive: true });
    const tmp = `${this.customProfilePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(profiles, null, 2)}\n`, "utf8");
    await rename(tmp, this.customProfilePath);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .flatMap((key) => {
          const next = record[key];
          return next === undefined ? [] : [[key, stableValue(next)]];
        })
    );
  }
  return value;
}

async function sampleTerrainProfile(
  profile: RadioProfile,
  from: RadioStation,
  to: RadioStation,
  terrain: TerrainContext,
  sampleStepM: number
): Promise<{
  lineOfSightClear: boolean;
  maxObstructionM: number;
  minFresnelClearanceM: number;
  minTerrainClearanceM: number;
  fresnelClearancePct: number;
  samples: TerrainProfileSample[];
} | undefined> {
  if (!terrain.sampler || terrain.demTiles.length === 0) {
    return undefined;
  }
  const distanceM = distanceMeters(from.lon, from.lat, to.lon, to.lat);
  const sampleCount = Math.max(3, Math.min(401, Math.ceil(distanceM / sampleStepM) + 1));
  const fromSample = await terrain.sampler.sample(from.lon, from.lat, terrain.demTiles);
  const toSample = await terrain.sampler.sample(to.lon, to.lat, terrain.demTiles);
  if (!fromSample || !toSample) {
    return undefined;
  }

  const fromHeightM = fromSample.elevationM + from.antennaHeightM;
  const toHeightM = toSample.elevationM + to.antennaHeightM;
  const wavelengthM = 300 / profile.frequencyMhz;
  const samples: TerrainProfileSample[] = [];
  let minFresnelClearanceM = Infinity;
  let minTerrainClearanceM = Infinity;

  for (let index = 0; index < sampleCount; index += 1) {
    const ratio = sampleCount === 1 ? 0 : index / (sampleCount - 1);
    const lon = from.lon + (to.lon - from.lon) * ratio;
    const lat = from.lat + (to.lat - from.lat) * ratio;
    const distanceFromStartM = distanceM * ratio;
    const sample = await terrain.sampler.sample(lon, lat, terrain.demTiles);
    const lineHeightM = fromHeightM + (toHeightM - fromHeightM) * ratio;
    const d1 = distanceFromStartM;
    const d2 = Math.max(0, distanceM - distanceFromStartM);
    const fresnelRadiusM = d1 <= 0 || d2 <= 0 || distanceM <= 0 ? 0 : Math.sqrt((wavelengthM * d1 * d2) / distanceM);
    const requiredFresnelM = fresnelRadiusM * (profile.requiredFresnelClearancePct / 100);
    const terrainClearanceM = sample ? lineHeightM - sample.elevationM : undefined;
    const fresnelClearanceM = terrainClearanceM === undefined ? undefined : terrainClearanceM - requiredFresnelM;
    if (terrainClearanceM !== undefined) {
      minTerrainClearanceM = Math.min(minTerrainClearanceM, terrainClearanceM);
    }
    if (fresnelClearanceM !== undefined) {
      minFresnelClearanceM = Math.min(minFresnelClearanceM, fresnelClearanceM);
    }
    samples.push({
      lon: round(lon, 6),
      lat: round(lat, 6),
      distanceM: Math.round(distanceFromStartM),
      terrainElevationM: sample?.elevationM,
      lineHeightM: round(lineHeightM, 1),
      fresnelRadiusM: round(fresnelRadiusM, 1),
      terrainClearanceM: terrainClearanceM === undefined ? undefined : round(terrainClearanceM, 1),
      fresnelClearanceM: fresnelClearanceM === undefined ? undefined : round(fresnelClearanceM, 1),
      tileId: sample?.tileId
    });
  }

  if (!Number.isFinite(minFresnelClearanceM) || !Number.isFinite(minTerrainClearanceM)) {
    return undefined;
  }

  const maxObstructionM = Math.max(0, Math.ceil(-minFresnelClearanceM));
  const centerSample = samples[Math.floor(samples.length / 2)];
  const centerFresnelRadiusM = optionalNumber(centerSample?.fresnelRadiusM) ?? 0;
  const fresnelClearancePct =
    centerFresnelRadiusM > 0 ? Math.max(0, Math.min(100, Math.round(((centerFresnelRadiusM + minFresnelClearanceM) / centerFresnelRadiusM) * 100))) : 100;

  return {
    lineOfSightClear: minFresnelClearanceM >= 0,
    maxObstructionM,
    minFresnelClearanceM: round(minFresnelClearanceM, 1),
    minTerrainClearanceM: round(minTerrainClearanceM, 1),
    fresnelClearancePct,
    samples
  };
}

function builtin(
  profileId: string,
  name: string,
  category: RadioProfileCategory,
  frequencyMhz: number,
  txPowerW: number,
  antennaHeightM: number,
  receiverHeightM: number,
  antennaGainDbi: number,
  receiverAntennaGainDbi: number,
  systemLossDb: number,
  receiverSensitivityDbm: number,
  maxRadiusM: number,
  defaultAzimuthStepDeg: number,
  defaultDistanceStepM: number,
  notes: string[],
  modelApplicability: RadioProfile["modelApplicability"] = "terrain_los"
): RadioProfile {
  return {
    profileId,
    name,
    category,
    source: "builtin",
    frequencyMhz,
    txPowerW,
    antennaHeightM,
    receiverHeightM,
    antennaGainDbi,
    receiverAntennaGainDbi,
    systemLossDb,
    receiverSensitivityDbm,
    requiredFresnelClearancePct: DEFAULT_REQUIRED_FRESNEL_CLEARANCE_PCT,
    maxRadiusM,
    defaultAzimuthStepDeg,
    defaultDistanceStepM,
    modelApplicability,
    sensitiveUse: category === "military_generic",
    notes
  };
}

function normalizeProfile(raw: unknown, source: RadioProfileSource): RadioProfile {
  if (!isRecord(raw)) {
    throw new RadioPlanningError(400, "VALIDATION_ERROR", "Radio profile must be a JSON object.");
  }
  const name = cleanString(raw.name);
  if (!name) {
    throw new RadioPlanningError(400, "VALIDATION_ERROR", "Radio profile name is required.");
  }
  const profileId = cleanString(raw.profileId) ?? `custom_${slugify(name)}`;
  if (!/^[a-zA-Z0-9:_-]{3,80}$/.test(profileId)) {
    throw new RadioPlanningError(400, "VALIDATION_ERROR", "Radio profileId must contain 3-80 letters, digits, colon, underscore or hyphen characters.");
  }
  const frequencyMhz = requiredNumber(raw.frequencyMhz, "frequencyMhz", 0.1, 100_000);
  const txPowerW = optionalClampedNumber(raw.txPowerW, 0.001, 1000) ?? 5;
  const antennaHeightM = requiredNumber(raw.antennaHeightM, "antennaHeightM", 0.1, 200);
  const receiverHeightM = requiredNumber(raw.receiverHeightM, "receiverHeightM", 0.1, 200);
  const category = parseCategory(raw.category);
  return {
    profileId,
    name,
    category,
    source,
    frequencyMhz,
    txPowerW,
    antennaHeightM,
    receiverHeightM,
    antennaGainDbi: optionalClampedNumber(raw.antennaGainDbi, -20, 60) ?? 0,
    receiverAntennaGainDbi: optionalClampedNumber(raw.receiverAntennaGainDbi, -20, 60) ?? optionalClampedNumber(raw.antennaGainDbi, -20, 60) ?? 0,
    systemLossDb: optionalClampedNumber(raw.systemLossDb, 0, 60) ?? 2,
    receiverSensitivityDbm: optionalClampedNumber(raw.receiverSensitivityDbm, -160, -40) ?? defaultReceiverSensitivityDbm(frequencyMhz),
    requiredFresnelClearancePct: optionalClampedNumber(raw.requiredFresnelClearancePct, 0, 100) ?? DEFAULT_REQUIRED_FRESNEL_CLEARANCE_PCT,
    maxRadiusM: Math.trunc(requiredNumber(raw.maxRadiusM, "maxRadiusM", 250, 100_000)),
    defaultAzimuthStepDeg: Math.trunc(optionalClampedNumber(raw.defaultAzimuthStepDeg, 2, 90) ?? 10),
    defaultDistanceStepM: Math.trunc(optionalClampedNumber(raw.defaultDistanceStepM, 100, 5000) ?? 500),
    modelApplicability: raw.modelApplicability === "limited_for_beyond_line_of_sight" ? "limited_for_beyond_line_of_sight" : "terrain_los",
    sensitiveUse: Boolean(raw.sensitiveUse) || category === "military_generic",
    notes: Array.isArray(raw.notes) ? raw.notes.flatMap((item) => (typeof item === "string" ? [item] : [])).slice(0, 8) : []
  };
}

function parseCategory(value: unknown): RadioProfileCategory {
  const raw = cleanString(value);
  if (
    raw === "civil" ||
    raw === "amateur" ||
    raw === "business" ||
    raw === "public_safety" ||
    raw === "military_generic" ||
    raw === "iot" ||
    raw === "data_link"
  ) {
    return raw;
  }
  return "civil";
}

function parseStation(raw: unknown, fallbackHeightM: number, fieldName: string): RadioStation {
  if (!isRecord(raw)) {
    throw new RadioPlanningError(400, "VALIDATION_ERROR", `${fieldName} must be a station object.`);
  }
  const lon = requiredNumber(raw.lon, `${fieldName}.lon`, -180, 180);
  const lat = requiredNumber(raw.lat, `${fieldName}.lat`, -90, 90);
  return {
    lon,
    lat,
    antennaHeightM: optionalClampedNumber(raw.antennaHeightM ?? raw.receiverHeightM, 0.1, 200) ?? fallbackHeightM,
    label: cleanString(raw.label)
  };
}

function parseSearchArea(raw: unknown): BoundingBox {
  const source = isRecord(raw) && Array.isArray(raw.bbox) ? raw.bbox : raw;
  if (!Array.isArray(source) || source.length !== 4) {
    throw new RadioPlanningError(400, "VALIDATION_ERROR", "searchArea.bbox must be [west,south,east,north].");
  }
  const west = Number(source[0]);
  const south = Number(source[1]);
  const east = Number(source[2]);
  const north = Number(source[3]);
  if (![west, south, east, north].every(Number.isFinite) || west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
    throw new RadioPlanningError(400, "VALIDATION_ERROR", "searchArea.bbox coordinates are outside WGS84 bounds or not ordered.");
  }
  return { west, south, east, north };
}

function requiredNumber(value: unknown, fieldName: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new RadioPlanningError(400, "VALIDATION_ERROR", `${fieldName} must be a number between ${min} and ${max}.`);
  }
  return parsed;
}

function optionalClampedNumber(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return clamp(parsed, min, max);
}

function publicStation(station: RadioStation): Record<string, unknown> {
  return {
    lon: station.lon,
    lat: station.lat,
    antennaHeightM: station.antennaHeightM,
    ...(station.label ? { label: station.label } : {})
  };
}

function profileWarnings(profile: RadioProfile): string[] {
  return [
    ...(profile.sensitiveUse ? ["Selected military profile is a generic non-sensitive template, not an exact operational radio configuration."] : []),
    ...(profile.modelApplicability === "limited_for_beyond_line_of_sight"
      ? ["Selected low-band profile can propagate beyond terrain line-of-sight; DEM LoS is only a partial planning indicator."]
      : []),
    RADIO_DISCLAIMER
  ];
}

function freeSpacePathLossDb(distanceM: number, frequencyMhz: number): number {
  const distanceKm = Math.max(0.001, distanceM / 1000);
  return 32.44 + 20 * Math.log10(distanceKm) + 20 * Math.log10(frequencyMhz);
}

function wattsToDbm(watts: number): number {
  return 30 + 10 * Math.log10(Math.max(0.001, watts));
}

function defaultReceiverSensitivityDbm(frequencyMhz: number): number {
  if (frequencyMhz >= 1000) {
    return -100;
  }
  if (frequencyMhz >= 300) {
    return -116;
  }
  return -120;
}

function qualityForMargin(marginDb: number): RadioQuality {
  if (marginDb >= 20) {
    return "good";
  }
  if (marginDb >= 10) {
    return "fair";
  }
  if (marginDb >= 0) {
    return "weak";
  }
  return "none";
}

function linkStatusFor(quality: RadioQuality, terrain: Awaited<ReturnType<typeof sampleTerrainProfile>>): RadioLinkStatus {
  if (!terrain) {
    return quality === "none" ? "unknown" : "marginal";
  }
  if (terrain.minFresnelClearanceM >= 0 && quality !== "none") {
    return "clear";
  }
  if (terrain.minFresnelClearanceM >= -5 && quality !== "none") {
    return "marginal";
  }
  return "obstructed";
}

function confidenceForLink(link: LinkAssessment): number {
  const base = link.terrainApplied ? 0.78 : 0.42;
  const margin = link.linkMarginDb === undefined ? 0 : Math.max(-0.12, Math.min(0.12, link.linkMarginDb / 250));
  return round(Math.max(0.2, Math.min(0.9, base + margin)), 2);
}

function summarizeCandidate(links: LinkAssessment[]): {
  score: number;
  quality: RadioQuality;
  worstLinkStatus: RadioLinkStatus;
  visibleTargetCount: number;
  coveredTargetPct: number;
  meanLinkMarginDb?: number;
  minFresnelClearanceM?: number;
} {
  const visibleTargetCount = links.filter((link) => link.linkStatus === "clear" || link.linkStatus === "marginal").length;
  const margins = links.flatMap((link) => (link.linkMarginDb === undefined ? [] : [link.linkMarginDb]));
  const clearances = links.flatMap((link) => (link.minFresnelClearanceM === undefined ? [] : [link.minFresnelClearanceM]));
  const meanLinkMarginDb = margins.length > 0 ? round(margins.reduce((sum, item) => sum + item, 0) / margins.length, 1) : undefined;
  const minFresnelClearanceM = clearances.length > 0 ? round(Math.min(...clearances), 1) : undefined;
  const coveredTargetPct = links.length > 0 ? Math.round((visibleTargetCount / links.length) * 100) : 0;
  const marginScore = meanLinkMarginDb === undefined ? 10 : Math.max(0, Math.min(20, meanLinkMarginDb + 10));
  const clearanceScore = minFresnelClearanceM === undefined ? 5 : Math.max(0, Math.min(10, minFresnelClearanceM + 5));
  const score = Math.round(coveredTargetPct * 0.7 + marginScore + clearanceScore);
  return {
    score,
    quality: score >= 80 ? "good" : score >= 60 ? "fair" : score >= 35 ? "weak" : "none",
    worstLinkStatus: worstStatus(links.map((link) => link.linkStatus)),
    visibleTargetCount,
    coveredTargetPct,
    meanLinkMarginDb,
    minFresnelClearanceM
  };
}

function worstStatus(statuses: RadioLinkStatus[]): RadioLinkStatus {
  if (statuses.includes("obstructed")) {
    return "obstructed";
  }
  if (statuses.includes("unknown")) {
    return "unknown";
  }
  if (statuses.includes("marginal")) {
    return "marginal";
  }
  return "clear";
}

function terrainPenaltyDb(obstructionM: number, distanceM: number): number {
  if (obstructionM <= 0) {
    return 0;
  }
  const distanceFactor = distanceM > 10_000 ? 1.15 : distanceM > 4000 ? 1 : 0.85;
  return Math.round(Math.min(35, (7 + obstructionM * 0.42) * distanceFactor));
}

function emptyQualityCounts(): Record<RadioQuality, number> {
  return { good: 0, fair: 0, weak: 0, none: 0, unknown: 0 };
}

function normalizedDistanceStep(value: number, radiusM: number, azimuthStepDeg: number): number {
  const normalized = Math.trunc(clamp(value, 100, 5000));
  const azimuthBands = Math.ceil(360 / azimuthStepDeg);
  const distanceBands = Math.ceil(radiusM / normalized);
  if (azimuthBands * distanceBands <= MAX_COVERAGE_FEATURES) {
    return normalized;
  }
  return Math.ceil(radiusM / Math.max(1, Math.floor(MAX_COVERAGE_FEATURES / azimuthBands)));
}

function normalizeGridStep(value: number | undefined, bbox: BoundingBox): number {
  const requested = Math.trunc(clamp(value ?? 500, 100, 5000));
  const centerLat = (bbox.south + bbox.north) / 2;
  const widthM = (bbox.east - bbox.west) * metersPerDegreeLon(centerLat);
  const heightM = (bbox.north - bbox.south) * 111_320;
  const count = Math.ceil(widthM / requested) * Math.ceil(heightM / requested);
  if (count <= MAX_SITE_EVALUATION_POINTS) {
    return requested;
  }
  return Math.ceil(Math.sqrt((widthM * heightM) / MAX_SITE_EVALUATION_POINTS));
}

function candidateGrid(bbox: BoundingBox, gridStepM: number): Array<{ lon: number; lat: number }> {
  const centerLat = (bbox.south + bbox.north) / 2;
  const lonStep = gridStepM / metersPerDegreeLon(centerLat);
  const latStep = gridStepM / 111_320;
  const candidates: Array<{ lon: number; lat: number }> = [];
  for (let lat = bbox.south + latStep / 2; lat < bbox.north; lat += latStep) {
    for (let lon = bbox.west + lonStep / 2; lon < bbox.east; lon += lonStep) {
      candidates.push({ lon, lat });
      if (candidates.length >= MAX_SITE_EVALUATION_POINTS) {
        return candidates;
      }
    }
  }
  return candidates;
}

function bboxForPoints(points: Array<{ lon: number; lat: number }>): BoundingBox {
  return points.reduce(
    (acc, point) => ({
      west: Math.min(acc.west, point.lon),
      south: Math.min(acc.south, point.lat),
      east: Math.max(acc.east, point.lon),
      north: Math.max(acc.north, point.lat)
    }),
    { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }
  );
}

function bboxAroundPoint(lon: number, lat: number, radiusM: number): BoundingBox {
  return expandBboxByMeters({ west: lon, south: lat, east: lon, north: lat }, radiusM);
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
    const point = destinationPoint(lon, lat, startBearingDeg + ((endBearingDeg - startBearingDeg) * index) / arcSegments, outerRadiusM);
    outerArc.push([round(point.lon, 6), round(point.lat, 6)]);
  }
  if (innerRadiusM <= 0) {
    return [[round(lon, 6), round(lat, 6)], ...outerArc, [round(lon, 6), round(lat, 6)]];
  }
  const innerArc: Array<[number, number]> = [];
  for (let index = arcSegments; index >= 0; index -= 1) {
    const point = destinationPoint(lon, lat, startBearingDeg + ((endBearingDeg - startBearingDeg) * index) / arcSegments, innerRadiusM);
    innerArc.push([round(point.lon, 6), round(point.lat, 6)]);
  }
  return [...outerArc, ...innerArc, outerArc[0] ?? [round(lon, 6), round(lat, 6)]];
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

function bearingDegrees(lonA: number, latA: number, lonB: number, latB: number): number {
  const dx = (lonB - lonA) * metersPerDegreeLon((latA + latB) / 2);
  const dy = (latB - latA) * 111_320;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
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

function defaultSampleStep(distanceM: number): number {
  if (distanceM <= 5000) {
    return 100;
  }
  if (distanceM <= 20_000) {
    return 250;
  }
  return 500;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
