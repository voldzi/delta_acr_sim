import type { SituationDataConfig } from "./config.js";
import { allSourceDescriptors } from "./sources.js";
import type {
  ProviderCatalogAudience,
  ProviderCatalogLayer,
  ProviderCatalogSource,
  ProviderCatalogSourceRole,
  ProviderMapCatalog,
  SituationDataSourceId,
  SituationLayerId,
  SourceDescriptor
} from "./types.js";

const PROVIDER_ID = "sim.situation-data" as const;
const MAP_CATALOG_DOCUMENT = "docs/provider/02_MAP_CATALOG_PROVIDER_CONTRACT.md";
const DEFAULT_MAX_FEATURES = 250;

export function buildSituationMapCatalog(config: SituationDataConfig, generatedAt = new Date().toISOString()): ProviderMapCatalog {
  const descriptors = allSourceDescriptors(config);
  return {
    contractVersion: "provider-map-catalog-v1",
    catalogVersion: "provider-map-catalog-v1",
    providerId: PROVIDER_ID,
    generatedAt,
    status: "online",
    authority: {
      contractVersion: "map-catalog-v1",
      catalogVersion: "map-catalog-v1",
      document: MAP_CATALOG_DOCUMENT
    },
    layers: buildProviderLayers(config),
    sources: descriptors.map((descriptor) => buildProviderSource(descriptor, config))
  };
}

function buildProviderLayers(config: SituationDataConfig): ProviderCatalogLayer[] {
  return [
    {
      providerLayerId: "weather.open_meteo",
      recommendedCatalogLayerId: "public.weather.current",
      label: "Počasí",
      description: "Aktuální počasí pro mapový výřez z cacheovaného Open-Meteo zdroje.",
      categoryPath: ["weather", "current"],
      categories: ["weather"],
      role: "primary",
      audience: "public",
      kind: "vector_features",
      defaultVisible: true,
      selectable: true,
      geometryTypes: ["Point"],
      minZoom: 4,
      maxZoom: 18,
      refreshSeconds: 300,
      cacheTtlSeconds: config.openMeteoCacheTtlSeconds,
      styleProfile: "current-weather-v1",
      sourceIds: ["open_meteo"],
      query: query(["weather"], ["open_meteo"]),
      legend: { profile: "current-weather-v1" },
      legal: {
        attribution: "Weather data by Open-Meteo.com",
        notes: ["Free API conditions and commercial use restrictions are described in source metadata."]
      }
    },
    {
      providerLayerId: "weather.aviation_weather",
      recommendedCatalogLayerId: "public.weather.aviation",
      label: "Letištní počasí",
      description: "METAR/TAF letecké počasí pro letiště v mapovém výřezu.",
      categoryPath: ["weather", "aviation"],
      categories: ["weather", "aviation_weather"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Point"],
      minZoom: 6,
      maxZoom: 18,
      refreshSeconds: 600,
      cacheTtlSeconds: config.aviationWeatherCacheTtlSeconds,
      styleProfile: "aviation-weather-v1",
      sourceIds: ["aviation_weather"],
      query: query(["weather"], ["aviation_weather"]),
      legend: { profile: "aviation-weather-v1" },
      legal: {
        attribution: "NOAA Aviation Weather Center",
        notes: ["Use as situational weather reference, not as a flight planning service."]
      }
    },
    {
      providerLayerId: "mobile_network",
      recommendedCatalogLayerId: "public.mobile.network",
      label: "Mobilní síť",
      description: "Sjednocené občanské hodnocení dostupnosti mobilní sítě.",
      categoryPath: ["communications", "mobile"],
      categories: ["mobile_network"],
      role: "overlay",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Polygon"],
      minZoom: 6,
      maxZoom: 18,
      refreshSeconds: 300,
      cacheTtlSeconds: config.mobileNetworkCacheTtlSeconds,
      styleProfile: "mobile-network-quality-v1",
      sourceIds: ["mobile_network_model"],
      technicalInputs: ["mobile_coverage_model", "ctu_nettest", "ctu_stationary_mobile", "osm_postgis"],
      filters: [
        {
          filterId: "technology",
          label: "Technologie",
          type: "multi_select",
          values: ["2G", "4G", "5G"],
          defaultValue: ["4G"]
        }
      ],
      query: query(["mobile_network"], ["mobile_network_model"]),
      legend: { profile: "mobile-network-quality-v1" },
      model: {
        modelVersion: `${config.mobileCoverageModelVersion}+mobile-network-v1`,
        terrainAware: config.mobileCoverageTerrainAware,
        demSource: mobileModelDemSource(config),
        confidenceExplanation: "Combines public measurements, inferred coverage and OSM infrastructure hints."
      },
      legal: {
        attribution: "Czech Telecommunication Office / CTU-NetTest / ČTÚ open data; OpenStreetMap contributors where tower hints are used",
        notes: ["Modelový odhad, ne garantované pokrytí ani potvrzený výpadek operátora."]
      },
      supersedes: ["mobile", "mobile_coverage"]
    },
    {
      providerLayerId: "mobile_coverage",
      recommendedCatalogLayerId: "diagnostic.mobile.coverage",
      label: "Technický odhad pokrytí",
      description: "Diagnostická modelová vrstva pokrytí používaná jako vstup pro finální hodnocení mobilní sítě.",
      categoryPath: ["diagnostic", "communications", "mobile"],
      categories: ["mobile_coverage"],
      role: "diagnostic",
      audience: "diagnostic",
      kind: "vector_features",
      defaultVisible: false,
      selectable: false,
      geometryTypes: ["Polygon"],
      minZoom: 6,
      maxZoom: 18,
      refreshSeconds: 21600,
      cacheTtlSeconds: config.mobileCoverageCacheTtlSeconds,
      styleProfile: "mobile-coverage-diagnostic-v1",
      sourceIds: ["mobile_coverage_model"],
      technicalInputs: ["osm_postgis"],
      filters: [
        {
          filterId: "technology",
          label: "Technologie",
          type: "multi_select",
          values: ["2G", "4G", "5G"],
          defaultValue: ["4G"]
        }
      ],
      query: query(["mobile_coverage"], ["mobile_coverage_model"]),
      legend: { profile: "mobile-coverage-diagnostic-v1" },
      model: {
        modelVersion: config.mobileCoverageModelVersion,
        terrainAware: config.mobileCoverageTerrainAware,
        demSource: mobileModelDemSource(config),
        confidenceExplanation: "Distance/path-loss estimate from imported OSM communication tower references."
      },
      legal: {
        attribution: "OpenStreetMap contributors where tower hints are used",
        notes: ["Technický vstup pro model, ne běžná uživatelská vrstva."]
      },
      replacedBy: "public.mobile.network"
    },
    {
      providerLayerId: "mobile.ctu_nettest",
      recommendedCatalogLayerId: "diagnostic.mobile.ctu_measurements",
      label: "ČTÚ měření",
      description: "Diagnostické body veřejných měření ČTÚ NetTest používané jako vstup modelu.",
      categoryPath: ["diagnostic", "communications", "mobile"],
      categories: ["network_measurement", "mobile"],
      role: "diagnostic",
      audience: "diagnostic",
      kind: "vector_features",
      defaultVisible: false,
      selectable: false,
      geometryTypes: ["Point"],
      minZoom: 8,
      maxZoom: 18,
      refreshSeconds: 3600,
      cacheTtlSeconds: 3600,
      styleProfile: "ctu-nettest-measurements-v1",
      sourceIds: ["ctu_nettest"],
      query: query(["mobile"], ["ctu_nettest"]),
      legend: { profile: "ctu-nettest-measurements-v1" },
      legal: {
        attribution: "Czech Telecommunication Office / CTU-NetTest",
        notes: ["Surová veřejná měření jsou technický vstup; běžné zobrazení má používat vrstvu Mobilní síť."]
      },
      replacedBy: "public.mobile.network"
    },
    {
      providerLayerId: "mobile.ctu_stationary",
      recommendedCatalogLayerId: "diagnostic.mobile.ctu_stationary_measurements",
      label: "ČTÚ stacionární měření",
      description: "Diagnostické body oficiálních stacionárních měření mobilního signálu ČTÚ 2G/4G po operátorech.",
      categoryPath: ["diagnostic", "communications", "mobile"],
      categories: ["network_stationary_measurement", "mobile"],
      role: "diagnostic",
      audience: "diagnostic",
      kind: "vector_features",
      defaultVisible: false,
      selectable: false,
      geometryTypes: ["Point"],
      minZoom: 8,
      maxZoom: 18,
      refreshSeconds: 86400,
      cacheTtlSeconds: config.ctuStationaryMobileCacheTtlSeconds,
      styleProfile: "ctu-stationary-mobile-measurements-v1",
      sourceIds: ["ctu_stationary_mobile"],
      query: query(["mobile"], ["ctu_stationary_mobile"]),
      legend: { profile: "ctu-stationary-mobile-measurements-v1" },
      legal: {
        attribution: "Český telekomunikační úřad",
        notes: ["Oficiální historická měření v terénu; běžné zobrazení má používat finální vrstvu Mobilní síť."]
      },
      replacedBy: "public.mobile.network"
    },
    {
      providerLayerId: "mobile.osm_postgis.communications",
      recommendedCatalogLayerId: "reference.infrastructure.communications",
      label: "Komunikační infrastruktura",
      description: "Referenční komunikační věže z lokálního OSM/PostGIS importu.",
      categoryPath: ["reference", "infrastructure", "communications"],
      categories: ["communications_tower"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: false,
      geometryTypes: ["Point"],
      minZoom: 10,
      maxZoom: 18,
      refreshSeconds: 21600,
      cacheTtlSeconds: config.osmPostgisCacheTtlSeconds,
      styleProfile: "communications-infrastructure-v1",
      sourceIds: ["osm_postgis"],
      query: query(["mobile"], ["osm_postgis"], ["communications_tower"]),
      legend: { profile: "communications-infrastructure-v1" },
      legal: {
        attribution: "OpenStreetMap contributors",
        notes: ["Referenční infrastruktura, ne stav dostupnosti služby."]
      }
    },
    {
      providerLayerId: "ground.osm_postgis.healthcare",
      recommendedCatalogLayerId: "reference.infrastructure.healthcare",
      label: "Zdravotnictví",
      description: "Nemocnice, kliniky, lékaři a lékárny z lokálního OSM/PostGIS importu.",
      categoryPath: ["reference", "infrastructure", "healthcare"],
      categories: ["hospital", "clinic", "doctors", "pharmacy"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Point", "LineString", "Polygon"],
      minZoom: 8,
      maxZoom: 18,
      refreshSeconds: 21600,
      cacheTtlSeconds: config.osmPostgisCacheTtlSeconds,
      styleProfile: "infrastructure-healthcare-v1",
      sourceIds: ["osm_postgis"],
      query: query(["ground"], ["osm_postgis"], ["hospital", "clinic", "doctors", "pharmacy"]),
      legend: { profile: "infrastructure-healthcare-v1" },
      legal: {
        attribution: "OpenStreetMap contributors",
        notes: ["Referenční veřejný kontext, ne autoritativní registr IZS."]
      }
    },
    {
      providerLayerId: "ground.osm_postgis.emergency",
      recommendedCatalogLayerId: "reference.infrastructure.emergency",
      label: "Záchranná infrastruktura",
      description: "Hasiči, policie, záchranné a nouzové body z lokálního OSM/PostGIS importu.",
      categoryPath: ["reference", "infrastructure", "emergency"],
      categories: ["fire_station", "police", "ambulance_station", "shelter"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Point", "LineString", "Polygon"],
      minZoom: 8,
      maxZoom: 18,
      refreshSeconds: 21600,
      cacheTtlSeconds: config.osmPostgisCacheTtlSeconds,
      styleProfile: "infrastructure-emergency-v1",
      sourceIds: ["osm_postgis"],
      query: query(["ground"], ["osm_postgis"], ["fire_station", "police", "ambulance_station", "shelter"]),
      legend: { profile: "infrastructure-emergency-v1" },
      legal: {
        attribution: "OpenStreetMap contributors",
        notes: ["Referenční veřejný kontext, ne autoritativní registr IZS."]
      }
    },
    {
      providerLayerId: "ground.osm_postgis.civic",
      recommendedCatalogLayerId: "reference.infrastructure.civic",
      label: "Veřejná správa",
      description: "Obecní úřady a další veřejné referenční body z lokálního OSM/PostGIS importu.",
      categoryPath: ["reference", "infrastructure", "civic"],
      categories: ["townhall"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Point", "LineString", "Polygon"],
      minZoom: 8,
      maxZoom: 18,
      refreshSeconds: 21600,
      cacheTtlSeconds: config.osmPostgisCacheTtlSeconds,
      styleProfile: "infrastructure-civic-v1",
      sourceIds: ["osm_postgis"],
      query: query(["ground"], ["osm_postgis"], ["townhall"]),
      legend: { profile: "infrastructure-civic-v1" },
      legal: {
        attribution: "OpenStreetMap contributors",
        notes: ["Referenční veřejný kontext."]
      }
    },
    {
      providerLayerId: "traffic.pid_gtfs_rt",
      recommendedCatalogLayerId: "public.traffic.transit",
      label: "Doprava",
      description: "Živý dopravní kontext veřejné dopravy z PID/Golemio GTFS-RT.",
      categoryPath: ["traffic", "transit"],
      categories: ["traffic", "transit_vehicle"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Point", "LineString"],
      minZoom: 6,
      maxZoom: 18,
      refreshSeconds: 20,
      cacheTtlSeconds: 20,
      styleProfile: "transit-vehicle-position-v1",
      sourceIds: ["pid_gtfs_rt"],
      query: query(["traffic"], ["pid_gtfs_rt"]),
      legend: { profile: "transit-vehicle-position-v1" },
      legal: {
        attribution: "PID / Golemio Open Data",
        notes: ["Dopravní kontext, ne bezpečnostní track."]
      }
    },
    {
      providerLayerId: "warnings.safety_data_projection",
      recommendedCatalogLayerId: "public.safety.warnings",
      label: "Veřejné výstrahy (kompatibilní projekce)",
      description: "Kompatibilní projekce výstrah ze Safety Data API. COP má preferovat provider sim.safety-data.",
      categoryPath: ["safety", "warnings"],
      categories: ["warning", "safety_warning"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: false,
      geometryTypes: ["Point", "Polygon"],
      minZoom: 4,
      maxZoom: 18,
      refreshSeconds: 300,
      cacheTtlSeconds: config.safetyDataCacheTtlSeconds,
      styleProfile: "safety-warning-v1",
      sourceIds: ["safety_data"],
      query: query(["warnings"], ["safety_data"]),
      legend: { profile: "safety-warning-v1" },
      legal: {
        attribution: "Safety Data API; feature-level attribution preserved from original public sources",
        notes: ["Compatibility projection only; prefer sim.safety-data catalog provider for safety layers."]
      },
      compatibilityOnly: true,
      preferredProviderId: "sim.safety-data"
    },
    {
      providerLayerId: "flood.safety_data_projection",
      recommendedCatalogLayerId: "public.safety.flood",
      label: "Povodně a voda (kompatibilní projekce)",
      description: "Kompatibilní projekce hydrologických dat ze Safety Data API. COP má preferovat provider sim.safety-data.",
      categoryPath: ["safety", "flood"],
      categories: ["flood", "hydrology"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: false,
      geometryTypes: ["Point"],
      minZoom: 4,
      maxZoom: 18,
      refreshSeconds: 300,
      cacheTtlSeconds: config.safetyDataCacheTtlSeconds,
      styleProfile: "safety-flood-v1",
      sourceIds: ["safety_data"],
      query: query(["flood"], ["safety_data"]),
      legend: { profile: "safety-flood-v1" },
      legal: {
        attribution: "Safety Data API; feature-level attribution preserved from original public sources",
        notes: ["Compatibility projection only; prefer sim.safety-data catalog provider for safety layers."]
      },
      compatibilityOnly: true,
      preferredProviderId: "sim.safety-data"
    }
  ];
}

function buildProviderSource(descriptor: SourceDescriptor, config: SituationDataConfig): ProviderCatalogSource {
  const classification = sourceClassification(descriptor.sourceId);
  return {
    sourceId: descriptor.sourceId,
    label: descriptor.label,
    enabled: descriptor.enabled,
    mode: descriptor.mode,
    layers: descriptor.layers,
    sourceRole: classification.sourceRole,
    audience: classification.audience,
    selectableInMap: classification.selectableInMap,
    visibleInDiagnostics: classification.visibleInDiagnostics,
    feedsLayerIds: classification.feedsLayerIds,
    feedsCatalogLayerIds: classification.feedsCatalogLayerIds,
    usedByLayerIds: classification.usedByLayerIds,
    usedByCatalogLayerIds: classification.usedByCatalogLayerIds,
    technicalInputs: classification.technicalInputs,
    replacedBy: classification.replacedBy,
    preferredProviderId: classification.preferredProviderId,
    updateCadenceSeconds: descriptor.updateCadenceSeconds,
    cacheTtlSeconds: cacheTtlSecondsForSource(descriptor.sourceId, config),
    baseUrl: descriptor.baseUrl,
    backend: backendForSource(descriptor.sourceId, config),
    license: descriptor.license,
    notes: classification.notes
  };
}

function query(providerLayerIds: SituationLayerId[], providerSourceIds: SituationDataSourceId[], categoryFilter?: string[]): ProviderCatalogLayer["query"] {
  return {
    mode: "bbox",
    providerId: PROVIDER_ID,
    streamId: "cop.features",
    providerLayerIds,
    providerSourceIds,
    maxFeatures: DEFAULT_MAX_FEATURES,
    categoryFilter
  };
}

function sourceClassification(sourceId: SituationDataSourceId): {
  sourceRole: ProviderCatalogSourceRole;
  audience: ProviderCatalogAudience;
  selectableInMap: boolean;
  visibleInDiagnostics: boolean;
  feedsLayerIds: string[];
  feedsCatalogLayerIds: string[];
  usedByLayerIds?: string[];
  usedByCatalogLayerIds?: string[];
  technicalInputs?: SituationDataSourceId[];
  replacedBy?: SituationDataSourceId;
  preferredProviderId?: string;
  notes?: string[];
} {
  switch (sourceId) {
    case "mock":
      return {
        sourceRole: "mock",
        audience: "diagnostic",
        selectableInMap: false,
        visibleInDiagnostics: true,
        feedsLayerIds: [],
        feedsCatalogLayerIds: [],
        notes: ["Synthetic data source for tests only."]
      };
    case "open_meteo":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        visibleInDiagnostics: true,
        feedsLayerIds: ["weather.open_meteo"],
        feedsCatalogLayerIds: ["public.weather.current"]
      };
    case "aviation_weather":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        visibleInDiagnostics: true,
        feedsLayerIds: ["weather.aviation_weather"],
        feedsCatalogLayerIds: ["public.weather.aviation"]
      };
    case "mobile_network_model":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        visibleInDiagnostics: true,
        feedsLayerIds: ["mobile_network"],
        feedsCatalogLayerIds: ["public.mobile.network"],
        technicalInputs: ["mobile_coverage_model", "ctu_nettest", "ctu_stationary_mobile", "osm_postgis"],
        usedByCatalogLayerIds: ["public.mobile.network"],
        notes: ["Final public mobile-network assessment. Prefer this over raw mobile inputs."]
      };
    case "mobile_coverage_model":
      return {
        sourceRole: "input",
        audience: "diagnostic",
        selectableInMap: false,
        visibleInDiagnostics: true,
        feedsLayerIds: ["mobile_coverage"],
        feedsCatalogLayerIds: ["diagnostic.mobile.coverage"],
        usedByLayerIds: ["mobile_network"],
        usedByCatalogLayerIds: ["public.mobile.network"],
        replacedBy: "mobile_network_model",
        notes: ["Technical model input; do not show as a normal public mobile layer."]
      };
    case "ctu_nettest":
      return {
        sourceRole: "input",
        audience: "diagnostic",
        selectableInMap: false,
        visibleInDiagnostics: true,
        feedsLayerIds: ["mobile.ctu_nettest"],
        feedsCatalogLayerIds: ["diagnostic.mobile.ctu_measurements"],
        usedByLayerIds: ["mobile_network"],
        usedByCatalogLayerIds: ["public.mobile.network"],
        replacedBy: "mobile_network_model",
        notes: ["Raw public measurements; do not show as a normal public mobile layer."]
      };
    case "ctu_stationary_mobile":
      return {
        sourceRole: "input",
        audience: "diagnostic",
        selectableInMap: false,
        visibleInDiagnostics: true,
        feedsLayerIds: ["mobile.ctu_stationary"],
        feedsCatalogLayerIds: ["diagnostic.mobile.ctu_stationary_measurements"],
        usedByLayerIds: ["mobile_network"],
        usedByCatalogLayerIds: ["public.mobile.network"],
        replacedBy: "mobile_network_model",
        notes: ["Official historical stationary signal measurements; use as model input, not as current BTS state."]
      };
    case "osm_postgis":
      return {
        sourceRole: "reference",
        audience: "public",
        selectableInMap: false,
        visibleInDiagnostics: true,
        feedsLayerIds: [
          "ground.osm_postgis.healthcare",
          "ground.osm_postgis.emergency",
          "ground.osm_postgis.civic",
          "mobile.osm_postgis.communications"
        ],
        feedsCatalogLayerIds: [
          "reference.infrastructure.healthcare",
          "reference.infrastructure.emergency",
          "reference.infrastructure.civic",
          "reference.infrastructure.communications"
        ],
        usedByLayerIds: ["mobile_network"],
        usedByCatalogLayerIds: ["public.mobile.network"],
        notes: ["Select concrete catalog layers, not the whole OSM source."]
      };
    case "osm_overpass":
      return {
        sourceRole: "diagnostic",
        audience: "diagnostic",
        selectableInMap: false,
        visibleInDiagnostics: true,
        feedsLayerIds: [],
        feedsCatalogLayerIds: [],
        notes: ["Development fallback only; public Overpass is not a production runtime backend."]
      };
    case "pid_gtfs_rt":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        visibleInDiagnostics: true,
        feedsLayerIds: ["traffic.pid_gtfs_rt"],
        feedsCatalogLayerIds: ["public.traffic.transit"]
      };
    case "safety_data":
      return {
        sourceRole: "projection",
        audience: "public",
        selectableInMap: false,
        visibleInDiagnostics: true,
        feedsLayerIds: ["warnings.safety_data_projection", "flood.safety_data_projection"],
        feedsCatalogLayerIds: ["public.safety.warnings", "public.safety.flood"],
        preferredProviderId: "sim.safety-data",
        notes: ["Compatibility projection only; prefer the dedicated safety-data provider."]
      };
    case "ardos_partner":
      return {
        sourceRole: "final",
        audience: "partner",
        selectableInMap: false,
        visibleInDiagnostics: true,
        feedsLayerIds: [],
        feedsCatalogLayerIds: [],
        notes: ["Partner-only source; access and display must be controlled outside public catalog defaults."]
      };
  }
}

function cacheTtlSecondsForSource(sourceId: SituationDataSourceId, config: SituationDataConfig): number {
  switch (sourceId) {
    case "open_meteo":
      return config.openMeteoCacheTtlSeconds;
    case "aviation_weather":
      return config.aviationWeatherCacheTtlSeconds;
    case "mobile_network_model":
      return config.mobileNetworkCacheTtlSeconds;
    case "mobile_coverage_model":
      return config.mobileCoverageCacheTtlSeconds;
    case "osm_postgis":
      return config.osmPostgisCacheTtlSeconds;
    case "osm_overpass":
      return config.overpassCacheTtlSeconds;
    case "ctu_nettest":
      return 3600;
    case "ctu_stationary_mobile":
      return config.ctuStationaryMobileCacheTtlSeconds;
    case "pid_gtfs_rt":
      return 20;
    case "safety_data":
      return config.safetyDataCacheTtlSeconds;
    case "ardos_partner":
      return config.ardosPartnerCacheTtlSeconds;
    case "mock":
      return 10;
  }
}

function backendForSource(sourceId: SituationDataSourceId, config: SituationDataConfig): string | undefined {
  if (sourceId === "mobile_network_model" || sourceId === "mobile_coverage_model" || sourceId === "osm_postgis") {
    return config.osmPostgisBackend;
  }
  if (sourceId === "ctu_nettest") {
    return "ctu-nettest";
  }
  if (sourceId === "ctu_stationary_mobile") {
    return "ctu-stationary-mobile";
  }
  return undefined;
}

function mobileModelDemSource(config: SituationDataConfig): string {
  if (config.mobileCoverageTerrainAware) {
    return config.demDatasetId;
  }
  if (config.demEnabled) {
    return `${config.demDatasetId} available; not applied by coverage-v1`;
  }
  return config.mobileCoverageDemSource;
}
