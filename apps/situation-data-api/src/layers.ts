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
    geometryTypes: ["Point", "Polygon"],
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
    layerId: "air_quality",
    label: "Air quality",
    description: "Reserved public safety layer for air quality observations.",
    defaultVisible: false,
    geometryTypes: ["Point", "Polygon"],
    expectedCadenceSeconds: 900
  }
];
