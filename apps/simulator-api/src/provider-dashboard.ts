import type { ApiConfig } from "./config.js";
import { fetchProviderJson } from "./provider-http.js";

export interface ProviderDashboardOptions {
  includeDetails: boolean;
  includeObservability: boolean;
}

interface ProviderDashboardSection {
  config?: unknown;
  features?: unknown;
  health?: unknown;
  layers?: unknown;
  observability?: {
    latencyMs: number;
    payload: unknown;
  };
  sources?: unknown;
  tracks?: unknown;
}

export interface ProviderDashboardDetails {
  contractVersion: "sim-operations-provider-details-v1";
  flightData: ProviderDashboardSection;
  generatedAt: string;
  safetyData: ProviderDashboardSection;
  situationData: ProviderDashboardSection;
  takGateway: ProviderDashboardSection;
  warnings: string[];
}

interface ProviderEndpoint {
  baseUrl: string;
  key: "flightData" | "situationData" | "safetyData" | "takGateway";
  label: string;
}

interface FetchSpec {
  assign: (section: ProviderDashboardSection, value: unknown, latencyMs: number) => void;
  label: string;
  path: string;
}

export async function buildProviderDashboardDetails(config: ApiConfig, options: ProviderDashboardOptions): Promise<ProviderDashboardDetails> {
  const warnings: string[] = [];
  const result: ProviderDashboardDetails = {
    contractVersion: "sim-operations-provider-details-v1",
    flightData: {},
    generatedAt: new Date().toISOString(),
    safetyData: {},
    situationData: {},
    takGateway: {},
    warnings
  };

  await Promise.all(
    providerEndpoints(config).map(async (endpoint) => {
      const section = result[endpoint.key];
      const specs = providerSpecs(endpoint.key, options);
      const settled = await Promise.allSettled(
        specs.map(async (spec) => {
          const { latencyMs, payload } = await fetchProviderJson(`${endpoint.baseUrl}${spec.path}`, {
            maxBytes: config.operationsProviderMaxResponseBytes ?? 1024 * 1024,
            timeoutMs: config.operationsProviderTimeoutMs ?? 1500
          });
          spec.assign(section, payload, latencyMs);
        })
      );
      settled.forEach((item, index) => {
        if (item.status === "rejected") {
          warnings.push(`${endpoint.label} ${specs[index]?.label ?? "request"}: ${errorMessage(item.reason)}`);
        }
      });
    })
  );

  return result;
}

function providerEndpoints(config: ApiConfig): ProviderEndpoint[] {
  return [
    { baseUrl: config.operationsFlightDataBaseUrl ?? "http://127.0.0.1:4010", key: "flightData", label: "flight data" },
    { baseUrl: config.operationsSituationDataBaseUrl ?? "http://127.0.0.1:4020", key: "situationData", label: "situation data" },
    { baseUrl: config.operationsSafetyDataBaseUrl ?? "http://127.0.0.1:4030", key: "safetyData", label: "safety data" },
    { baseUrl: config.operationsTakGatewayBaseUrl ?? "http://127.0.0.1:4040", key: "takGateway", label: "TAK gateway" }
  ];
}

function providerSpecs(endpointKey: ProviderEndpoint["key"], options: ProviderDashboardOptions): FetchSpec[] {
  const specs: FetchSpec[] = [
    {
      assign: (section, value) => {
        section.health = value;
      },
      label: "health",
      path: "/health/ready"
    }
  ];
  if (options.includeObservability) {
    specs.push({
      assign: (section, value, latencyMs) => {
        section.observability = { latencyMs, payload: value };
      },
      label: "observability",
      path: "/api/v1/observability"
    });
  }
  if (!options.includeDetails) {
    return specs;
  }

  switch (endpointKey) {
    case "flightData":
      specs.push(assignSpec("sources", "/api/v1/sources"), assignSpec("config", "/api/v1/config"), assignSpec("tracks", "/api/v1/aircraft/positions?limit=8"));
      break;
    case "situationData":
    case "safetyData":
      specs.push(
        assignSpec("layers", "/api/v1/layers"),
        assignSpec("sources", "/api/v1/sources"),
        assignSpec("config", "/api/v1/config"),
        assignSpec("features", "/api/v1/features?limit=12")
      );
      break;
    case "takGateway":
      specs.push(assignSpec("layers", "/api/v1/layers"), assignSpec("sources", "/api/v1/sources"), assignSpec("config", "/api/v1/config"));
      break;
  }
  return specs;
}

function assignSpec(key: "config" | "features" | "layers" | "sources" | "tracks", path: string): FetchSpec {
  return {
    assign: (section, value) => {
      section[key] = value;
    },
    label: key,
    path
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
