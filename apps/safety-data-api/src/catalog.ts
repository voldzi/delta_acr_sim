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
        label: "Krizové výstrahy",
        description: "Obecné veřejné krizové výstrahy z normalizovaných veřejných zdrojů.",
        categoryPath: ["safety", "warnings"],
        categories: ["safety_warning", "disaster_alert", "public_warning", "road_incident"],
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
        styleProfile: "safety-warning-v1",
        sourceIds: ["gdacs_alerts", "hzs_incidents", "municipal_alerts", "road_srti_lod"],
        query: query(["warnings"], ["gdacs_alerts", "hzs_incidents", "municipal_alerts", "road_srti_lod"]),
        notificationPolicy: notificationPolicy("warning"),
        legal: {
          attribution:
            "Czech Hydrometeorological Institute (CHMI), Global Disaster Alert and Coordination System (GDACS), Hasičský záchranný sbor České republiky, Ředitelství silnic a dálnic / NDIC",
          notes: [
            "Vrstva obsahuje jen reálné veřejné výstrahy, katastrofické alerty a veřejné probíhající HZS výjezdy; technická varování zdrojů patří do provozního dohledu.",
            "HZS public feed může vynechávat přesnou GPS polohu; COP má v detailu zobrazit locationPrecision/locationConfidence.",
            "Krajské a městské krizové portály lze připojit přes municipal_alerts; SIM umí veřejné/partnerem povolené RSS/Atom/GeoRSS/GeoJSON feedy a vybrané veřejné PKR JSON výstupy.",
            "Silniční SRTI/NDIC události jsou do této vrstvy promítnuté jen jako dopravně-bezpečnostní warningy; plná dopravní vrstva zůstává v situation-data.",
            "GDACS je strategický krizový kontext; lokální opatření je nutné ověřovat přes IZS a příslušné orgány."
          ]
        }
      },
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
        notificationPolicy: notificationPolicy("weather_alert"),
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
        sourceIds: ["chmi_alerts", "nasa_firms", "gdacs_alerts", "hzs_incidents"],
        query: query(["fire"], ["chmi_alerts", "nasa_firms", "gdacs_alerts", "hzs_incidents"]),
        notificationPolicy: notificationPolicy("fire"),
        legal: {
          attribution: "Czech Hydrometeorological Institute (CHMI), NASA FIRMS, GDACS, Hasičský záchranný sbor České republiky",
          notes: [
            "ČHMÚ poskytuje požární nebezpečí jako oficiální meteorologickou výstrahu, nikoli potvrzený požár.",
            "HZS public feed poskytuje veřejné probíhající požární výjezdy, ale přesná poloha může být pouze obecní centroid.",
            "NASA FIRMS satelitní detekce a GDACS wildfire alerty jsou situační kontext; pro zásah používejte oficiální kanály HZS/IZS."
          ]
        }
      },
      {
        providerLayerId: "safety.flood",
        recommendedCatalogLayerId: "public.safety.flood",
        label: "Povodně a voda",
        description: "Hydrologické stanice, stupně povodňové aktivity, předpověď a vodní kontext.",
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
        sourceIds: ["chmi_hydro", "gdacs_alerts"],
        query: query(["flood"], ["chmi_hydro", "gdacs_alerts"]),
        notificationPolicy: notificationPolicy("flood"),
        legal: {
          attribution: "Czech Hydrometeorological Institute (CHMI), Global Disaster Alert and Coordination System (GDACS)",
          notes: [
            "Stav externích CHMI endpointů může degradovat část odpovědi; sledujte stale/warnings.",
            "Detail hlásného profilu je dostupný přes properties.detailUrl pro selectable flood features.",
            "GDACS flood alerty doplňují přeshraniční krizový kontext; nenahrazují lokální ČHMÚ hydrologické profily."
          ]
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
        notificationPolicy: {
          eligible: false,
          reason: "Reference boundary layer. COP may use it for geofencing, but it must not generate user notifications by itself."
        },
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

function notificationPolicy(hazardType: "weather_alert" | "warning" | "fire" | "flood") {
  return {
    eligible: true,
    audienceDecisionOwner: "cop",
    deliveryOwner: "csm-messaging",
    hazardType,
    deduplicationKeyFields: ["providerId", "providerLayerId", "featureId", "validFrom", "validUntil"],
    recommendedNotificationTypes: ["safety.alert"],
    minimumSeverityForUserPush: "advisory",
    requiredFeatureProperties: [
      "featureId",
      "layerId",
      "providerId",
      "providerLayerId",
      "severity",
      "urgency",
      "certainty",
      "confidence",
      "validFrom",
      "validUntil",
      "updatedAt",
      "source",
      "sourceName",
      "headline",
      "description",
      "recommendedAction",
      "stale"
    ],
    technicalWarningsPolicy: "never_push_to_public_users"
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
        notes: [
          "Primary public weather warning source; CISORP areas are resolved to local/PostGIS administrative polygons when available. Fire-danger warnings are also projected into the public.safety.fire layer as risk features."
        ]
      };
    case "chmi_hydro":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        feedsLayerIds: ["safety.flood"],
        feedsCatalogLayerIds: ["public.safety.flood"],
        notes: [
          "Hydrological station source with water-level/discharge SPA classification, local JSONL timeline history, forecast series, detailUrl and catchment metadata; missing current station data is handled with negative cache."
        ]
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
    case "gdacs_alerts":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        feedsLayerIds: ["safety.warnings", "safety.fire", "safety.flood"],
        feedsCatalogLayerIds: ["public.safety.warnings", "public.safety.fire", "public.safety.flood"],
        notes: ["Public GDACS disaster alert source for strategic/global context; no secret key is required."]
      };
    case "hzs_incidents":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        feedsLayerIds: ["safety.warnings", "safety.fire"],
        feedsCatalogLayerIds: ["public.safety.warnings", "public.safety.fire"],
        notes: [
          "Public HZS active dispatch source for ongoing incidents; SIM exposes type, subtype, status, unit, locality and explicit location precision.",
          "Some feeds provide source coordinates transformed from S-JTSK/Krovak to WGS84; other feeds are geocoded to administrative centroids or explicit regional fallback points."
        ]
      };
    case "municipal_alerts":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        feedsLayerIds: ["safety.warnings"],
        feedsCatalogLayerIds: ["public.safety.warnings"],
        notes: [
          "Configured municipal/regional RSS, Atom, GeoRSS, GeoJSON or public PKR JSON source for crisis-management warnings.",
          "When MUNICIPAL_ALERT_FEEDS is empty, SIM uses a built-in verified public regional feed catalog.",
          "PKR JSON items are transformed from S-JTSK/Krovak to WGS84; if source items do not carry coordinates, SIM emits a clearly marked authority fallback point with lower confidence."
        ]
      };
    case "road_srti_lod":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        feedsLayerIds: ["safety.warnings"],
        feedsCatalogLayerIds: ["public.safety.warnings"],
        notes: ["Public NDIC/RSD SRTI road-safety event source projected into warnings with normalized Czech and English operator text."]
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
