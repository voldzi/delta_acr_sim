import type { SafetyDataConfig } from "./config.js";
import { allSourceDescriptors } from "./sources.js";
import type { SafetyDataSourceId, SafetyLayerId, SourceDescriptor } from "./types.js";

const PROVIDER_ID = "sim.safety-data" as const;
const MAP_CATALOG_DOCUMENT = "docs/provider/02_MAP_CATALOG_PROVIDER_CONTRACT.md";

export function buildSafetyMapCatalog(config: SafetyDataConfig, generatedAt = new Date().toISOString()) {
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
    layers: [
      {
        providerLayerId: "safety.warnings",
        recommendedCatalogLayerId: "public.safety.warnings",
        label: "Veřejné výstrahy",
        description: "Oficiální veřejné výstrahy normalizované pro občanský situační obraz.",
        categoryPath: ["safety", "warnings"],
        categories: ["warning", "safety_warning"],
        role: "overlay",
        audience: "public",
        kind: "vector_features",
        defaultVisible: true,
        selectable: true,
        geometryTypes: ["Point", "Polygon"],
        minZoom: 4,
        maxZoom: 18,
        refreshSeconds: 300,
        cacheTtlSeconds: config.cacheTtlSeconds,
        styleProfile: "safety-warning-v1",
        sourceIds: ["chmi_alerts"],
        query: query(["warnings"], ["chmi_alerts"]),
        legal: {
          attribution: "Czech Hydrometeorological Institute (CHMI)",
          notes: ["Veřejný bezpečnostní kontext; operativní rozhodnutí musí používat oficiální kanály."]
        }
      },
      {
        providerLayerId: "safety.flood",
        recommendedCatalogLayerId: "public.safety.flood",
        label: "Povodně a voda",
        description: "Hydrologické stanice, stupně povodňové aktivity a vodní kontext.",
        categoryPath: ["safety", "flood"],
        categories: ["flood", "hydrology"],
        role: "overlay",
        audience: "public",
        kind: "vector_features",
        defaultVisible: true,
        selectable: true,
        geometryTypes: ["Point"],
        minZoom: 4,
        maxZoom: 18,
        refreshSeconds: 600,
        cacheTtlSeconds: config.cacheTtlSeconds,
        styleProfile: "safety-flood-v1",
        sourceIds: ["chmi_hydro"],
        query: query(["flood"], ["chmi_hydro"]),
        legal: {
          attribution: "Czech Hydrometeorological Institute (CHMI)",
          notes: ["Stav externích CHMI endpointů může degradovat část odpovědi; sledujte stale/warnings."]
        }
      }
    ],
    sources: descriptors.map((descriptor) => providerSource(descriptor, config))
  };
}

function query(providerLayerIds: SafetyLayerId[], providerSourceIds: SafetyDataSourceId[]) {
  return {
    mode: "bbox",
    providerId: PROVIDER_ID,
    streamId: "features",
    providerLayerIds,
    providerSourceIds,
    maxFeatures: 250
  };
}

function providerSource(descriptor: SourceDescriptor, config: SafetyDataConfig) {
  const role = sourceRole(descriptor.sourceId);
  return {
    sourceId: descriptor.sourceId,
    label: descriptor.label,
    enabled: descriptor.enabled,
    mode: descriptor.mode,
    layers: descriptor.layers,
    sourceRole: role.sourceRole,
    audience: role.audience,
    selectableInMap: role.selectableInMap,
    visibleInDiagnostics: true,
    feedsLayerIds: role.feedsLayerIds,
    feedsCatalogLayerIds: role.feedsCatalogLayerIds,
    updateCadenceSeconds: descriptor.updateCadenceSeconds,
    cacheTtlSeconds: descriptor.sourceId === "chmi_hydro" ? Math.max(300, config.cacheTtlSeconds) : config.cacheTtlSeconds,
    baseUrl: descriptor.baseUrl,
    license: descriptor.license,
    notes: role.notes
  };
}

function sourceRole(sourceId: SafetyDataSourceId) {
  switch (sourceId) {
    case "mock":
      return {
        sourceRole: "mock",
        audience: "diagnostic",
        selectableInMap: false,
        feedsLayerIds: [],
        feedsCatalogLayerIds: [],
        notes: ["Synthetic data source for tests only."]
      };
    case "chmi_alerts":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        feedsLayerIds: ["safety.warnings"],
        feedsCatalogLayerIds: ["public.safety.warnings"],
        notes: ["Primary public safety warning source."]
      };
    case "chmi_hydro":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        feedsLayerIds: ["safety.flood"],
        feedsCatalogLayerIds: ["public.safety.flood"],
        notes: ["Hydrological station source; missing current station data is reported as warnings/stale."]
      };
  }
}
