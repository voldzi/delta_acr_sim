import { buildSafetyFeatureGeometry } from "./feature-views.js";
import type { SafetyFeature, SafetyFeatureCollection, SafetyFeatureProperties, SafetyGeometry, SafetyLayerId, SafetySeverity } from "./types.js";

export interface SafetyNotificationCandidateOptions {
  minSeverity: SafetySeverity;
  includeStale: boolean;
}

export interface SafetyNotificationCandidateCollection {
  contractVersion: "sim-safety-notification-candidates-v1";
  generatedAt: string;
  providerId: "sim.safety-data";
  source: SafetyFeatureCollection["source"];
  query: SafetyFeatureCollection["query"] & SafetyNotificationCandidateOptions;
  policy: {
    audienceDecisionOwner: "cop";
    deliveryOwner: "csm-messaging";
    notificationType: "safety.alert";
    deduplicationKeyFields: string[];
    technicalWarningsPolicy: "never_push_to_public_users";
  };
  summary: {
    featureCount: number;
    candidateCount: number;
    skippedCount: number;
    nonNotificationLayerSkippedCount: number;
    staleSkippedCount: number;
    belowSeveritySkippedCount: number;
    duplicateSkippedCount: number;
    minSeverity: SafetySeverity;
    includeStale: boolean;
  };
  candidates: SafetyNotificationCandidate[];
  sources: SafetyFeatureCollection["sources"];
  warnings: string[];
}

export interface SafetyNotificationCandidate {
  candidateId: string;
  idempotencyKey: string;
  notificationType: "safety.alert";
  audienceDecisionOwner: "cop";
  deliveryOwner: "csm-messaging";
  feature: {
    featureId: string;
    providerId: "sim.safety-data";
    layerId: string;
    providerLayerId: string;
    layer: SafetyLayerId;
    category: string;
    hazardType: string;
    typeCode?: string;
    sourceCode?: string;
    sourceSystem?: string;
    sourceId: string;
    sourceName: string;
    severity: SafetySeverity;
    urgency: SafetyFeatureProperties["urgency"];
    certainty: SafetyFeatureProperties["certainty"];
    confidence: number;
    status: string;
    stale: boolean;
    observedAt: string;
    validFrom: string;
    validUntil?: string;
    updatedAt: string;
    areaName?: string;
    affectedArea?: string;
    geometry: SafetyGeometry;
    geometrySummary: ReturnType<typeof buildSafetyFeatureGeometry>["geometrySummary"];
    links: {
      detail: string;
      geometry: string;
      sourceDetail?: string;
      timeline?: string;
    };
  };
  message: {
    title: Record<"cs" | "en", string>;
    body: Record<"cs" | "en", string>;
    recommendedAction: Record<"cs" | "en", string>;
    localeFallback: "cs";
    severityLabel: Record<"cs" | "en", string>;
    suggestedAlertId: string;
    suggestedDeepLink: string;
  };
  messaging: {
    suggestedHeaders: {
      "X-Source-System-Id": "sim.safety-data";
      "X-Contract-Version": "csm-notification-request-v1";
      "X-Idempotency-Key": string;
    };
    requiredAudienceDecisionOwner: "cop";
    deliveryPrecondition: "COP must resolve recipients, policy, permissions and channels before calling CSM Messaging.";
    recommendedChannels: Array<"push" | "in_app">;
  };
  audit: {
    basis: string[];
    source: string;
    sourceName: string;
    license: SafetyFeatureProperties["license"];
  };
}

const NOTIFICATION_LAYERS = new Set<SafetyLayerId>(["warnings", "weather_alerts", "fire", "flood"]);
const SEVERITY_RANK: Record<SafetySeverity, number> = {
  info: 0,
  advisory: 1,
  warning: 2,
  critical: 3
};

export function buildSafetyNotificationCandidateCollection(
  collection: SafetyFeatureCollection,
  options: SafetyNotificationCandidateOptions
): SafetyNotificationCandidateCollection {
  const generatedAt = new Date().toISOString();
  let nonNotificationLayerSkippedCount = 0;
  let staleSkippedCount = 0;
  let belowSeveritySkippedCount = 0;
  let duplicateSkippedCount = 0;
  const seenCandidateIds = new Set<string>();
  const candidates: SafetyNotificationCandidate[] = [];

  for (const feature of collection.features) {
    if (!NOTIFICATION_LAYERS.has(feature.properties.layer)) {
      nonNotificationLayerSkippedCount += 1;
      continue;
    }
    if (feature.properties.stale && !options.includeStale) {
      staleSkippedCount += 1;
      continue;
    }
    if (SEVERITY_RANK[feature.properties.severity] < SEVERITY_RANK[options.minSeverity]) {
      belowSeveritySkippedCount += 1;
      continue;
    }
    const candidate = buildSafetyNotificationCandidate(feature, collection.query);
    if (seenCandidateIds.has(candidate.candidateId)) {
      duplicateSkippedCount += 1;
      continue;
    }
    seenCandidateIds.add(candidate.candidateId);
    candidates.push(candidate);
  }

  const skippedCount = collection.features.length - candidates.length;
  return {
    contractVersion: "sim-safety-notification-candidates-v1",
    generatedAt,
    providerId: "sim.safety-data",
    source: collection.source,
    query: {
      ...collection.query,
      minSeverity: options.minSeverity,
      includeStale: options.includeStale
    },
    policy: {
      audienceDecisionOwner: "cop",
      deliveryOwner: "csm-messaging",
      notificationType: "safety.alert",
      deduplicationKeyFields: ["providerId", "providerLayerId", "featureId", "validFrom", "validUntil"],
      technicalWarningsPolicy: "never_push_to_public_users"
    },
    summary: {
      featureCount: collection.features.length,
      candidateCount: candidates.length,
      skippedCount,
      nonNotificationLayerSkippedCount,
      staleSkippedCount,
      belowSeveritySkippedCount,
      duplicateSkippedCount,
      minSeverity: options.minSeverity,
      includeStale: options.includeStale
    },
    candidates,
    sources: collection.sources,
    warnings: collection.warnings
  };
}

function buildSafetyNotificationCandidate(feature: SafetyFeature, query: SafetyFeatureCollection["query"]): SafetyNotificationCandidate {
  const properties = feature.properties;
  const providerLayerId = properties.providerLayerId ?? providerLayerIdForLayer(properties.layer);
  const layerId = properties.layerId ?? catalogLayerIdForLayer(properties.layer);
  const candidateId = notificationCandidateId(properties, providerLayerId);
  const geometry = buildSafetyFeatureGeometry(feature);

  return {
    candidateId,
    idempotencyKey: candidateId,
    notificationType: "safety.alert",
    audienceDecisionOwner: "cop",
    deliveryOwner: "csm-messaging",
    feature: {
      featureId: properties.featureId,
      providerId: "sim.safety-data",
      layerId,
      providerLayerId,
      layer: properties.layer,
      category: properties.category,
      hazardType: properties.hazardType,
      typeCode: properties.typeCode,
      sourceCode: properties.sourceCode,
      sourceSystem: properties.sourceSystem,
      sourceId: properties.sourceId,
      sourceName: properties.sourceName,
      severity: properties.severity,
      urgency: properties.urgency,
      certainty: properties.certainty,
      confidence: properties.confidence,
      status: properties.status,
      stale: properties.stale,
      observedAt: properties.observedAt,
      validFrom: properties.validFrom,
      validUntil: properties.validUntil,
      updatedAt: properties.updatedAt,
      areaName: properties.areaName,
      affectedArea: properties.affectedArea,
      geometry: feature.geometry,
      geometrySummary: geometry.geometrySummary,
      links: {
        detail: safetyFeatureDetailUrl(feature.id, query),
        geometry: safetyFeatureGeometryUrl(feature.id, query),
        sourceDetail: properties.detailUrl,
        timeline: properties.timelineUrl
      }
    },
    message: {
      title: {
        cs: localizedText(properties, "cs", "headline", properties.headline),
        en: localizedText(properties, "en", "headline", properties.headline)
      },
      body: {
        cs: localizedText(properties, "cs", "description", properties.description ?? properties.headline),
        en: localizedText(properties, "en", "description", properties.description ?? properties.headline)
      },
      recommendedAction: {
        cs: localizedText(properties, "cs", "recommendedAction", properties.recommendedAction ?? "Sledujte oficiální pokyny a aktuální situaci v COP."),
        en: localizedText(properties, "en", "recommendedAction", properties.recommendedAction ?? "Follow official instructions and the current COP situation.")
      },
      localeFallback: "cs",
      severityLabel: severityLabel(properties.severity),
      suggestedAlertId: candidateId,
      suggestedDeepLink: `csm://map/alert/${encodeURIComponent(candidateId)}`
    },
    messaging: {
      suggestedHeaders: {
        "X-Source-System-Id": "sim.safety-data",
        "X-Contract-Version": "csm-notification-request-v1",
        "X-Idempotency-Key": candidateId
      },
      requiredAudienceDecisionOwner: "cop",
      deliveryPrecondition: "COP must resolve recipients, policy, permissions and channels before calling CSM Messaging.",
      recommendedChannels: ["push", "in_app"]
    },
    audit: {
      basis: properties.basis,
      source: properties.source,
      sourceName: properties.sourceName,
      license: properties.license
    }
  };
}

function notificationCandidateId(properties: SafetyFeatureProperties, providerLayerId: string): string {
  return [
    "sim.safety-data",
    providerLayerId,
    properties.featureId,
    properties.validFrom,
    properties.validUntil ?? "open"
  ].join(":");
}

function localizedText(properties: SafetyFeatureProperties, locale: "cs" | "en", key: string, fallback: string): string {
  const value = properties.localized?.[locale]?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function severityLabel(severity: SafetySeverity): Record<"cs" | "en", string> {
  switch (severity) {
    case "critical":
      return { cs: "Kritická výstraha", en: "Critical alert" };
    case "warning":
      return { cs: "Výstraha", en: "Warning" };
    case "advisory":
      return { cs: "Upozornění", en: "Advisory" };
    case "info":
      return { cs: "Informace", en: "Information" };
  }
}

function providerLayerIdForLayer(layer: SafetyLayerId): string {
  return layer === "boundary_admin" ? "boundary.admin" : `safety.${layer}`;
}

function catalogLayerIdForLayer(layer: SafetyLayerId): string {
  return layer === "boundary_admin" ? "public.boundary.admin" : `public.safety.${layer}`;
}

function safetyFeatureDetailUrl(featureId: string, query?: SafetyFeatureCollection["query"]): string {
  return `/safety-data/api/v1/features/${encodeURIComponent(featureId)}${querySuffix(query)}`;
}

function safetyFeatureGeometryUrl(featureId: string, query?: SafetyFeatureCollection["query"]): string {
  return `/safety-data/api/v1/features/${encodeURIComponent(featureId)}/geometry${querySuffix(query)}`;
}

function querySuffix(query?: SafetyFeatureCollection["query"]): string {
  if (!query) {
    return "";
  }
  const params = new URLSearchParams({
    bbox: `${query.bbox.west},${query.bbox.south},${query.bbox.east},${query.bbox.north}`,
    layers: query.layers.join(","),
    source: query.sources.join(","),
    limit: String(query.limit)
  });
  return `?${params.toString()}`;
}
