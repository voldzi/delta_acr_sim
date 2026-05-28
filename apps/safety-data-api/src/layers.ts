import type { LayerDescriptor } from "./types.js";

export const LAYERS: LayerDescriptor[] = [
  {
    layerId: "weather_alerts",
    label: "Weather alerts",
    description: "Official weather warnings normalized for a COM civil-risk map layer.",
    defaultVisible: true,
    geometryTypes: ["Point", "Polygon", "MultiPolygon"],
    expectedCadenceSeconds: 300
  },
  {
    layerId: "fire",
    label: "Fire detections",
    description: "Active fire and thermal anomaly detections normalized for map context.",
    defaultVisible: false,
    geometryTypes: ["Point"],
    expectedCadenceSeconds: 600
  },
  {
    layerId: "flood",
    label: "Flood and water levels",
    description: "Hydrological station observations, flood activity levels and river context.",
    defaultVisible: true,
    geometryTypes: ["Point"],
    expectedCadenceSeconds: 600
  },
  {
    layerId: "boundary_admin",
    label: "Administrative boundaries",
    description: "Administrative boundary reference features for area context.",
    defaultVisible: false,
    geometryTypes: ["Polygon", "MultiPolygon"],
    expectedCadenceSeconds: 86400
  }
];
