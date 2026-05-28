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
        providerLayerId: "safety.weather_alerts",
        recommendedCatalogLayerId: "public.safety.weather_alerts",
        label: "Meteorologické výstrahy",
        description: "Oficiální meteorologické výstrahy normalizované pro občanský situační obraz.",
        categoryPath: ["safety", "weather_alerts"],
        categories: ["weather_alert", "safety_warning"],
        role: "overlay",
        audience: "public",
        kind: "vector_features",
        defaultVisible: true,
        selectable: true,
        geometryTypes: ["Point", "Polygon", "MultiPolygon"],
        minZoom: 4,
        maxZoom: 18,
        refreshSeconds: 300,
        cacheTtlSeconds: config.cacheTtlSeconds,
        styleProfile: "safety-weather-alert-v1",
        sourceIds: ["chmi_alerts"],
        query: query(["weather_alerts"], ["chmi_alerts"]),
        legal: {
          attribution: "Czech Hydrometeorological Institute (CHMI)",
          notes: ["Veřejný bezpečnostní kontext; operativní rozhodnutí musí používat oficiální kanály."]
        }
      },
      {
        providerLayerId: "safety.fire",
        recommendedCatalogLayerId: "public.safety.fire",
        label: "Požáry",
        description: "Aktivní požáry, tepelné anomálie a oficiální požární nebezpečí z normalizovaných veřejných zdrojů.",
        categoryPath: ["safety", "fire"],
        categories: ["fire", "thermal_anomaly", "fire_weather_risk"],
        role: "overlay",
        audience: "public",
        kind: "vector_features",
        defaultVisible: false,
        selectable: true,
        geometryTypes: ["Point"],
        minZoom: 4,
        maxZoom: 18,
        refreshSeconds: 600,
        cacheTtlSeconds: Math.max(600, config.cacheTtlSeconds),
        styleProfile: "safety-fire-v1",
        sourceIds: ["chmi_alerts", "nasa_firms"],
        query: query(["fire"], ["chmi_alerts", "nasa_firms"]),
        legal: {
          attribution: "Czech Hydrometeorological Institute (CHMI), NASA FIRMS",
          notes: [
            "ČHMÚ poskytuje požární nebezpečí jako oficiální meteorologickou výstrahu, nikoli potvrzený požár.",
            "NASA FIRMS satelitní detekce jsou situační kontext; pro zásah používejte oficiální kanály HZS/IZS."
          ]
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
      },
      {
        providerLayerId: "boundary.admin",
        recommendedCatalogLayerId: "public.boundary.admin",
        label: "Administrativní hranice",
        description: "Referenční administrativní hranice pro vyhodnocování oblastí a popis rizik.",
        categoryPath: ["boundary", "admin"],
        categories: ["boundary", "admin_boundary"],
        role: "reference",
        audience: "public",
        kind: "vector_features",
        defaultVisible: false,
        selectable: true,
        geometryTypes: ["Polygon", "MultiPolygon"],
        minZoom: 4,
        maxZoom: 18,
        refreshSeconds: 86400,
        cacheTtlSeconds: 86400,
        styleProfile: "boundary-admin-v1",
        sourceIds: ["admin_boundaries"],
        query: query(["boundary_admin"], ["admin_boundaries"]),
        legal: {
          attribution: config.adminBoundaryConnectionString ? "OpenStreetMap contributors" : "CSM SIM seed boundary reference",
          notes: config.adminBoundaryConnectionString
            ? ["Hranice jsou čtené z lokální/PostGIS materializované view, ne z veřejného Overpass runtime."]
            : ["Bez SAFETY_DATA_ADMIN_BOUNDARY_DATABASE_URL služba vrací jen hrubý seed ČR."]
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
        feedsLayerIds: ["safety.weather_alerts", "safety.fire"],
        feedsCatalogLayerIds: ["public.safety.weather_alerts", "public.safety.fire"],
        notes: ["Primary public weather warning source; CISORP areas are resolved to local/PostGIS administrative polygons when available. Fire-danger warnings are also projected into the public.safety.fire layer as risk features."]
      };
    case "chmi_hydro":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        feedsLayerIds: ["safety.flood"],
        feedsCatalogLayerIds: ["public.safety.flood"],
        notes: ["Hydrological station source with water-level/discharge SPA classification, trend and catchment metadata; missing current station data is handled with negative cache."]
      };
    case "nasa_firms":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        feedsLayerIds: ["safety.fire"],
        feedsCatalogLayerIds: ["public.safety.fire"],
        notes: ["Satellite active fire detection source; requires NASA_FIRMS_MAP_KEY."]
      };
    case "admin_boundaries":
      return {
        sourceRole: "reference",
        audience: "public",
        selectableInMap: true,
        feedsLayerIds: ["boundary.admin"],
        feedsCatalogLayerIds: ["public.boundary.admin"],
        notes: ["Reference administrative boundaries; replace the built-in seed with authoritative PostGIS data for production detail."]
      };
  }
}
