import type { TakGatewayConfig } from "./config.js";
import { takSourceDescriptor } from "./sources.js";
import type { TakLayerId } from "./types.js";

const PROVIDER_ID = "sim.tak-gateway" as const;
const MAP_CATALOG_DOCUMENT = "https://github.com/voldzi/delta_acr_sim/blob/main/docs/provider/02_MAP_CATALOG_PROVIDER_CONTRACT.md";

export function buildTakMapCatalog(config: TakGatewayConfig, generatedAt = new Date().toISOString()) {
  const source = takSourceDescriptor(config);
  return {
    contractVersion: "provider-map-catalog-v1",
    catalogVersion: "provider-map-catalog-v1",
    providerId: PROVIDER_ID,
    generatedAt,
    status: config.publicRead || config.readToken ? "online" : "degraded",
    authority: {
      contractVersion: "map-catalog-v1",
      catalogVersion: "map-catalog-v1",
      document: MAP_CATALOG_DOCUMENT
    },
    layers: [
      takLayer("tak.mobile", "partner.tak.mobile", "TAK mobilní jednotky", "TAK/CoT mobilní jednotky z partnerského feedu.", "mobile"),
      takLayer("tak.ground", "partner.tak.ground", "TAK pozemní objekty", "TAK/CoT pozemní markery a situační objekty.", "ground"),
      takLayer("tak.traffic", "partner.tak.traffic", "TAK traffic tracks", "TAK/CoT tracky vozidel, transportu a dalších pohybujících se objektů.", "traffic")
    ],
    sources: [
      {
        sourceId: source.sourceId,
        label: source.label,
        enabled: source.enabled,
        mode: source.mode,
        layers: source.layers,
        sourceRole: "final",
        audience: "partner",
        selectableInMap: false,
        visibleInDiagnostics: true,
        feedsLayerIds: ["tak.mobile", "tak.ground", "tak.traffic"],
        feedsCatalogLayerIds: ["partner.tak.mobile", "partner.tak.ground", "partner.tak.traffic"],
        updateCadenceSeconds: source.updateCadenceSeconds,
        cacheTtlSeconds: Math.min(30, config.staleAfterSeconds),
        license: source.license,
        notes: [
          "Partner/non-public data source. COM must call it server-side and protect read tokens.",
          "Affiliation is situational metadata only; not a targeting/workflow instruction.",
          config.publicRead ? "Public read is enabled; use only for synthetic pilot data." : "Public read is disabled."
        ]
      }
    ]
  };
}

function takLayer(providerLayerId: string, recommendedCatalogLayerId: string, label: string, description: string, layer: TakLayerId) {
  return {
    providerLayerId,
    recommendedCatalogLayerId,
    label,
    description,
    categoryPath: ["partner", "tak", layer],
    categories: [`tak_${layer}`, layer === "traffic" ? "tak_track" : "tak_marker"],
    role: "partner",
    audience: "partner",
    kind: "vector_features",
    defaultVisible: false,
    selectable: true,
    geometryTypes: ["Point"],
    minZoom: 4,
    maxZoom: 20,
    refreshSeconds: 5,
    cacheTtlSeconds: 5,
    styleProfile: `tak-${layer}-v1`,
    sourceIds: ["tak_gateway"],
    query: {
      mode: "bbox",
      providerId: PROVIDER_ID,
      streamId: "features",
      providerLayerIds: [layer],
      providerSourceIds: ["tak_gateway"],
      maxFeatures: 1000
    },
    legal: {
      attribution: "TAK/ARDOS partner feed",
      notes: ["Partner data. Do not expose raw CoT payloads in public clients."]
    }
  };
}
