import type { PublisherMode, Scenario } from "@csm-sim/contracts";
import { readFile } from "node:fs/promises";
import type { ApiConfig } from "./config.js";
import type { JsonStore } from "./store.js";

type OperationsStatus = "ok" | "degraded" | "critical" | "unknown";

interface RuntimeSnapshot {
  activeObjects?: number;
  elapsedSeconds?: number;
  generatedEvents: number;
  lastTickAt?: string;
  publishedEvents: number;
  queuedEvents: number;
  scenarioId?: string;
  state: string;
  tick?: number;
}

interface PublisherSnapshot {
  deadLetterSize: number;
  lastFailureAt?: string;
  lastSuccessAt?: string;
  mode: PublisherMode;
  publishingEnabled: boolean;
  queueSize: number;
}

interface OperationsSummaryContext {
  config: ApiConfig;
  publisher: {
    status(): PublisherSnapshot;
  };
  store: JsonStore;
}

interface CacheSummary {
  entries?: number;
  errors?: number;
  hitRate?: number;
  misses?: number;
  pressure?: number;
  state?: string;
  staleHits?: number;
}

interface DataFreshnessSummary {
  degradedSourceCount?: number;
  newestImportAgeSeconds?: number;
  oldestImportAgeSeconds?: number;
  sourceCount?: number;
  warningCount?: number;
}

interface ServiceSummary {
  cache?: CacheSummary;
  dataFreshness?: DataFreshnessSummary;
  enabledSources: string[];
  healthStatus?: string;
  label: string;
  latencyMs: number;
  objectCount?: number;
  serviceId: string;
  sharedCache?: {
    available?: boolean;
    enabled?: boolean;
    errors?: number;
    hitRate?: number;
    state?: string;
  };
  status: OperationsStatus;
  warningCount: number;
  warnings: string[];
}

interface OperationsAlert {
  code: string;
  detail: string;
  serviceId?: string;
  severity: "warning" | "critical";
  title: string;
}

interface ProviderEndpoint {
  baseUrl: string;
  label: string;
  serviceId: string;
}

interface ProviderPayloads {
  health?: Record<string, unknown>;
  observability?: Record<string, unknown>;
}

interface ProviderFetchResult {
  endpoint: ProviderEndpoint;
  error?: string;
  latencyMs: number;
  payloads: ProviderPayloads;
}

export interface OperationsSummary {
  alerts: OperationsAlert[];
  contractVersion: "sim-operations-summary-v1";
  deployment: {
    adapterVersion: string;
    publisherMode: PublisherMode;
    sourceSystemId: string;
  };
  generatedAt: string;
  operationalCheck?: {
    finishedAt?: string;
    status?: string;
    summary?: string;
  };
  publisher: PublisherSnapshot;
  runtime: RuntimeSnapshot;
  scenarios: {
    active: number;
    draft: number;
    paused: number;
    ready: number;
    running: number;
    stopped: number;
    total: number;
  };
  services: ServiceSummary[];
  status: OperationsStatus;
}

export async function buildOperationsSummary(context: OperationsSummaryContext): Promise<OperationsSummary> {
  const runtime = {
    ...context.store.data.runtime,
    queuedEvents: context.publisher.status().queueSize
  } as RuntimeSnapshot;
  const publisher = context.publisher.status();
  const services = await Promise.all(providerEndpoints(context.config).map((endpoint) => fetchProviderSummary(endpoint, context.config)));
  const serviceSummaries = services.map(serviceSummaryFromProviderResult);
  const operationalCheck = await readOperationalCheckSummary(context.config);
  const alerts = [
    ...publisherAlerts(publisher),
    ...serviceSummaries.flatMap(serviceAlerts),
    ...scenarioAlerts(context.store.data.scenarios),
    ...operationalCheckAlerts(operationalCheck)
  ];
  const status = rollupStatus(alerts, serviceSummaries);

  return {
    alerts,
    contractVersion: "sim-operations-summary-v1",
    deployment: {
      adapterVersion: context.config.adapterVersion,
      publisherMode: context.config.publisherMode,
      sourceSystemId: context.config.sourceSystemId
    },
    generatedAt: new Date().toISOString(),
    operationalCheck,
    publisher,
    runtime,
    scenarios: scenarioSummary(context.store.data.scenarios),
    services: serviceSummaries,
    status
  };
}

function providerEndpoints(config: ApiConfig): ProviderEndpoint[] {
  return [
    { baseUrl: config.operationsFlightDataBaseUrl ?? "http://127.0.0.1:4010", label: "Flight Data", serviceId: "flight-data-api" },
    { baseUrl: config.operationsSituationDataBaseUrl ?? "http://127.0.0.1:4020", label: "Situation Data", serviceId: "situation-data-api" },
    { baseUrl: config.operationsSafetyDataBaseUrl ?? "http://127.0.0.1:4030", label: "Safety Data", serviceId: "safety-data-api" },
    { baseUrl: config.operationsTakGatewayBaseUrl ?? "http://127.0.0.1:4040", label: "TAK Gateway", serviceId: "tak-gateway-api" }
  ];
}

async function fetchProviderSummary(endpoint: ProviderEndpoint, config: ApiConfig): Promise<ProviderFetchResult> {
  const startedAt = Date.now();
  const [health, observability] = await Promise.allSettled([
    fetchJson(`${endpoint.baseUrl}/health/ready`, config.operationsProviderTimeoutMs ?? 1500),
    fetchJson(`${endpoint.baseUrl}/api/v1/observability`, config.operationsProviderTimeoutMs ?? 1500)
  ]);
  const latencyMs = Date.now() - startedAt;
  const healthError = health.status === "rejected" ? errorMessage(health.reason) : undefined;
  const observabilityError = observability.status === "rejected" ? errorMessage(observability.reason) : undefined;
  return {
    endpoint,
    error: healthError ?? observabilityError,
    latencyMs,
    payloads: {
      health: health.status === "fulfilled" ? health.value : undefined,
      observability: observability.status === "fulfilled" ? observability.value : undefined
    }
  };
}

async function fetchJson(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function serviceSummaryFromProviderResult(result: ProviderFetchResult): ServiceSummary {
  const health = result.payloads.health;
  const observability = result.payloads.observability;
  const sourceHealth = arrayOfRecords(observability?.sourceHealth);
  const warnings = [
    ...(result.error ? [result.error] : []),
    ...sourceHealth.flatMap((source) => {
      const warningCount = numberValue(source.warningCount) ?? 0;
      const status = stringValue(source.status);
      const sourceId = stringValue(source.sourceId) ?? "source";
      const items: string[] = [];
      if (status && status !== "ok") {
        items.push(`${sourceId} status ${status}`);
      }
      if (warningCount > 0) {
        items.push(`${sourceId} has ${warningCount} quality warning${warningCount === 1 ? "" : "s"}`);
      }
      return items;
    })
  ];
  const healthStatus = stringValue(health?.status);
  const observabilityStatus = stringValue(observability?.status);
  const status = result.error
    ? "critical"
    : healthStatus && healthStatus !== "ok"
      ? result.endpoint.serviceId === "tak-gateway-api" ? "degraded" : "critical"
      : observabilityStatus && observabilityStatus !== "ok"
        ? "degraded"
        : warnings.length > 0
          ? "degraded"
          : "ok";

  return {
    cache: cacheSummary(recordValue(observability?.cache)),
    dataFreshness: dataFreshnessSummary(recordValue(observability?.dataFreshness)),
    enabledSources: arrayOfStrings(health?.enabledSources),
    healthStatus,
    label: result.endpoint.label,
    latencyMs: result.latencyMs,
    objectCount: objectCountFromHealth(health, observability),
    serviceId: result.endpoint.serviceId,
    sharedCache: sharedCacheSummary(recordValue(observability?.sharedCache)),
    status,
    warningCount: warnings.length,
    warnings
  };
}

function cacheSummary(value: Record<string, unknown> | undefined): CacheSummary | undefined {
  if (!value) {
    return undefined;
  }
  return {
    entries: numberValue(value.entries),
    errors: numberValue(value.errors),
    hitRate: numberValue(value.hitRate),
    misses: numberValue(value.misses),
    pressure: numberValue(value.pressure),
    state: stringValue(value.state),
    staleHits: numberValue(value.staleHits)
  };
}

function sharedCacheSummary(value: Record<string, unknown> | undefined): ServiceSummary["sharedCache"] | undefined {
  if (!value) {
    return undefined;
  }
  return {
    available: booleanValue(value.available),
    enabled: booleanValue(value.enabled),
    errors: numberValue(value.errors),
    hitRate: numberValue(value.hitRate),
    state: stringValue(value.state)
  };
}

function dataFreshnessSummary(value: Record<string, unknown> | undefined): DataFreshnessSummary | undefined {
  if (!value) {
    return undefined;
  }
  return {
    degradedSourceCount: numberValue(value.degradedSourceCount),
    newestImportAgeSeconds: numberValue(value.newestImportAgeSeconds),
    oldestImportAgeSeconds: numberValue(value.oldestImportAgeSeconds),
    sourceCount: numberValue(value.sourceCount),
    warningCount: numberValue(value.warningCount)
  };
}

function objectCountFromHealth(health: Record<string, unknown> | undefined, observability: Record<string, unknown> | undefined): number | undefined {
  const sourceHealth = arrayOfRecords(observability?.sourceHealth);
  const sourceObjects = sourceHealth.map((source) => numberValue(source.objectCount) ?? 0).reduce((sum, count) => sum + count, 0);
  return sourceObjects > 0 ? sourceObjects : numberValue(health?.currentEvents);
}

function publisherAlerts(publisher: PublisherSnapshot): OperationsAlert[] {
  const alerts: OperationsAlert[] = [];
  if (publisher.deadLetterSize > 0) {
    alerts.push({
      code: "publisher_dead_letter",
      detail: `${publisher.deadLetterSize} event(s) are in dead-letter state.`,
      severity: "critical",
      title: "Publisher dead-letter queue is not empty"
    });
  }
  if (publisher.queueSize > 0) {
    alerts.push({
      code: "publisher_queue_non_empty",
      detail: `${publisher.queueSize} event(s) are waiting in the publisher queue.`,
      severity: "warning",
      title: "Publisher queue has pending items"
    });
  }
  if (isAfter(publisher.lastFailureAt, publisher.lastSuccessAt)) {
    alerts.push({
      code: "publisher_last_attempt_failed",
      detail: `Last failure ${publisher.lastFailureAt}; last success ${publisher.lastSuccessAt ?? "never"}.`,
      severity: "critical",
      title: "Latest publish attempt failed"
    });
  }
  if (!publisher.publishingEnabled && publisher.mode === "LIVE") {
    alerts.push({
      code: "publisher_live_disabled",
      detail: "Publisher mode is LIVE but publishing is disabled.",
      severity: "critical",
      title: "LIVE publisher is stopped"
    });
  }
  return alerts;
}

function serviceAlerts(service: ServiceSummary): OperationsAlert[] {
  const alerts: OperationsAlert[] = [];
  if (service.status === "critical") {
    alerts.push({
      code: "service_unavailable",
      detail: service.warnings.join("; ") || `${service.label} health is not ok.`,
      serviceId: service.serviceId,
      severity: "critical",
      title: `${service.label} is unavailable`
    });
  } else if (service.status === "degraded") {
    alerts.push({
      code: "service_degraded",
      detail: service.warnings.join("; ") || `${service.label} reports degraded observability.`,
      serviceId: service.serviceId,
      severity: "warning",
      title: `${service.label} is degraded`
    });
  }
  if ((service.cache?.errors ?? 0) > 0) {
    alerts.push({
      code: "cache_errors",
      detail: `${service.cache?.errors} cache error(s) reported.`,
      serviceId: service.serviceId,
      severity: "warning",
      title: `${service.label} cache reports errors`
    });
  }
  if ((service.dataFreshness?.degradedSourceCount ?? 0) > 0 && (service.dataFreshness?.oldestImportAgeSeconds ?? 0) > 7 * 24 * 60 * 60) {
    alerts.push({
      code: "import_stale",
      detail: `Oldest import age is ${service.dataFreshness?.oldestImportAgeSeconds} seconds.`,
      serviceId: service.serviceId,
      severity: "warning",
      title: `${service.label} has stale source data`
    });
  }
  return alerts;
}

function scenarioAlerts(scenarios: Scenario[]): OperationsAlert[] {
  const errored = scenarios.filter((scenario) => scenario.status === "ERROR").length;
  return errored > 0
    ? [
        {
          code: "scenario_error",
          detail: `${errored} scenario(s) are in ERROR state.`,
          severity: "warning",
          title: "Scenario library contains errored scenarios"
        }
      ]
    : [];
}

function operationalCheckAlerts(check: OperationsSummary["operationalCheck"] | undefined): OperationsAlert[] {
  if (!check?.status || check.status === "ok") {
    return [];
  }
  return [
    {
      code: "operational_check_failed",
      detail: check.summary ?? "Latest operational check did not pass.",
      severity: "critical",
      title: "Operational check failed"
    }
  ];
}

async function readOperationalCheckSummary(config: ApiConfig): Promise<OperationsSummary["operationalCheck"] | undefined> {
  if (!config.operationsReportFile) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await readFile(config.operationsReportFile, "utf8")) as Record<string, unknown>;
    return {
      finishedAt: stringValue(parsed.finishedAt),
      status: stringValue(parsed.status),
      summary: stringValue(parsed.summary)
    };
  } catch {
    return undefined;
  }
}

function rollupStatus(alerts: OperationsAlert[], services: ServiceSummary[]): OperationsStatus {
  if (alerts.some((alert) => alert.severity === "critical") || services.some((service) => service.status === "critical")) {
    return "critical";
  }
  if (alerts.length > 0 || services.some((service) => service.status === "degraded")) {
    return "degraded";
  }
  return "ok";
}

function scenarioSummary(scenarios: Scenario[]): OperationsSummary["scenarios"] {
  return {
    active: scenarios.filter((scenario) => scenario.status === "RUNNING" || scenario.status === "PAUSED").length,
    draft: scenarios.filter((scenario) => scenario.status === "DRAFT" || !scenario.status).length,
    paused: scenarios.filter((scenario) => scenario.status === "PAUSED").length,
    ready: scenarios.filter((scenario) => scenario.status === "READY").length,
    running: scenarios.filter((scenario) => scenario.status === "RUNNING").length,
    stopped: scenarios.filter((scenario) => scenario.status === "STOPPED").length,
    total: scenarios.length
  };
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAfter(left: string | undefined, right: string | undefined): boolean {
  if (!left) {
    return false;
  }
  if (!right) {
    return true;
  }
  return Date.parse(left) > Date.parse(right);
}
