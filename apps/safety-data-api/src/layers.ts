import type { LayerDescriptor } from "./types.js";

export const LAYERS: LayerDescriptor[] = [
  {
    layerId: "warnings",
    label: "Official warnings",
    description: "Public safety warnings and alerts normalized for a COM map layer.",
    defaultVisible: true,
    geometryTypes: ["Point", "Polygon"],
    expectedCadenceSeconds: 300
  },
  {
    layerId: "flood",
    label: "Flood and water levels",
    description: "Hydrological station observations, flood activity levels and river context.",
    defaultVisible: true,
    geometryTypes: ["Point"],
    expectedCadenceSeconds: 600
  }
];
