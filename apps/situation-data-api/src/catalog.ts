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

type ProviderCatalogLayerDraft = Omit<ProviderCatalogLayer, "availability" | "disabledReason" | "enabled">;

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
    layers: withLayerAvailability(buildProviderLayers(config), config),
    sources: descriptors.map((descriptor) => buildProviderSource(descriptor, config))
  };
}

function withLayerAvailability(layers: ProviderCatalogLayerDraft[], config: SituationDataConfig): ProviderCatalogLayer[] {
  const enabledSources = new Set<SituationDataSourceId>(config.enabledSources);
  return layers.map((layer) => {
    const disabledSources = layer.sourceIds.filter((sourceId) => !enabledSources.has(sourceId));
    if (disabledSources.length === 0) {
      return {
        ...layer,
        enabled: true,
        availability: "available"
      };
    }
    return {
      ...layer,
      enabled: false,
      availability: "disabled",
      disabledReason: `Source disabled in SIM runtime configuration: ${disabledSources.join(", ")}`
    };
  });
}

function buildProviderLayers(config: SituationDataConfig): ProviderCatalogLayerDraft[] {
  return [
    {
      providerLayerId: "weather.open_meteo",
      recommendedCatalogLayerId: "public.weather.current",
      label: "Počasí ve středu oblasti",
      description: "Bodový souhrn aktuálního počasí pro střed mapového výřezu z cacheovaného Open-Meteo zdroje.",
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
        attribution: "Weather data by Open-Meteo.com and Norwegian Meteorological Institute",
        notes: [
          "Free API conditions, commercial use restrictions and MET Norway attribution/User-Agent obligations are described in source metadata.",
          "This layer is a point summary for the bbox center; use the CHMI grid layers for area overlays.",
          "COP contract remains source=open_meteo; MET Norway is an internal SIM fallback/corroborating model."
        ]
      }
    },
    {
      providerLayerId: "weather.forecast_area",
      recommendedCatalogLayerId: "public.weather.forecast_area",
      label: "Plošná předpověď počasí",
      labelLocalized: { cs: "Plošná předpověď počasí", en: "Weather forecast areas" },
      description: "SIM-normalizované předpovědní polygony se symbolem počasí, rizikem a detailním meteogramem po kliknutí.",
      descriptionLocalized: {
        cs: "SIM-normalizované předpovědní polygony se symbolem počasí, rizikem a detailním meteogramem po kliknutí.",
        en: "SIM-normalized forecast polygons with weather symbols, risk summary and click-through meteogram detail."
      },
      categoryPath: ["weather", "forecast"],
      categories: ["weather", "forecast"],
      role: "primary",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Polygon"],
      minZoom: 5,
      maxZoom: 18,
      refreshSeconds: 600,
      cacheTtlSeconds: config.openMeteoCacheTtlSeconds,
      styleProfile: "weather-forecast-area-v1",
      sourceIds: ["weather_forecast"],
      technicalInputs: ["open_meteo"],
      query: query(["weather_forecast_area"], ["weather_forecast"]),
      legend: {
        profile: "weather-forecast-area-v1",
        unit: "risk score",
        opacity: 0.36,
        stops: [
          { value: 0, label: "běžné počasí", color: "#7dd3fc" },
          { value: 0.25, label: "zvýšené riziko", color: "#facc15" },
          { value: 0.55, label: "vysoké riziko", color: "#fb923c" },
          { value: 0.85, label: "závažné riziko", color: "#ef4444" }
        ]
      },
      delivery: {
        mode: "features",
        geometryRole: "grid_cell",
        valueField: "metrics.riskScore",
        stableGrid: { alignment: "wgs84" }
      },
      readModel: {
        refreshedBy: "/api/v1/weather-forecast/areas/{areaId}",
        cacheTtlSeconds: config.openMeteoCacheTtlSeconds
      },
      legal: {
        attribution: "Weather data by Open-Meteo.com; forecast normalization by CSM SIM",
        notes: [
          "COP must render properties.providerProperties.presentation.symbolKey instead of inferring weather symbols from raw codes.",
          "Feature payloads carry detailUrl for a SIM meteogram endpoint; COP should render charts[] from that endpoint.",
          "Forecast area polygons are anchored to the Czech operational forecast coverage and must be rendered at returned GeoJSON coordinates.",
          "Official warnings remain in public.safety.weather_alerts and must not be visually merged with this forecast layer."
        ]
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
      providerLayerId: "weather.chmi_station_observations",
      recommendedCatalogLayerId: "public.weather.observations",
      label: "Měřené počasí ČHMÚ",
      description: "Aktuální měřené meteorologické hodnoty ze stanic ČHMÚ v mapovém výřezu.",
      categoryPath: ["weather", "observations"],
      categories: ["weather", "weather_station_observation"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Point"],
      minZoom: 7,
      maxZoom: 18,
      refreshSeconds: 600,
      cacheTtlSeconds: config.chmiWeatherCacheTtlSeconds,
      styleProfile: "chmi-weather-stations-v1",
      sourceIds: ["chmi_weather_stations"],
      query: query(["weather"], ["chmi_weather_stations"]),
      legend: { profile: "chmi-weather-stations-v1" },
      legal: {
        attribution: "Český hydrometeorologický ústav",
        notes: ["SIM dotazuje ČHMÚ Open Data server-side a výsledek cacheuje; COM nemá ČHMÚ volat přímo."]
      }
    },
    {
      providerLayerId: "weather.chmi_webcams",
      recommendedCatalogLayerId: "public.weather.webcams",
      label: "Webkamery ČHMÚ",
      labelLocalized: { cs: "Webkamery ČHMÚ", en: "CHMI webcams" },
      description: "Bodová vrstva veřejných webkamer ČHMÚ s náhledem snímku načítaným přes SIM až po kliknutí v COP.",
      descriptionLocalized: {
        cs: "Bodová vrstva veřejných webkamer ČHMÚ s náhledem snímku načítaným přes SIM až po kliknutí v COP.",
        en: "Point layer of CHMI public webcams with on-demand snapshot previews served by SIM."
      },
      categoryPath: ["weather", "webcams"],
      categories: ["weather", "webcam"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Point"],
      minZoom: 6,
      maxZoom: 18,
      refreshSeconds: config.chmiWeatherWebcamsCacheTtlSeconds,
      cacheTtlSeconds: config.chmiWeatherWebcamsCacheTtlSeconds,
      styleProfile: "weather-webcam-point-v1",
      sourceIds: ["chmi_weather_webcams"],
      query: query(["weather_webcams"], ["chmi_weather_webcams"]),
      legend: { profile: "weather-webcam-point-v1" },
      delivery: { mode: "features", geometryRole: "feature_geometry" },
      readModel: {
        refreshedBy: "/api/v1/weather-cameras",
        cacheTtlSeconds: config.chmiWeatherWebcamsCacheTtlSeconds
      },
      legal: {
        attribution: "Český hydrometeorologický ústav",
        notes: [
          "COP must show ČHMÚ attribution in the camera preview window.",
          "Feature payloads do not contain image data; COP opens /api/v1/weather-cameras/{locationId} or the supplied snapshot URL on click.",
          "Webcam imagery is visual weather context only and must not be promoted as an automated warning source."
        ]
      }
    },
    {
      providerLayerId: "air_quality.chmi_station_observations",
      recommendedCatalogLayerId: "public.safety.air_quality",
      label: "Kvalita ovzduší",
      description: "Měřené hodnoty imisních stanic ČHMÚ včetně indexu kvality ovzduší a hlavních polutantů.",
      categoryPath: ["safety", "air_quality"],
      categories: ["air_quality", "environment"],
      role: "overlay",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Point"],
      minZoom: 7,
      maxZoom: 18,
      refreshSeconds: 900,
      cacheTtlSeconds: config.chmiAirQualityCacheTtlSeconds,
      styleProfile: "air-quality-index-v1",
      sourceIds: ["chmi_air_quality"],
      query: query(["air_quality"], ["chmi_air_quality"]),
      legend: { profile: "air-quality-index-v1" },
      legal: {
        attribution: "Český hydrometeorologický ústav",
        notes: ["Veřejný situační kontext; nenahrazuje oficiální varování a doporučení ČHMÚ nebo krizových orgánů."]
      }
    },
    ...buildEnvironmentalGridLayers(config),
    ...buildWeatherRadarProviderLayers(config),
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
      geometryTypes: ["Polygon", "MultiPolygon"],
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
      selectable: true,
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
      }
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
    ...buildTrailProviderLayers(config),
    ...buildBoundaryProviderLayers(config),
    {
      providerLayerId: "traffic.pid_gtfs_rt",
      recommendedCatalogLayerId: "public.traffic.transit",
      label: "Doprava",
      labelLocalized: { cs: "Praha/PID - živá vozidla", en: "Prague/PID live vehicles" },
      description: "Živý dopravní kontext veřejné dopravy z PID/Golemio GTFS-RT.",
      descriptionLocalized: {
        cs: "Živý dopravní kontext veřejné dopravy z PID/Golemio GTFS-RT.",
        en: "Live public-transit vehicle context from PID/Golemio GTFS-RT."
      },
      categoryPath: ["traffic", "transit"],
      categories: ["traffic", "transit_vehicle", "pid", "prague"],
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
        notes: [
          "Dopravní kontext, ne bezpečnostní track.",
          "COP must refresh this provider layer independently at the provider refreshSeconds cadence; do not inherit the slower train refresh interval from the shared public.traffic.transit catalog layer."
        ]
      }
    },
    {
      providerLayerId: "traffic.public_transit_static",
      recommendedCatalogLayerId: "public.traffic.transit_stops",
      label: "Zastávky veřejné dopravy",
      labelLocalized: { cs: "Zastávky veřejné dopravy", en: "Public transit stops" },
      description:
        "Statické zastávky z veřejných GTFS feedů načítané server-side přes SIM. Zdroj slouží jako kontext pro další města a regiony bez realtime poloh.",
      descriptionLocalized: {
        cs: "Statické zastávky z veřejných GTFS/GeoJSON feedů načítané server-side přes SIM.",
        en: "Static stops from public GTFS/GeoJSON feeds loaded server-side by SIM."
      },
      categoryPath: ["traffic", "transit", "stops"],
      categories: ["traffic", "transit_stop", "public_transport_stop", "pid", "idsjmk", "dpmo", "pmdp", "dpmlj", "dpo_ostrava"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Point"],
      minZoom: 11,
      maxZoom: 18,
      refreshSeconds: config.publicTransitStaticCacheTtlSeconds,
      cacheTtlSeconds: config.publicTransitStaticCacheTtlSeconds,
      styleProfile: "transit-stop-static-v1",
      sourceIds: ["public_transit_static"],
      filters: [
        {
          filterId: "systemId",
          label: "Dopravní systém",
          type: "multi_select",
          values: ["pid", "idsjmk", "dpmo", "pmdp", "dpmlj", "dpo_ostrava"]
        }
      ],
      query: query(["traffic"], ["public_transit_static"]),
      legend: { profile: "transit-stop-static-v1" },
      legal: {
        attribution: "Feature-level GTFS agency attribution",
        notes: [
          "Statický dopravní kontext, ne live poloha vozidla.",
          "Feature providerProperties.transit.positionKind is static_stop and motionExpected is false.",
          "SIM načítá GTFS ZIPy do sdílené source cache a COP nesmí volat městské GTFS endpointy přímo."
        ]
      }
    },
    {
      providerLayerId: "traffic.idsjmk_vehicle_positions",
      recommendedCatalogLayerId: "public.traffic.transit",
      label: "Veřejná doprava IDS JMK",
      labelLocalized: { cs: "Brno/IDS JMK - živá vozidla", en: "Brno/IDS JMK live vehicles" },
      description: "Živé polohy vozidel IDS JMK z cacheovaného serverového zdroje.",
      descriptionLocalized: {
        cs: "Živé polohy vozidel IDS JMK z cacheovaného serverového zdroje.",
        en: "Live IDS JMK vehicle positions from a server-side cached source."
      },
      categoryPath: ["traffic", "transit"],
      categories: ["traffic", "transit_vehicle", "idsjmk", "brno", "south_moravia"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Point"],
      minZoom: 6,
      maxZoom: 18,
      refreshSeconds: config.idsjmkVehiclePositionsCacheTtlSeconds,
      cacheTtlSeconds: config.idsjmkVehiclePositionsCacheTtlSeconds,
      styleProfile: "transit-vehicle-position-v1",
      sourceIds: ["idsjmk_vehicle_positions"],
      query: query(["traffic"], ["idsjmk_vehicle_positions"]),
      legend: { profile: "transit-vehicle-position-v1" },
      legal: {
        attribution: "IDS JMK / Brno Open Data",
        notes: [
          "Dopravní kontext, ne bezpečnostní track. SIM drží zdrojovou cache a filtruje odpovědi podle bbox.",
          "Layer is usable only when source metadata reports idsjmk_vehicle_positions.enabled=true."
        ]
      }
    },
    {
      providerLayerId: "traffic.spravazeleznic_trains",
      recommendedCatalogLayerId: "public.traffic.transit",
      label: "Vlaky Správy železnic",
      labelLocalized: { cs: "Vlaky", en: "Trains" },
      description: "Aktuální polohy vlaků z veřejné mapy Správy železnic, načítané výhradně server-side přes SIM s minimálním intervalem 15 minut.",
      descriptionLocalized: {
        cs: "Aktuální polohy vlaků z veřejné mapy Správy železnic, načítané server-side přes SIM s minimálním intervalem 15 minut.",
        en: "Current train positions from the public Správa železnic map, fetched server-side by SIM at most once per 15 minutes."
      },
      categoryPath: ["traffic", "transit", "rail"],
      categories: ["traffic", "transit_vehicle", "train", "rail", "spravazeleznic"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Point"],
      minZoom: 6,
      maxZoom: 18,
      refreshSeconds: config.spravaZeleznicTrainPositionsCacheTtlSeconds,
      cacheTtlSeconds: config.spravaZeleznicTrainPositionsCacheTtlSeconds,
      styleProfile: "transit-vehicle-position-v1",
      sourceIds: ["spravazeleznic_trains"],
      query: query(["traffic"], ["spravazeleznic_trains"]),
      legend: { profile: "transit-vehicle-position-v1" },
      legal: {
        attribution: "Správa železnic, státní organizace",
        notes: [
          "Dopravní kontext, ne bezpečnostní track.",
          "Feature providerProperties.transit.positionKind is vehicle_live_cached; expected movement is step-wise at the 15-minute source cadence.",
          "SIM dotazuje upstream nejvýše jednou za 15 minut bez ohledu na počet uživatelů COP."
        ]
      }
    },
    {
      providerLayerId: "traffic.road_events.srti",
      recommendedCatalogLayerId: "public.traffic.road_events",
      label: "Silniční dopravní události",
      description: "Aktuální SRTI/NDIC/ŘSD dopravní události z cacheovaného Linked Open Data zdroje.",
      categoryPath: ["traffic", "road_events"],
      categories: ["traffic", "road_event", "road_accident", "roadworks"],
      role: "overlay",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Point"],
      minZoom: 6,
      maxZoom: 18,
      refreshSeconds: config.roadSrtiLodCacheTtlSeconds,
      cacheTtlSeconds: config.roadSrtiLodCacheTtlSeconds,
      styleProfile: "road-event-v1",
      sourceIds: ["road_srti_lod"],
      query: query(["traffic"], ["road_srti_lod"]),
      legend: { profile: "road-event-v1" },
      legal: {
        attribution: "Ředitelství silnic a dálnic / NDIC; LOD conversion by TamTam Research",
        notes: ["Veřejný dopravní kontext. SIM dotazuje upstream po TTL, ne per uživatel/per bbox."]
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
      geometryTypes: ["Point", "Polygon", "MultiPolygon"],
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
      providerLayerId: "weather_alerts.safety_data_projection",
      recommendedCatalogLayerId: "public.safety.weather_alerts",
      label: "Meteorologické výstrahy (kompatibilní projekce)",
      description: "Kompatibilní projekce oficiálních meteorologických výstrah ze Safety Data API. COP má preferovat provider sim.safety-data.",
      categoryPath: ["safety", "weather_alerts"],
      categories: ["weather_alert", "safety_warning"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: false,
      geometryTypes: ["Point", "Polygon", "MultiPolygon"],
      minZoom: 4,
      maxZoom: 18,
      refreshSeconds: 300,
      cacheTtlSeconds: config.safetyDataCacheTtlSeconds,
      styleProfile: "safety-weather-alert-v1",
      sourceIds: ["safety_data"],
      query: query(["weather_alerts"], ["safety_data"]),
      legend: { profile: "safety-weather-alert-v1" },
      legal: {
        attribution: "Safety Data API; feature-level attribution preserved from ČHMÚ CAP warnings",
        notes: ["Compatibility projection only; prefer sim.safety-data catalog provider for safety layers."]
      },
      compatibilityOnly: true,
      preferredProviderId: "sim.safety-data"
    },
    {
      providerLayerId: "fire.safety_data_projection",
      recommendedCatalogLayerId: "public.safety.fire",
      label: "Požáry a požární riziko (kompatibilní projekce)",
      description: "Kompatibilní projekce aktivních požárních detekcí a požárního nebezpečí ze Safety Data API. COM má preferovat provider sim.safety-data.",
      categoryPath: ["safety", "fire"],
      categories: ["fire", "thermal_anomaly", "fire_weather_risk"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: false,
      geometryTypes: ["Point", "Polygon", "MultiPolygon"],
      minZoom: 4,
      maxZoom: 18,
      refreshSeconds: 300,
      cacheTtlSeconds: config.safetyDataCacheTtlSeconds,
      styleProfile: "safety-fire-v1",
      sourceIds: ["safety_data"],
      query: query(["fire"], ["safety_data"]),
      legend: { profile: "safety-fire-v1" },
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
    },
    {
      providerLayerId: "boundary_admin.safety_data_projection",
      recommendedCatalogLayerId: "public.boundary.admin",
      label: "Administrativní hranice (kompatibilní projekce)",
      description: "Kompatibilní projekce administrativních hranic ze Safety Data API. COM má preferovat provider sim.safety-data nebo vlastní boundary provider.",
      categoryPath: ["boundary", "admin"],
      categories: ["admin_boundary", "boundary"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: false,
      geometryTypes: ["Polygon", "MultiPolygon"],
      minZoom: 4,
      maxZoom: 18,
      refreshSeconds: 86400,
      cacheTtlSeconds: config.safetyDataCacheTtlSeconds,
      styleProfile: "admin-boundary-v1",
      sourceIds: ["safety_data"],
      query: query(["boundary_admin"], ["safety_data"]),
      legend: { profile: "admin-boundary-v1" },
      legal: {
        attribution: "Safety Data API; feature-level attribution preserved from original public sources",
        notes: ["Compatibility projection only; prefer sim.safety-data catalog provider for boundary layers."]
      },
      compatibilityOnly: true,
      preferredProviderId: "sim.safety-data"
    }
  ];
}

function buildEnvironmentalGridLayers(config: SituationDataConfig): ProviderCatalogLayerDraft[] {
  const weatherLegal = {
    attribution: "Open-Meteo.com and Czech Hydrometeorological Institute where measured station context is used",
    notes: ["Grid layers are server-side SIM products prepared from cached upstream data; COM must not call upstream weather providers directly."]
  };
  const airQualityLegal = {
    attribution: "Český hydrometeorologický ústav",
    notes: ["Interpolated public air-quality context; station observations remain available as point features."]
  };

  return [
    {
      providerLayerId: "weather.temperature_grid",
      recommendedCatalogLayerId: "public.weather.temperature_grid",
      label: "Teplota",
      labelLocalized: { cs: "Teplota", en: "Temperature" },
      description: "Stabilní grid pro teplotní mapu nad územím ČR, připravený pro COP renderování jako plošný overlay.",
      descriptionLocalized: {
        cs: "Stabilní grid pro teplotní mapu nad územím ČR.",
        en: "Stable grid for temperature map rendering over Czechia."
      },
      categoryPath: ["weather", "grid", "temperature"],
      categories: ["weather", "temperature"],
      role: "overlay",
      audience: "public",
      kind: "grid_field",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Polygon"],
      minZoom: 5,
      maxZoom: 18,
      refreshSeconds: 600,
      cacheTtlSeconds: config.chmiWeatherCacheTtlSeconds,
      styleProfile: "weather-temperature-grid-v1",
      sourceIds: ["chmi_weather_stations"],
      technicalInputs: ["open_meteo"],
      query: query(["weather_temperature_grid"], ["chmi_weather_stations"]),
      legend: {
        profile: "weather-temperature-grid-v1",
        unit: "°C",
        opacity: 0.55,
        stops: [
          { value: -10, label: "-10 °C", color: "#6b8dff" },
          { value: 0, label: "0 °C", color: "#a7d8ff" },
          { value: 15, label: "15 °C", color: "#8ee36a" },
          { value: 25, label: "25 °C", color: "#ffd166" },
          { value: 35, label: "35 °C", color: "#ef476f" }
        ]
      },
      delivery: gridDelivery(config.openMeteoGridDegrees),
      legal: weatherLegal
    },
    {
      providerLayerId: "weather.wind_field",
      recommendedCatalogLayerId: "public.weather.wind_field",
      label: "Vítr",
      labelLocalized: { cs: "Vítr", en: "Wind" },
      description: "Vektorové pole větru pro animovanou mapovou vrstvu.",
      descriptionLocalized: { cs: "Vektorové pole větru pro animovanou mapovou vrstvu.", en: "Vector wind field for animated map rendering." },
      categoryPath: ["weather", "field", "wind"],
      categories: ["weather", "wind"],
      role: "overlay",
      audience: "public",
      kind: "vector_field",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Point", "LineString"],
      minZoom: 5,
      maxZoom: 18,
      refreshSeconds: 600,
      cacheTtlSeconds: config.chmiWeatherCacheTtlSeconds,
      styleProfile: "weather-wind-field-v1",
      sourceIds: ["chmi_weather_stations"],
      technicalInputs: ["open_meteo"],
      query: query(["weather_wind_field"], ["chmi_weather_stations"]),
      legend: {
        profile: "weather-wind-field-v1",
        unit: "m/s",
        opacity: 0.75,
        stops: [
          { value: 2, label: "slabý", color: "#76e4f7" },
          { value: 8, label: "čerstvý", color: "#a0e75a" },
          { value: 15, label: "silný", color: "#ffd166" },
          { value: 25, label: "nebezpečný", color: "#ef476f" }
        ]
      },
      delivery: { ...gridDelivery(config.openMeteoGridDegrees), mode: "grid" },
      legal: weatherLegal
    },
    {
      providerLayerId: "weather.precipitation_grid",
      recommendedCatalogLayerId: "public.weather.precipitation_grid",
      label: "Srážky",
      labelLocalized: { cs: "Srážky", en: "Precipitation" },
      description: "Stabilní grid pro srážkovou mapu.",
      descriptionLocalized: { cs: "Stabilní grid pro srážkovou mapu.", en: "Stable grid for precipitation map rendering." },
      categoryPath: ["weather", "grid", "precipitation"],
      categories: ["weather", "precipitation"],
      role: "overlay",
      audience: "public",
      kind: "grid_field",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Polygon"],
      minZoom: 5,
      maxZoom: 18,
      refreshSeconds: 600,
      cacheTtlSeconds: config.chmiWeatherCacheTtlSeconds,
      styleProfile: "weather-precipitation-grid-v1",
      sourceIds: ["chmi_weather_stations"],
      technicalInputs: ["open_meteo"],
      query: query(["weather_precipitation_grid"], ["chmi_weather_stations"]),
      legend: {
        profile: "weather-precipitation-grid-v1",
        unit: "mm/10min",
        opacity: 0.5,
        stops: [
          { value: 0.1, label: "slabé", color: "#b7e4c7" },
          { value: 1, label: "déšť", color: "#52b788" },
          { value: 5, label: "silné", color: "#168aad" },
          { value: 20, label: "přívalové", color: "#5e60ce" }
        ]
      },
      delivery: gridDelivery(config.openMeteoGridDegrees),
      legal: weatherLegal
    },
    {
      providerLayerId: "weather.humidity_grid",
      recommendedCatalogLayerId: "public.weather.humidity_grid",
      label: "Vlhkost",
      labelLocalized: { cs: "Vlhkost", en: "Humidity" },
      description: "Stabilní grid relativní vlhkosti vzduchu.",
      descriptionLocalized: { cs: "Stabilní grid relativní vlhkosti vzduchu.", en: "Stable relative humidity grid." },
      categoryPath: ["weather", "grid", "humidity"],
      categories: ["weather", "humidity"],
      role: "overlay",
      audience: "public",
      kind: "grid_field",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Polygon"],
      minZoom: 5,
      maxZoom: 18,
      refreshSeconds: 600,
      cacheTtlSeconds: config.chmiWeatherCacheTtlSeconds,
      styleProfile: "weather-humidity-grid-v1",
      sourceIds: ["chmi_weather_stations"],
      technicalInputs: ["open_meteo"],
      query: query(["weather_humidity_grid"], ["chmi_weather_stations"]),
      legend: {
        profile: "weather-humidity-grid-v1",
        unit: "%",
        opacity: 0.45,
        stops: [
          { value: 20, label: "sucho", color: "#f4a261" },
          { value: 50, label: "střední", color: "#90be6d" },
          { value: 80, label: "vlhko", color: "#4d96ff" }
        ]
      },
      delivery: gridDelivery(config.openMeteoGridDegrees),
      legal: weatherLegal
    },
    {
      providerLayerId: "weather.pressure_grid",
      recommendedCatalogLayerId: "public.weather.pressure_grid",
      label: "Tlak",
      labelLocalized: { cs: "Tlak", en: "Pressure" },
      description: "Stabilní grid tlaku vzduchu.",
      descriptionLocalized: { cs: "Stabilní grid tlaku vzduchu.", en: "Stable air pressure grid." },
      categoryPath: ["weather", "grid", "pressure"],
      categories: ["weather", "pressure"],
      role: "overlay",
      audience: "public",
      kind: "grid_field",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Polygon"],
      minZoom: 5,
      maxZoom: 18,
      refreshSeconds: 600,
      cacheTtlSeconds: config.chmiWeatherCacheTtlSeconds,
      styleProfile: "weather-pressure-grid-v1",
      sourceIds: ["chmi_weather_stations"],
      technicalInputs: ["open_meteo"],
      query: query(["weather_pressure_grid"], ["chmi_weather_stations"]),
      legend: {
        profile: "weather-pressure-grid-v1",
        unit: "hPa",
        opacity: 0.4,
        stops: [
          { value: 990, label: "nízký", color: "#5e60ce" },
          { value: 1013, label: "standard", color: "#f1faee" },
          { value: 1030, label: "vysoký", color: "#e63946" }
        ]
      },
      delivery: gridDelivery(config.openMeteoGridDegrees),
      legal: weatherLegal
    },
    {
      providerLayerId: "air_quality.grid",
      recommendedCatalogLayerId: "public.safety.air_quality_grid",
      label: "Kvalita ovzduší - plocha",
      labelLocalized: { cs: "Kvalita ovzduší - plocha", en: "Air quality grid" },
      description: "Interpolovaná gridová vrstva kvality ovzduší z měřených stanic ČHMÚ.",
      descriptionLocalized: {
        cs: "Interpolovaná gridová vrstva kvality ovzduší z měřených stanic ČHMÚ.",
        en: "Interpolated air-quality grid from CHMI measured stations."
      },
      categoryPath: ["safety", "air_quality", "grid"],
      categories: ["air_quality", "environment"],
      role: "overlay",
      audience: "public",
      kind: "grid_field",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Polygon"],
      minZoom: 6,
      maxZoom: 18,
      refreshSeconds: 900,
      cacheTtlSeconds: config.chmiAirQualityCacheTtlSeconds,
      styleProfile: "air-quality-grid-v1",
      sourceIds: ["chmi_air_quality"],
      query: query(["air_quality_grid"], ["chmi_air_quality"]),
      legend: {
        profile: "air-quality-grid-v1",
        unit: "AQI",
        opacity: 0.5,
        stops: [
          { value: 1, label: "dobrá", color: "#2dc653" },
          { value: 3, label: "přijatelná", color: "#ffd166" },
          { value: 5, label: "špatná", color: "#f77f00" },
          { value: 6, label: "velmi špatná", color: "#d62828" }
        ]
      },
      delivery: gridDelivery(config.openMeteoGridDegrees),
      legal: airQualityLegal
    }
  ];
}

function buildWeatherRadarProviderLayers(config: SituationDataConfig): ProviderCatalogLayerDraft[] {
  const legal = {
    attribution: "Český hydrometeorologický ústav",
    notes: [
      "Radarové PNG/HDF5 produkty pochází z ČHMÚ Open Data a SIM je indexuje server-side přes cache.",
      "Některé ČHMÚ PNG produkty obsahují zdrojový rám, mřížku nebo embedded popisky; SIM pro PNG publikuje clean cropped raster endpoint a raw URL nechává pro diagnostiku.",
      "Historii a budoucí timeline/replay čtěte z /api/v1/weather-radar/frames.",
      "Vrstva thunderstorm risk není raw feed blesků; jde o radarový kontext a musí být prezentována společně s oficiálními výstrahami."
    ]
  };
  const common = {
    categoryPath: ["weather", "radar"],
    categories: ["weather", "radar"],
    role: "overlay" as const,
    audience: "public" as const,
    kind: "raster_overlay" as const,
    defaultVisible: false,
    selectable: true,
    geometryTypes: ["Polygon"] as Array<"Polygon">,
    minZoom: 5,
    maxZoom: 18,
    refreshSeconds: 300,
    cacheTtlSeconds: config.chmiWeatherRadarCacheTtlSeconds,
    sourceIds: ["chmi_weather_radar"] as SituationDataSourceId[],
    delivery: rasterOverlayDelivery(),
    readModel: {
      refreshedBy: "/api/v1/weather-radar/frames",
      cacheTtlSeconds: config.chmiWeatherRadarCacheTtlSeconds
    },
    legal
  };

  return [
    {
      ...common,
      providerLayerId: "weather.radar_reflectivity",
      recommendedCatalogLayerId: "public.weather.radar_reflectivity",
      label: "Radarová odrazivost",
      labelLocalized: { cs: "Radarová odrazivost", en: "Weather radar reflectivity" },
      description: "Aktuální radarová odrazivost MAX_Z z ČHMÚ Open Data jako georeferencovaný raster overlay.",
      descriptionLocalized: {
        cs: "Aktuální radarová odrazivost MAX_Z z ČHMÚ Open Data jako georeferencovaný raster overlay.",
        en: "Current CHMI MAX_Z weather radar reflectivity as a georeferenced raster overlay."
      },
      styleProfile: "weather-radar-reflectivity-v1",
      query: query(["weather_radar_reflectivity"], ["chmi_weather_radar"]),
      legend: {
        profile: "weather-radar-reflectivity-v1",
        unit: "dBZ / mm/h",
        opacity: 0.62,
        stops: [
          { value: 7, label: "slabé echo", color: "#65d46e" },
          { value: 25, label: "déšť", color: "#f9e45b" },
          { value: 45, label: "silné jádro", color: "#f76d3c" },
          { value: 55, label: "konvektivní jádro", color: "#aa2bff" }
        ]
      }
    },
    {
      ...common,
      providerLayerId: "weather.radar_precipitation",
      recommendedCatalogLayerId: "public.weather.radar_precipitation",
      label: "Radarové srážky",
      labelLocalized: { cs: "Radarové srážky", en: "Radar precipitation" },
      description: "Radarový odhad srážek ČHMÚ: PseudoCAPPI 2 km a sloučený 1h odhad radar+stanice.",
      descriptionLocalized: {
        cs: "Radarový odhad srážek ČHMÚ: PseudoCAPPI 2 km a sloučený 1h odhad radar+stanice.",
        en: "CHMI radar precipitation estimate: PseudoCAPPI 2 km and merged 1h radar+gauge precipitation."
      },
      refreshSeconds: 600,
      styleProfile: "weather-radar-precipitation-v1",
      query: query(["weather_radar_precipitation"], ["chmi_weather_radar"]),
      legend: {
        profile: "weather-radar-precipitation-v1",
        unit: "mm/h, mm/1h",
        opacity: 0.58,
        stops: [
          { value: 0.1, label: "slabé", color: "#b7e4c7" },
          { value: 1, label: "déšť", color: "#52b788" },
          { value: 5, label: "silné", color: "#168aad" },
          { value: 20, label: "přívalové", color: "#5e60ce" }
        ]
      }
    },
    {
      ...common,
      providerLayerId: "weather.radar_nowcast",
      recommendedCatalogLayerId: "public.weather.radar_nowcast",
      label: "Radarový nowcast",
      labelLocalized: { cs: "Radarový nowcast", en: "Radar nowcast" },
      description: "Metadata ČHMÚ extrapolačního radarového nowcastu pro +10 až +60 minut.",
      descriptionLocalized: {
        cs: "Metadata ČHMÚ extrapolačního radarového nowcastu pro +10 až +60 minut.",
        en: "CHMI radar extrapolation nowcast metadata for +10 to +60 minutes."
      },
      styleProfile: "weather-radar-nowcast-v1",
      query: query(["weather_radar_nowcast"], ["chmi_weather_radar"]),
      legend: { profile: "weather-radar-nowcast-v1", opacity: 0.55 }
    },
    {
      ...common,
      categoryPath: ["safety", "weather", "thunderstorm"],
      categories: ["weather", "thunderstorm", "safety"],
      providerLayerId: "weather.thunderstorm_risk",
      recommendedCatalogLayerId: "public.safety.thunderstorm_risk",
      label: "Bouřkové riziko",
      labelLocalized: { cs: "Bouřkové riziko", en: "Thunderstorm risk" },
      description: "Radarový kontext pro bouřková jádra z ČHMÚ MAX_Z/EchoTop. Neobsahuje raw polohy blesků.",
      descriptionLocalized: {
        cs: "Radarový kontext pro bouřková jádra z ČHMÚ MAX_Z/EchoTop. Neobsahuje raw polohy blesků.",
        en: "Radar context for convective cores from CHMI MAX_Z/EchoTop. It does not include raw lightning strikes."
      },
      styleProfile: "weather-thunderstorm-risk-v1",
      query: query(["weather_thunderstorm_risk"], ["chmi_weather_radar"]),
      legend: {
        profile: "weather-thunderstorm-risk-v1",
        unit: "risk",
        opacity: 0.64,
        stops: [
          { value: "watch", label: "sledovat", color: "#ffd166" },
          { value: "warning", label: "pravděpodobná bouřka", color: "#f77f00" },
          { value: "critical", label: "silné jádro", color: "#d62828" }
        ]
      }
    }
  ];
}

function buildTrailProviderLayers(config: SituationDataConfig): ProviderCatalogLayerDraft[] {
  const commonLegal = {
    attribution: "OpenStreetMap contributors",
    notes: [
      "Read-model z lokálního OSM/PostGIS importu; veřejný Overpass se v produkci nepoužívá.",
      "ODbL atribuce musí zůstat viditelná v detailu vrstvy nebo mapovém copyrightu.",
      "Vrstva je referenční turistický/outdoor kontext, ne autoritativní krizové varování ani garantovaný stav cesty."
    ]
  };

  return [
    {
      providerLayerId: "outdoor.osm_postgis.trail_routes",
      recommendedCatalogLayerId: "public.trails.routes",
      label: "Turistické a cyklo trasy",
      labelLocalized: { cs: "Turistické a cyklo trasy", en: "Trail and cycling routes" },
      description: "Normalizované pěší, turistické, cyklo a MTB trasy z lokálního OSM/PostGIS read-modelu.",
      descriptionLocalized: {
        cs: "Normalizované pěší, turistické, cyklo a MTB trasy z lokálního OSM/PostGIS read-modelu.",
        en: "Normalized walking, hiking, cycling and MTB routes from the local OSM/PostGIS read model."
      },
      categoryPath: ["outdoor", "trails", "routes"],
      categories: ["trail", "hiking_route", "foot_route", "cycling_route", "mtb_route", "osm"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["LineString", "MultiLineString"],
      minZoom: 5,
      maxZoom: 18,
      refreshSeconds: 21600,
      cacheTtlSeconds: config.osmPostgisCacheTtlSeconds,
      styleProfile: "trail-route-osm-v1",
      sourceIds: ["osm_postgis"],
      query: query(["trail_routes"], ["osm_postgis"], ["hiking_route", "foot_route", "cycling_route", "mtb_route"]),
      legend: {
        profile: "trail-route-osm-v1",
        stops: [
          { value: "hiking_route", label: "turistická", color: "#dc2626" },
          { value: "foot_route", label: "pěší", color: "#16a34a" },
          { value: "cycling_route", label: "cyklo", color: "#2563eb" },
          { value: "mtb_route", label: "MTB", color: "#7c3aed" }
        ]
      },
      delivery: {
        mode: "features",
        geometryRole: "feature_geometry"
      },
      filters: [
        {
          filterId: "route_mode",
          label: "Typ trasy",
          type: "multi_select",
          values: ["hiking_route", "foot_route", "cycling_route", "mtb_route"],
          defaultValue: ["hiking_route", "foot_route", "cycling_route", "mtb_route"]
        }
      ],
      readModel: {
        table: config.osmPostgisTrailRoutesTable,
        refreshedBy: "scripts/import-osm-cz-postgis.sh",
        cacheTtlSeconds: config.osmPostgisCacheTtlSeconds
      },
      legal: commonLegal
    },
    {
      providerLayerId: "outdoor.osm_postgis.trail_poi",
      recommendedCatalogLayerId: "public.trails.poi",
      label: "Turistické body",
      labelLocalized: { cs: "Turistické body", en: "Trail points of interest" },
      description: "Ubytování, přístřešky, voda, občerstvení, doprava a nouzové body z lokálního OSM/PostGIS read-modelu.",
      descriptionLocalized: {
        cs: "Ubytování, přístřešky, voda, občerstvení, doprava a nouzové body z lokálního OSM/PostGIS read-modelu.",
        en: "Accommodation, shelters, water, food, transport and emergency points from the local OSM/PostGIS read model."
      },
      categoryPath: ["outdoor", "trails", "poi"],
      categories: ["trail_poi", "sleep", "camp", "shelter", "water", "food", "repair", "rental", "transport", "emergency", "osm"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Point"],
      minZoom: 10,
      maxZoom: 18,
      refreshSeconds: 21600,
      cacheTtlSeconds: config.osmPostgisCacheTtlSeconds,
      styleProfile: "trail-poi-osm-v1",
      sourceIds: ["osm_postgis"],
      query: query(["trail_poi"], ["osm_postgis"], ["sleep", "camp", "shelter", "water", "food", "repair", "rental", "transport", "emergency"]),
      legend: { profile: "trail-poi-osm-v1" },
      delivery: {
        mode: "features",
        geometryRole: "feature_geometry"
      },
      filters: [
        {
          filterId: "category",
          label: "Kategorie",
          type: "multi_select",
          values: ["sleep", "camp", "shelter", "water", "food", "repair", "rental", "transport", "emergency"],
          defaultValue: ["sleep", "camp", "shelter", "water", "food", "repair", "rental", "transport", "emergency"]
        }
      ],
      readModel: {
        table: config.osmPostgisTrailPoiTable,
        refreshedBy: "scripts/import-osm-cz-postgis.sh",
        cacheTtlSeconds: config.osmPostgisCacheTtlSeconds
      },
      legal: commonLegal
    }
  ];
}

function buildBoundaryProviderLayers(config: SituationDataConfig): ProviderCatalogLayerDraft[] {
  const common = {
    categoryPath: ["boundary", "admin"],
    categories: ["admin_boundary", "boundary"],
    role: "reference" as const,
    audience: "public" as const,
    kind: "vector_features" as const,
    defaultVisible: false,
    selectable: true,
    geometryTypes: ["Polygon", "MultiPolygon"] as Array<"Polygon" | "MultiPolygon">,
    refreshSeconds: 86400,
    cacheTtlSeconds: config.osmPostgisCacheTtlSeconds,
    sourceIds: ["osm_postgis"] as SituationDataSourceId[],
    legend: { profile: "admin-boundary-v1" },
    delivery: {
      mode: "features" as const
    },
    readModel: {
      table: config.osmPostgisAdminBoundaryTable,
      refreshedBy: "scripts/import-osm-cz-postgis.sh",
      cacheTtlSeconds: config.osmPostgisCacheTtlSeconds
    },
    legal: {
      attribution: "OpenStreetMap contributors",
      notes: ["Read-model z lokálního OSM/PostGIS importu; veřejný Overpass se v produkci nepoužívá."]
    }
  };

  return [
    {
      ...common,
      providerLayerId: "boundary.country",
      recommendedCatalogLayerId: "public.boundary.country",
      label: "Stát",
      labelLocalized: { cs: "Stát", en: "Country" },
      description: "Hranice státu z lokálního OSM/PostGIS read-modelu.",
      descriptionLocalized: { cs: "Hranice státu z lokálního OSM/PostGIS read-modelu.", en: "Country boundary from local OSM/PostGIS read model." },
      minZoom: 3,
      maxZoom: 18,
      styleProfile: "boundary-country-v1",
      query: query(["boundary_country"], ["osm_postgis"])
    },
    {
      ...common,
      providerLayerId: "boundary.region",
      recommendedCatalogLayerId: "public.boundary.region",
      label: "Kraje",
      labelLocalized: { cs: "Kraje", en: "Regions" },
      description: "Krajské hranice z lokálního OSM/PostGIS read-modelu.",
      descriptionLocalized: { cs: "Krajské hranice z lokálního OSM/PostGIS read-modelu.", en: "Regional boundaries from local OSM/PostGIS read model." },
      minZoom: 5,
      maxZoom: 18,
      styleProfile: "boundary-region-v1",
      query: query(["boundary_region"], ["osm_postgis"])
    },
    {
      ...common,
      providerLayerId: "boundary.district",
      recommendedCatalogLayerId: "public.boundary.district",
      label: "Okresy",
      labelLocalized: { cs: "Okresy", en: "Districts" },
      description: "Okresní hranice z lokálního OSM/PostGIS read-modelu.",
      descriptionLocalized: { cs: "Okresní hranice z lokálního OSM/PostGIS read-modelu.", en: "District boundaries from local OSM/PostGIS read model." },
      minZoom: 7,
      maxZoom: 18,
      styleProfile: "boundary-district-v1",
      query: query(["boundary_district"], ["osm_postgis"])
    },
    {
      ...common,
      providerLayerId: "boundary.orp",
      recommendedCatalogLayerId: "public.boundary.orp",
      label: "ORP",
      labelLocalized: { cs: "ORP", en: "Municipalities with extended powers" },
      description: "Hranice ORP, pokud jsou dostupné v OSM/PostGIS read-modelu.",
      descriptionLocalized: {
        cs: "Hranice ORP, pokud jsou dostupné v OSM/PostGIS read-modelu.",
        en: "ORP boundaries where available in the OSM/PostGIS read model."
      },
      minZoom: 8,
      maxZoom: 18,
      styleProfile: "boundary-orp-v1",
      query: query(["boundary_orp"], ["osm_postgis"])
    },
    {
      providerLayerId: "place.settlements",
      recommendedCatalogLayerId: "public.place.settlements",
      label: "Sídla",
      labelLocalized: { cs: "Sídla", en: "Settlements" },
      description: "Referenční vrstva sídel připravená pro civilní basemap kontext.",
      descriptionLocalized: { cs: "Referenční vrstva sídel připravená pro civilní basemap kontext.", en: "Settlement reference layer for civil basemap context." },
      categoryPath: ["place", "settlements"],
      categories: ["place", "settlement"],
      role: "reference",
      audience: "public",
      kind: "vector_features",
      defaultVisible: false,
      selectable: true,
      geometryTypes: ["Point", "Polygon", "MultiPolygon"],
      minZoom: 7,
      maxZoom: 18,
      refreshSeconds: 86400,
      cacheTtlSeconds: config.osmPostgisCacheTtlSeconds,
      styleProfile: "place-settlements-v1",
      sourceIds: ["osm_postgis"],
      query: query(["place_settlements"], ["osm_postgis"]),
      legend: { profile: "place-settlements-v1" },
      delivery: { mode: "features" },
      readModel: {
        table: config.osmPostgisAdminBoundaryTable,
        refreshedBy: "scripts/import-osm-cz-postgis.sh",
        cacheTtlSeconds: config.osmPostgisCacheTtlSeconds
      },
      legal: common.legal
    }
  ];
}

function gridDelivery(resolutionDegrees: number): NonNullable<ProviderCatalogLayer["delivery"]> {
  return {
    mode: "grid",
    geometryRole: "grid_cell",
    fallbackPolicy: "hide_if_unsupported",
    valueField: "metrics.value",
    stableGrid: {
      alignment: "wgs84",
      resolutionDegrees
    }
  };
}

function rasterOverlayDelivery(): NonNullable<ProviderCatalogLayer["delivery"]> {
  return {
    mode: "raster_overlay",
    geometryRole: "raster_extent",
    fallbackPolicy: "hide_if_raster_overlay_unsupported",
    doNotRenderGeometryFill: true
  };
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
    case "weather_forecast":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        visibleInDiagnostics: true,
        feedsLayerIds: ["weather.forecast_area"],
        feedsCatalogLayerIds: ["public.weather.forecast_area"],
        technicalInputs: ["open_meteo"],
        notes: [
          "Final SIM forecast product for COP map rendering.",
          "COP should use providerProperties.presentation and the supplied detailUrl instead of deriving symbols or chart data itself."
        ]
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
    case "chmi_weather_stations":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        visibleInDiagnostics: true,
        feedsLayerIds: [
          "weather.chmi_station_observations",
          "weather.temperature_grid",
          "weather.wind_field",
          "weather.precipitation_grid",
          "weather.humidity_grid",
          "weather.pressure_grid"
        ],
        feedsCatalogLayerIds: [
          "public.weather.observations",
          "public.weather.temperature_grid",
          "public.weather.wind_field",
          "public.weather.precipitation_grid",
          "public.weather.humidity_grid",
          "public.weather.pressure_grid"
        ],
        notes: ["Measured weather observations from ČHMÚ Open Data; cache server-side. Grid layers are cataloged as SIM read-model products."]
      };
    case "chmi_weather_radar":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        visibleInDiagnostics: true,
        feedsLayerIds: [
          "weather.radar_reflectivity",
          "weather.radar_precipitation",
          "weather.radar_nowcast",
          "weather.thunderstorm_risk"
        ],
        feedsCatalogLayerIds: [
          "public.weather.radar_reflectivity",
          "public.weather.radar_precipitation",
          "public.weather.radar_nowcast",
          "public.safety.thunderstorm_risk"
        ],
        technicalInputs: ["safety_data"],
        notes: [
          "ČHMÚ radar Open Data indexed server-side by SIM.",
          "No raw lightning strike feed is published by this source; thunderstorm layer is radar/CAP warning context."
        ]
      };
    case "chmi_weather_webcams":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        visibleInDiagnostics: true,
        feedsLayerIds: ["weather.chmi_webcams"],
        feedsCatalogLayerIds: ["public.weather.webcams"],
        notes: [
          "ČHMÚ public webcam locations and on-demand snapshots are fetched server-side by SIM.",
          "COP should open a custom camera preview window on feature click and must keep CHMI attribution visible.",
          "Not a warning source; use only as visual weather context."
        ]
      };
    case "chmi_air_quality":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        visibleInDiagnostics: true,
        feedsLayerIds: ["air_quality.chmi_station_observations", "air_quality.grid"],
        feedsCatalogLayerIds: ["public.safety.air_quality", "public.safety.air_quality_grid"],
        notes: ["Measured air-quality observations from ČHMÚ Open Data; cache server-side. Grid layer is cataloged as a SIM read-model product."]
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
        selectableInMap: true,
        visibleInDiagnostics: true,
        feedsLayerIds: ["mobile_coverage"],
        feedsCatalogLayerIds: ["diagnostic.mobile.coverage"],
        usedByLayerIds: ["mobile_network"],
        usedByCatalogLayerIds: ["public.mobile.network"],
        notes: ["Technical model input; show only as an explicit diagnostic map layer, not as the normal public mobile layer."]
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
          "mobile.osm_postgis.communications",
          "outdoor.osm_postgis.trail_routes",
          "outdoor.osm_postgis.trail_poi",
          "boundary.country",
          "boundary.region",
          "boundary.district",
          "boundary.orp",
          "place.settlements"
        ],
        feedsCatalogLayerIds: [
          "reference.infrastructure.healthcare",
          "reference.infrastructure.emergency",
          "reference.infrastructure.civic",
          "reference.infrastructure.communications",
          "public.trails.routes",
          "public.trails.poi",
          "public.boundary.country",
          "public.boundary.region",
          "public.boundary.district",
          "public.boundary.orp",
          "public.place.settlements"
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
    case "public_transit_static":
      return {
        sourceRole: "reference",
        audience: "public",
        selectableInMap: true,
        visibleInDiagnostics: true,
        feedsLayerIds: ["traffic.public_transit_static"],
        feedsCatalogLayerIds: ["public.traffic.transit_stops"],
        notes: ["Static GTFS stop context. SIM caches configured GTFS ZIP feeds server-side and COP must not call upstream feeds directly."]
      };
    case "idsjmk_vehicle_positions":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        visibleInDiagnostics: true,
        feedsLayerIds: ["traffic.idsjmk_vehicle_positions"],
        feedsCatalogLayerIds: ["public.traffic.transit"],
        notes: ["Regional public-transit context. SIM must cache this source server-side and COM must not call IDS JMK upstream directly."]
      };
    case "spravazeleznic_trains":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        visibleInDiagnostics: true,
        feedsLayerIds: ["traffic.spravazeleznic_trains"],
        feedsCatalogLayerIds: ["public.traffic.transit"],
        notes: ["Railway traffic context. SIM enforces a minimum 15-minute upstream refresh interval and COP must not call Správa železnic directly."]
      };
    case "road_srti_lod":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: true,
        visibleInDiagnostics: true,
        feedsLayerIds: ["traffic.road_events.srti"],
        feedsCatalogLayerIds: ["public.traffic.road_events"],
        notes: ["Road-event context from a cached SRTI/NDIC Linked Open Data source."]
      };
    case "safety_data":
      return {
        sourceRole: "projection",
        audience: "public",
        selectableInMap: false,
        visibleInDiagnostics: true,
        feedsLayerIds: [
          "warnings.safety_data_projection",
          "fire.safety_data_projection",
          "flood.safety_data_projection",
          "boundary_admin.safety_data_projection"
        ],
        feedsCatalogLayerIds: ["public.safety.warnings", "public.safety.fire", "public.safety.flood", "public.boundary.admin"],
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
    case "weather_forecast":
      return config.openMeteoCacheTtlSeconds;
    case "aviation_weather":
      return config.aviationWeatherCacheTtlSeconds;
    case "chmi_air_quality":
      return config.chmiAirQualityCacheTtlSeconds;
    case "chmi_weather_stations":
      return config.chmiWeatherCacheTtlSeconds;
    case "chmi_weather_radar":
      return config.chmiWeatherRadarCacheTtlSeconds;
    case "chmi_weather_webcams":
      return config.chmiWeatherWebcamsCacheTtlSeconds;
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
    case "public_transit_static":
      return config.publicTransitStaticCacheTtlSeconds;
    case "idsjmk_vehicle_positions":
      return config.idsjmkVehiclePositionsCacheTtlSeconds;
    case "spravazeleznic_trains":
      return config.spravaZeleznicTrainPositionsCacheTtlSeconds;
    case "road_srti_lod":
      return config.roadSrtiLodCacheTtlSeconds;
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
  if (sourceId === "weather_forecast") {
    return "sim-weather-forecast-open-meteo";
  }
  if (sourceId === "ctu_stationary_mobile") {
    return "ctu-stationary-mobile";
  }
  if (sourceId === "public_transit_static") {
    return "gtfs-static";
  }
  if (sourceId === "idsjmk_vehicle_positions") {
    return "idsjmk-open-data";
  }
  if (sourceId === "spravazeleznic_trains") {
    return "spravazeleznic-mapy";
  }
  if (sourceId === "road_srti_lod") {
    return "ndic-srti-lod";
  }
  if (sourceId === "chmi_air_quality" || sourceId === "chmi_weather_stations" || sourceId === "chmi_weather_radar") {
    return "chmi-opendata";
  }
  if (sourceId === "chmi_weather_webcams") {
    return "chmi-data-provider";
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
