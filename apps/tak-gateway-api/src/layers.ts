import type { TakLayerDescriptor } from "./types.js";

export const LAYERS: TakLayerDescriptor[] = [
  {
    layerId: "mobile",
    label: "TAK mobile entities",
    description: "Live CoT units, teams and moving partner markers from TAK-compatible systems.",
    defaultVisible: true,
    geometryTypes: ["Point"],
    expectedCadenceSeconds: 15
  },
  {
    layerId: "ground",
    label: "TAK ground markers",
    description: "Static or slowly changing CoT points, facilities and incident markers.",
    defaultVisible: false,
    geometryTypes: ["Point"],
    expectedCadenceSeconds: 60
  },
  {
    layerId: "traffic",
    label: "TAK traffic tracks",
    description: "CoT tracks that represent vehicles, aircraft or other transport objects.",
    defaultVisible: false,
    geometryTypes: ["Point"],
    expectedCadenceSeconds: 15
  }
];
