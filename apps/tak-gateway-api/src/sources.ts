import type { TakGatewayConfig } from "./config.js";
import type { TakSourceDescriptor } from "./types.js";

export function takSourceDescriptor(config: TakGatewayConfig): TakSourceDescriptor {
  return {
    sourceId: "tak_gateway",
    label: config.sourceLabel,
    enabled: true,
    mode: "live",
    priority: 20,
    layers: ["mobile", "ground", "traffic"],
    license: {
      name: "TAK/CoT partner data",
      attribution: "TAK/ARDOS partner feed",
      commercialUse: "requires_license",
      operationalUse: "requires_license",
      notes: [
        "Data is partner-provided, not public open data.",
        "COP must apply user authorization and should not expose raw CoT details to public users.",
        "SIM stores only the latest event state with bounded retention."
      ]
    },
    updateCadenceSeconds: 15
  };
}
