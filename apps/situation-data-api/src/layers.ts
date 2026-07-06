import type { LayerDescriptor } from "./types.js";

export const LAYERS: LayerDescriptor[] = [
  {
    layerId: "weather",
    label: "Weather",
    description: "Current weather and simple hazard context for the requested map area.",
    defaultVisible: true,
    geometryTypes: ["Point"],
    expectedCadenceSeconds: 600
  },
  {
    layerId: "weather_webcams",
    label: "Weather webcams",
    description: "ČHMÚ weather camera locations with on-demand SIM snapshot preview endpoints.",
    defaultVisible: false,
    geometryTypes: ["Point"],
    expectedCadenceSeconds: 300
  },
  {
    layerId: "outdoor_webcams",
    label: "Outdoor webcams",
    description: "Curated tourism and outdoor webcam points with verified origin provider links and SIM-mediated snapshot detail when available.",
    defaultVisible: false,
    geometryTypes: ["Point"],
    expectedCadenceSeconds: 21600
  },
  {
    layerId: "weather_forecast_area",
    label: "Weather forecast areas",
    description: "SIM-normalized forecast polygons with ready-to-render weather symbols, risk summaries and meteogram detail URLs.",
    defaultVisible: false,
    geometryTypes: ["Polygon"],
    expectedCadenceSeconds: 600
  },
  {
    layerId: "ground",
    label: "Ground reference",
    description: "Reference infrastructure and points of interest relevant to the ground picture.",
    defaultVisible: false,
    geometryTypes: ["Point", "LineString", "Polygon"],
    expectedCadenceSeconds: 86400
  },
  {
    layerId: "mobile",
    label: "Mobile network",
    description: "Mobile signal, cell and network quality observations. Public data is mostly periodic, not real-time outages.",
    defaultVisible: false,
    geometryTypes: ["Point"],
    expectedCadenceSeconds: 3600
  },
  {
    layerId: "mobile_coverage",
    label: "Mobile coverage estimate",
    description: "Terrain-optional estimated mobile network coverage prepared by SIM for COP display.",
    defaultVisible: false,
    geometryTypes: ["Polygon"],
    expectedCadenceSeconds: 21600
  },
  {
    layerId: "mobile_network",
    label: "Mobile network assessment",
    description: "Unified SIM assessment of mobile network quality from coverage estimates, public measurements and confidence scoring.",
    defaultVisible: false,
    geometryTypes: ["Polygon", "MultiPolygon"],
    expectedCadenceSeconds: 3600
  },
  {
    layerId: "traffic",
    label: "Traffic",
    description: "Road and public transport incidents, constraints and synthetic pilot context.",
    defaultVisible: false,
    geometryTypes: ["Point", "LineString"],
    expectedCadenceSeconds: 60
  },
  {
    layerId: "warnings",
    label: "Safety warnings",
    description: "Official public warning features projected from the Safety Data contract.",
    defaultVisible: true,
    geometryTypes: ["Point", "Polygon", "MultiPolygon"],
    expectedCadenceSeconds: 300
  },
  {
    layerId: "weather_alerts",
    label: "Meteorological warnings",
    description: "Official meteorological warning polygons projected from the Safety Data contract.",
    defaultVisible: false,
    geometryTypes: ["Point", "Polygon", "MultiPolygon"],
    expectedCadenceSeconds: 300
  },
  {
    layerId: "fire",
    label: "Fire and fire danger",
    description: "Active fire detections and official fire danger warnings projected from the Safety Data contract.",
    defaultVisible: false,
    geometryTypes: ["Point", "Polygon", "MultiPolygon"],
    expectedCadenceSeconds: 300
  },
  {
    layerId: "flood",
    label: "Flood and water levels",
    description: "Hydrological station observations projected from the Safety Data contract.",
    defaultVisible: true,
    geometryTypes: ["Point"],
    expectedCadenceSeconds: 600
  },
  {
    layerId: "boundary_admin",
    label: "Administrative boundaries",
    description: "Administrative boundary reference features projected from the Safety Data contract.",
    defaultVisible: false,
    geometryTypes: ["Polygon", "MultiPolygon"],
    expectedCadenceSeconds: 86400
  },
  {
    layerId: "boundary_country",
    label: "Country boundary",
    description: "Country-level administrative boundary read model from local OSM/PostGIS.",
    defaultVisible: false,
    geometryTypes: ["Polygon", "MultiPolygon"],
    expectedCadenceSeconds: 86400
  },
  {
    layerId: "boundary_region",
    label: "Regional boundaries",
    description: "Region-level administrative boundaries read model from local OSM/PostGIS.",
    defaultVisible: false,
    geometryTypes: ["Polygon", "MultiPolygon"],
    expectedCadenceSeconds: 86400
  },
  {
    layerId: "boundary_district",
    label: "District boundaries",
    description: "District-level administrative boundaries read model from local OSM/PostGIS.",
    defaultVisible: false,
    geometryTypes: ["Polygon", "MultiPolygon"],
    expectedCadenceSeconds: 86400
  },
  {
    layerId: "boundary_orp",
    label: "ORP boundaries",
    description: "Municipality-with-extended-powers boundary read model from local OSM/PostGIS where available.",
    defaultVisible: false,
    geometryTypes: ["Polygon", "MultiPolygon"],
    expectedCadenceSeconds: 86400
  },
  {
    layerId: "place_settlements",
    label: "Settlements",
    description: "Simplified settlement reference layer prepared for civil basemap context.",
    defaultVisible: false,
    geometryTypes: ["Point", "Polygon", "MultiPolygon"],
    expectedCadenceSeconds: 86400
  },
  {
    layerId: "trail_routes",
    label: "Trail routes",
    description: "Long-distance and local hiking, cycling and MTB route relations from the local OSM/PostGIS read model.",
    defaultVisible: false,
    geometryTypes: ["LineString", "MultiLineString"],
    expectedCadenceSeconds: 21600
  },
  {
    layerId: "trail_poi",
    label: "Trail points of interest",
    description: "Outdoor infrastructure near routes: sleep, camp, shelter, water, food, repair, rental, transport and emergency POI from OSM.",
    defaultVisible: false,
    geometryTypes: ["Point"],
    expectedCadenceSeconds: 21600
  },
  {
    layerId: "community_places",
    label: "Community places",
    description:
      "Practical civil community points from SIM: toilets, water, charging, shelters, pharmacies and similar reference places prepared for future user verification.",
    defaultVisible: false,
    geometryTypes: ["Point"],
    expectedCadenceSeconds: 21600
  },
  {
    layerId: "community_reports",
    label: "Community reports",
    description: "Future user-submitted field observations, photos and proposed edits after COP/community moderation.",
    defaultVisible: false,
    geometryTypes: ["Point"],
    expectedCadenceSeconds: 300
  },
  {
    layerId: "air_quality",
    label: "Air quality",
    description: "ČHMÚ measured air-quality station observations and normalized air-quality index context.",
    defaultVisible: false,
    geometryTypes: ["Point"],
    expectedCadenceSeconds: 900
  },
  {
    layerId: "weather_temperature_grid",
    label: "Temperature grid",
    description: "Stable weather grid metadata for temperature overlays. Grid read model is prepared for COP integration.",
    defaultVisible: false,
    geometryTypes: ["Polygon"],
    expectedCadenceSeconds: 600
  },
  {
    layerId: "weather_wind_field",
    label: "Wind field",
    description: "Stable vector-field metadata for wind overlays. Vector read model is prepared for COP integration.",
    defaultVisible: false,
    geometryTypes: ["Point", "LineString"],
    expectedCadenceSeconds: 600
  },
  {
    layerId: "weather_precipitation_grid",
    label: "Precipitation grid",
    description: "Stable weather grid metadata for precipitation overlays.",
    defaultVisible: false,
    geometryTypes: ["Polygon"],
    expectedCadenceSeconds: 600
  },
  {
    layerId: "weather_humidity_grid",
    label: "Humidity grid",
    description: "Stable weather grid metadata for relative humidity overlays.",
    defaultVisible: false,
    geometryTypes: ["Polygon"],
    expectedCadenceSeconds: 600
  },
  {
    layerId: "weather_pressure_grid",
    label: "Pressure grid",
    description: "Stable weather grid metadata for air pressure overlays.",
    defaultVisible: false,
    geometryTypes: ["Polygon"],
    expectedCadenceSeconds: 600
  },
  {
    layerId: "weather_radar_reflectivity",
    label: "Weather radar reflectivity",
    description: "ČHMÚ radar reflectivity raster overlay metadata for current precipitation and convective context.",
    defaultVisible: false,
    geometryTypes: ["Polygon"],
    expectedCadenceSeconds: 300
  },
  {
    layerId: "weather_radar_precipitation",
    label: "Weather radar precipitation",
    description: "ČHMÚ radar-derived precipitation raster overlay metadata including surface reflectivity and 1h merged precipitation.",
    defaultVisible: false,
    geometryTypes: ["Polygon"],
    expectedCadenceSeconds: 600
  },
  {
    layerId: "weather_radar_nowcast",
    label: "Weather radar nowcast",
    description: "ČHMÚ radar extrapolation forecast metadata for the next 60 minutes.",
    defaultVisible: false,
    geometryTypes: ["Polygon"],
    expectedCadenceSeconds: 300
  },
  {
    layerId: "weather_thunderstorm_risk",
    label: "Thunderstorm risk",
    description: "Radar-derived thunderstorm context overlay. It does not contain a raw lightning-strike feed.",
    defaultVisible: false,
    geometryTypes: ["Polygon"],
    expectedCadenceSeconds: 300
  },
  {
    layerId: "air_quality_grid",
    label: "Air quality grid",
    description: "Stable air-quality grid metadata for interpolated ČHMÚ pollution overlays.",
    defaultVisible: false,
    geometryTypes: ["Polygon"],
    expectedCadenceSeconds: 900
  }
];
