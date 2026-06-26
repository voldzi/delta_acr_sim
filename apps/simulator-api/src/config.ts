import type { PublisherMode } from "@csm-sim/contracts";
import { DEFAULT_SOURCE_SYSTEM_ID } from "@csm-sim/contracts";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SIM_ROLES = ["SIM_ADMIN", "SIM_OPERATOR", "SIM_VIEWER", "SIM_AI_USER", "SIM_AI_ADMIN"] as const;
export type SimRole = (typeof SIM_ROLES)[number];
export type ApiAuthMode = "token" | "hybrid" | "oidc";

export interface ApiPrincipalConfig {
  actor: string;
  token: string;
  roles: SimRole[];
}

export interface ApiConfig {
  port: number;
  dataDir: string;
  schemaDir: string;
  publisherMode: PublisherMode;
  sourceSystemId: string;
  adapterVersion: string;
  mainCopBaseUrl?: string;
  mainCopBearerToken?: string;
  externalAiAllowed: boolean;
  apiAuthRequired?: boolean;
  apiAuthMode?: ApiAuthMode;
  apiPublicRead?: boolean;
  apiPrincipals?: ApiPrincipalConfig[];
  apiOidcIssuer?: string;
  apiOidcJwksUri?: string;
  apiOidcClientId?: string;
  apiOidcAllowedClients?: string[];
  apiCorsOrigins?: string[];
  apiRateLimitWindowMs?: number;
  apiRateLimitMaxRequests?: number;
  scenarioMaxBlocks?: number;
  scenarioMaxActiveObjects?: number;
  scenarioMaxEventsPerSecond?: number;
  operationsProviderTimeoutMs?: number;
  operationsFlightDataBaseUrl?: string;
  operationsSituationDataBaseUrl?: string;
  operationsSafetyDataBaseUrl?: string;
  operationsTakGatewayBaseUrl?: string;
  operationsReportFile?: string;
}

export async function loadConfig(): Promise<ApiConfig> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataDir = resolve(process.env.SIM_DATA_DIR ?? `${projectRoot}/data`);
  await mkdir(dataDir, { recursive: true });
  const apiAuthRequired = parseBoolean(process.env.SIM_API_AUTH_REQUIRED, process.env.NODE_ENV === "production");
  const apiAuthMode = parseApiAuthMode(process.env.SIM_API_AUTH_MODE);
  const apiPrincipals = parseApiPrincipals(process.env.SIM_API_TOKENS, process.env.SIM_API_ADMIN_TOKEN, process.env.SIM_API_INTERNAL_TOKEN);
  const apiOidcIssuer = normalizeIssuer(process.env.SIM_OIDC_ISSUER ?? process.env.COP_OIDC_ISSUER ?? "");
  if (apiAuthRequired && apiAuthMode !== "oidc" && apiPrincipals.length === 0) {
    throw new Error("SIM_API_AUTH_REQUIRED is enabled in token/hybrid mode but no SIM_API_ADMIN_TOKEN, SIM_API_TOKENS, or SIM_API_INTERNAL_TOKEN is configured.");
  }
  if (apiAuthRequired && apiAuthMode !== "token" && !apiOidcIssuer) {
    throw new Error("SIM_API_AUTH_REQUIRED is enabled in oidc/hybrid mode but SIM_OIDC_ISSUER is not configured.");
  }

  return {
    port: Number(process.env.API_PORT ?? 4000),
    dataDir,
    schemaDir: resolve(process.env.SIM_SCHEMA_DIR ?? `${projectRoot}/docs/api/schemas`),
    publisherMode: parsePublisherMode(process.env.SIM_PUBLISHER_MODE),
    sourceSystemId: process.env.SIM_SOURCE_SYSTEM_ID ?? DEFAULT_SOURCE_SYSTEM_ID,
    adapterVersion: process.env.SIM_ADAPTER_VERSION ?? "0.1.0",
    mainCopBaseUrl: process.env.MAIN_COP_BASE_URL,
    mainCopBearerToken: process.env.MAIN_COP_BEARER_TOKEN ?? "dev-lab-token",
    externalAiAllowed: process.env.EXTERNAL_AI_ALLOWED === "true",
    apiAuthRequired,
    apiAuthMode,
    apiPublicRead: parseBoolean(process.env.SIM_API_PUBLIC_READ, false),
    apiPrincipals,
    apiOidcIssuer,
    apiOidcJwksUri: process.env.SIM_OIDC_JWKS_URI,
    apiOidcClientId: process.env.SIM_OIDC_CLIENT_ID ?? "csm-sim-web",
    apiOidcAllowedClients: parseList(process.env.SIM_OIDC_ALLOWED_CLIENTS ?? process.env.SIM_OIDC_CLIENT_ID ?? "csm-sim-web"),
    apiCorsOrigins: parseList(process.env.SIM_API_CORS_ORIGINS),
    apiRateLimitWindowMs: parseInteger(process.env.SIM_API_RATE_LIMIT_WINDOW_MS, 60_000),
    apiRateLimitMaxRequests: parseInteger(process.env.SIM_API_RATE_LIMIT_MAX_REQUESTS, 300),
    scenarioMaxBlocks: parseInteger(process.env.SIM_SCENARIO_MAX_BLOCKS, 24),
    scenarioMaxActiveObjects: parseInteger(process.env.SIM_SCENARIO_MAX_ACTIVE_OBJECTS, 1000),
    scenarioMaxEventsPerSecond: parseInteger(process.env.SIM_SCENARIO_MAX_EVENTS_PER_SECOND, 1000),
    operationsProviderTimeoutMs: parseInteger(process.env.SIM_OPERATIONS_PROVIDER_TIMEOUT_MS, 1500),
    operationsFlightDataBaseUrl: normalizeBaseUrl(process.env.SIM_OPERATIONS_FLIGHT_DATA_BASE_URL ?? "http://127.0.0.1:4010"),
    operationsSituationDataBaseUrl: normalizeBaseUrl(process.env.SIM_OPERATIONS_SITUATION_DATA_BASE_URL ?? "http://127.0.0.1:4020"),
    operationsSafetyDataBaseUrl: normalizeBaseUrl(process.env.SIM_OPERATIONS_SAFETY_DATA_BASE_URL ?? "http://127.0.0.1:4030"),
    operationsTakGatewayBaseUrl: normalizeBaseUrl(process.env.SIM_OPERATIONS_TAK_GATEWAY_BASE_URL ?? "http://127.0.0.1:4040"),
    operationsReportFile: process.env.SIM_OPERATIONS_REPORT_FILE
  };
}

function parseApiAuthMode(value: string | undefined): ApiAuthMode {
  return value === "oidc" || value === "hybrid" ? value : "token";
}

function parsePublisherMode(value: string | undefined): PublisherMode {
  if (value === "MOCK" || value === "LIVE" || value === "DRY_RUN") {
    return value;
  }
  return "DRY_RUN";
}

function parseApiPrincipals(value: string | undefined, adminToken: string | undefined, internalToken: string | undefined): ApiPrincipalConfig[] {
  const principals: ApiPrincipalConfig[] = [];
  const trimmedAdminToken = adminToken?.trim();
  if (trimmedAdminToken) {
    principals.push({
      actor: "admin",
      token: trimmedAdminToken,
      roles: ["SIM_ADMIN", "SIM_OPERATOR", "SIM_VIEWER", "SIM_AI_USER", "SIM_AI_ADMIN"]
    });
  }
  const trimmedInternalToken = internalToken?.trim();
  if (trimmedInternalToken) {
    principals.push({
      actor: "web-proxy",
      token: trimmedInternalToken,
      roles: ["SIM_ADMIN", "SIM_OPERATOR", "SIM_VIEWER", "SIM_AI_USER", "SIM_AI_ADMIN"]
    });
  }

  for (const item of parseList(value)) {
    const [actor, token, rawRoles] = item.split(":");
    const roles = parseRoles(rawRoles);
    if (actor && token && roles.length > 0) {
      principals.push({ actor, token, roles });
    }
  }
  return principals;
}

function parseRoles(value: string | undefined): SimRole[] {
  const allowed = new Set<string>(SIM_ROLES);
  return (value ?? "")
    .split("|")
    .map((role) => role.trim())
    .filter((role): role is SimRole => allowed.has(role));
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === "1" || value === "true" || value === "yes";
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/u, "");
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/u, "");
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}
