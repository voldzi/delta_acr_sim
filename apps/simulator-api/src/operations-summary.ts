import type { PublisherMode, Scenario } from "@csm-sim/contracts";
import { readFile } from "node:fs/promises";
import type { ApiConfig } from "./config.js";
import type { JsonStore } from "./store.js";

type OperationsStatus = "ok" | "degraded" | "critical" | "unknown";
type OperationsAlertCategory = "technical" | "data_quality" | "simulation" | "operational_check";

interface LocalizedText {
  cs: string;
  en: string;
}

interface LocalizedOperatorMessage {
  action?: LocalizedText;
  detail: LocalizedText;
  impact?: LocalizedText;
  title: LocalizedText;
}

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
  qualityWarningCount: number;
  qualityWarnings: ServiceQualityWarning[];
  warningCount: number;
  warnings: string[];
}

interface OperationsAlert {
  action?: string;
  category: OperationsAlertCategory;
  code: string;
  detail: string;
  impact?: string;
  localized: LocalizedOperatorMessage;
  serviceId?: string;
  severity: "info" | "warning" | "critical";
  title: string;
}

interface ServiceQualityWarning {
  action: string;
  code: string;
  detail: string;
  impact: string;
  localized: LocalizedOperatorMessage;
  messages: string[];
  sourceId: string;
  title: string;
  warningCount: number;
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
  const sourceHealth = mergedSourceHealth(health, observability);
  const healthStatus = stringValue(health?.status);
  const observabilityStatus = stringValue(observability?.status);
  const warnings = uniqueStrings([
    ...(result.error ? [result.error] : []),
    ...(healthStatus && healthStatus !== "ok" ? [`health status ${healthStatus}`] : []),
    ...(observabilityStatus && observabilityStatus !== "ok" ? [`observability status ${observabilityStatus}`] : []),
    ...sourceHealth.flatMap((source) => {
      const items: string[] = [];
      if (source.status && source.status !== "ok") {
        items.push(`${source.sourceId} status ${source.status}`);
      }
      return items;
    }),
    ...sourceCacheWarnings(observability)
  ]);
  const qualityWarnings = sourceHealth
    .filter((source) => source.warningCount > 0)
    .map((source) => sourceQualityWarning(source.sourceId, source.warningCount, source.warnings));
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
    qualityWarningCount: qualityWarnings.reduce((sum, warning) => sum + warning.warningCount, 0),
    qualityWarnings,
    warningCount: warnings.length,
    warnings
  };
}

function sourceCacheWarnings(observability: Record<string, unknown> | undefined): string[] {
  return arrayOfRecords(observability?.sourceCaches).flatMap((source) => {
    const sourceId = stringValue(source.sourceId) ?? "source";
    const cache = recordValue(source.cache);
    const state = stringValue(cache?.state);
    const errors = numberValue(cache?.errors) ?? 0;
    const pressure = numberValue(cache?.pressure) ?? 0;
    const warnings: string[] = [];
    if (state && state !== "ok" && state !== "warm") {
      warnings.push(`${sourceId} cache state ${state}`);
    }
    if (errors > 0) {
      warnings.push(`${sourceId} cache has ${errors} error${errors === 1 ? "" : "s"}`);
    }
    if (pressure > 1) {
      warnings.push(`${sourceId} cache pressure ${pressure.toFixed(2)}`);
    }
    return warnings;
  });
}

interface MergedSourceHealth {
  objectCount?: number;
  sourceId: string;
  status?: string;
  warningCount: number;
  warnings: string[];
}

function mergedSourceHealth(
  health: Record<string, unknown> | undefined,
  observability: Record<string, unknown> | undefined
): MergedSourceHealth[] {
  const sources = new Map<string, MergedSourceHealth>();
  const mergeRecord = (record: Record<string, unknown>) => {
    const sourceId = stringValue(record.sourceId) ?? "source";
    const current = sources.get(sourceId) ?? { sourceId, warningCount: 0, warnings: [] };
    const status = stringValue(record.status);
    if (status && (!current.status || current.status === "ok" || status !== "ok")) {
      current.status = status;
    }
    current.objectCount ??= numberValue(record.objectCount);
    const warningMessages = arrayOfStrings(record.warnings);
    current.warnings = uniqueStrings([...current.warnings, ...warningMessages]);
    current.warningCount = Math.max(current.warningCount, numberValue(record.warningCount) ?? warningMessages.length);
    sources.set(sourceId, current);
  };

  arrayOfRecords(observability?.sourceHealth).forEach(mergeRecord);
  arrayOfRecords(health?.sourceHealth).forEach(mergeRecord);
  return [...sources.values()];
}

function sourceQualityWarning(sourceId: string, warningCount: number, messages: string[]): ServiceQualityWarning {
  const messageText = messages.join("; ");
  if (sourceId === "mobile_network_model") {
    return qualityWarning({
      actionCs: "Použijte vrstvu jako situační odhad. Pro potvrzení reálného výpadku je nutné připojit autorizovaný BTS/NOC feed operátora.",
      actionEn: "Use the layer as situational estimate. Connect an authorized operator BTS/NOC feed to confirm real outages.",
      code: "source_quality_mobile_network_inferred",
      detailCs: "mobile_network_model kombinuje veřejná měření, model pokrytí, DEM a infrastrukturní indicie. SIM zatím nemá autorizovaný live BTS/NOC stav od operátorů.",
      detailEn: "mobile_network_model combines public measurements, coverage modelling, DEM and infrastructure hints. SIM does not yet have an authorized live BTS/NOC operator status feed.",
      impactCs: "COP může zobrazit kvalitu a dostupnost signálu jako odhad. Nesmí to být interpretováno jako potvrzený výpadek BTS nebo aktuální stav operátora.",
      impactEn: "COP can display signal quality and availability as an estimate. It must not be interpreted as confirmed BTS outage or current operator state.",
      messages,
      sourceId,
      titleCs: "Vyhodnocení mobilní sítě je odhad",
      titleEn: "Mobile network assessment is inferred",
      warningCount
    });
  }
  if (sourceId === "ctu_stationary_mobile") {
    return qualityWarning({
      actionCs: "Používejte pro dlouhodobý kontext kvality signálu. Aktuální stav ověřujte přes live zdroj operátora, pokud bude napojen.",
      actionEn: "Use it for long-term signal quality context. Verify current state through a live operator feed when connected.",
      code: "source_quality_ctu_stationary_historical",
      detailCs: "ctu_stationary_mobile obsahuje oficiální historická měření ČTÚ. Stáří importu může být z principu vysoké a neznamená výpadek SIM.",
      detailEn: "ctu_stationary_mobile contains official historical CTU measurements. Import age can be high by design and does not mean SIM is failing.",
      impactCs: "Vrstva pomáhá s plánováním a odhadem pokrytí, ale neříká, zda BTS právě běží, neběží nebo má poruchu.",
      impactEn: "The layer helps with planning and coverage estimate, but it does not say whether a BTS is currently up, down or faulty.",
      messages,
      sourceId,
      titleCs: "Stacionární měření ČTÚ jsou historická",
      titleEn: "CTU stationary mobile measurements are historical",
      warningCount
    });
  }
  return qualityWarning({
    actionCs: "Před operační interpretací zkontrolujte detail zdroje a jeho poznámky.",
    actionEn: "Review the source detail and notes before operational interpretation.",
    code: "source_quality_notice",
    detailCs: messageText || `${sourceId} hlásí ${warningCount} datové upozornění.`,
    detailEn: messageText || `${sourceId} reports ${warningCount} data quality notice(s).`,
    impactCs: "Zdroj je technicky dostupný, ale jeho data mají omezení, která musí operátor znát.",
    impactEn: "The source is technically available, but its data has limitations the operator must understand.",
    messages,
    sourceId,
    titleCs: "Zdroj má datové upozornění",
    titleEn: "Source has data quality notice",
    warningCount
  });
}

function qualityWarning(input: {
  actionCs: string;
  actionEn: string;
  code: string;
  detailCs: string;
  detailEn: string;
  impactCs: string;
  impactEn: string;
  messages: string[];
  sourceId: string;
  titleCs: string;
  titleEn: string;
  warningCount: number;
}): ServiceQualityWarning {
  return {
    action: input.actionEn,
    code: input.code,
    detail: input.detailEn,
    impact: input.impactEn,
    localized: localizedMessage(input.titleCs, input.titleEn, input.detailCs, input.detailEn, input.impactCs, input.impactEn, input.actionCs, input.actionEn),
    messages: input.messages,
    sourceId: input.sourceId,
    title: input.titleEn,
    warningCount: input.warningCount
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
      ...alertMessage({
        actionCs: "Zkontrolujte dead-letter položky, chybové odpovědi COP a znovu publikujte jen validní události.",
        actionEn: "Inspect dead-letter items, COP error responses and republish only valid events.",
        detailCs: `${publisher.deadLetterSize} událost(i) jsou ve stavu dead-letter.`,
        detailEn: `${publisher.deadLetterSize} event(s) are in dead-letter state.`,
        impactCs: "Část syntetických událostí nebyla doručena do COP.",
        impactEn: "Some synthetic events were not delivered to COP.",
        titleCs: "Dead-letter fronta publisheru není prázdná",
        titleEn: "Publisher dead-letter queue is not empty"
      }),
      category: "technical",
      code: "publisher_dead_letter",
      severity: "critical"
    });
  }
  if (publisher.queueSize > 0) {
    alerts.push({
      ...alertMessage({
        actionCs: "Zkontrolujte stav publisheru a doručovací frontu. Pokud fronta roste, otestujte spojení do COP.",
        actionEn: "Check publisher state and delivery queue. If the queue grows, test the COP connection.",
        detailCs: `${publisher.queueSize} událost(i) čekají ve frontě publisheru.`,
        detailEn: `${publisher.queueSize} event(s) are waiting in the publisher queue.`,
        impactCs: "COP nemusí okamžitě vidět poslední syntetické stopy.",
        impactEn: "COP may not immediately see the latest synthetic tracks.",
        titleCs: "Publisher má čekající položky",
        titleEn: "Publisher queue has pending items"
      }),
      category: "technical",
      code: "publisher_queue_non_empty",
      severity: "warning"
    });
  }
  if (isAfter(publisher.lastFailureAt, publisher.lastSuccessAt)) {
    alerts.push({
      ...alertMessage({
        actionCs: "Ověřte konfiguraci COP endpointu, autentizaci a poslední chybovou odpověď.",
        actionEn: "Verify COP endpoint configuration, authentication and the latest error response.",
        detailCs: `Poslední selhání ${publisher.lastFailureAt}; poslední úspěch ${publisher.lastSuccessAt ?? "nikdy"}.`,
        detailEn: `Last failure ${publisher.lastFailureAt}; last success ${publisher.lastSuccessAt ?? "never"}.`,
        impactCs: "Poslední pokus o doručení do COP selhal.",
        impactEn: "The latest delivery attempt to COP failed.",
        titleCs: "Poslední pokus o publikování selhal",
        titleEn: "Latest publish attempt failed"
      }),
      category: "technical",
      code: "publisher_last_attempt_failed",
      severity: "critical"
    });
  }
  if (!publisher.publishingEnabled && publisher.mode === "LIVE") {
    alerts.push({
      ...alertMessage({
        actionCs: "Zapněte publisher nebo přepněte režim mimo LIVE, pokud má být doručování zastavené záměrně.",
        actionEn: "Enable the publisher or leave LIVE mode if delivery is intentionally stopped.",
        detailCs: "Publisher je v režimu LIVE, ale publikování je vypnuté.",
        detailEn: "Publisher mode is LIVE but publishing is disabled.",
        impactCs: "SIM nebude doručovat živé syntetické události do COP.",
        impactEn: "SIM will not deliver live synthetic events to COP.",
        titleCs: "LIVE publisher je zastavený",
        titleEn: "LIVE publisher is stopped"
      }),
      category: "technical",
      code: "publisher_live_disabled",
      severity: "critical"
    });
  }
  return alerts;
}

function serviceAlerts(service: ServiceSummary): OperationsAlert[] {
  const alerts: OperationsAlert[] = [];
  if (service.status === "critical") {
    alerts.push({
      ...alertMessage({
        actionCs: `Zkontrolujte health endpoint, logy služby ${service.label} a dostupnost jejích upstreamů.`,
        actionEn: `Check the health endpoint, ${service.label} logs and upstream availability.`,
        detailCs: serviceWarningsDetail(service, "cs") || `${serviceLabelCs(service)} health není v pořádku.`,
        detailEn: serviceWarningsDetail(service, "en") || `${service.label} health is not ok.`,
        impactCs: `${serviceLabelCs(service)} nemusí poskytovat data pro COP.`,
        impactEn: `${service.label} may not provide data to COP.`,
        titleCs: `${serviceLabelCs(service)} je nedostupná`,
        titleEn: `${service.label} is unavailable`
      }),
      category: "technical",
      code: "service_unavailable",
      serviceId: service.serviceId,
      severity: "critical"
    });
  } else if (service.status === "degraded") {
    alerts.push({
      ...alertMessage({
        actionCs: `Zkontrolujte observability služby ${service.label}; pokud jde o plánovaně omezený zdroj, ponechte technický stav oddělený od datového upozornění.`,
        actionEn: `Check ${service.label} observability; if this is an intentionally limited source, keep technical state separate from data-quality notices.`,
        detailCs: serviceWarningsDetail(service, "cs") || `${serviceLabelCs(service)} hlásí zhoršenou observability.`,
        detailEn: serviceWarningsDetail(service, "en") || `${service.label} reports degraded observability.`,
        impactCs: `${serviceLabelCs(service)} obsluhuje provoz, ale část provider cesty není plně zdravá.`,
        impactEn: `${service.label} is serving, but part of the provider path is not fully healthy.`,
        titleCs: `${serviceLabelCs(service)} je degradovaná`,
        titleEn: `${service.label} is degraded`
      }),
      category: "technical",
      code: "service_degraded",
      serviceId: service.serviceId,
      severity: "warning"
    });
  }
  for (const warning of service.qualityWarnings) {
    alerts.push({
      action: warning.action,
      category: "data_quality",
      code: warning.code,
      detail: warning.detail,
      impact: warning.impact,
      localized: warning.localized,
      serviceId: service.serviceId,
      severity: "info",
      title: warning.title
    });
  }
  if ((service.cache?.errors ?? 0) > 0) {
    alerts.push({
      ...alertMessage({
        actionCs: "Zkontrolujte cache backend a logy služby. Pokud chyby pokračují, snižuje se ochrana proti výpadkům upstreamu.",
        actionEn: "Check cache backend and service logs. If errors continue, protection against upstream outages is reduced.",
        detailCs: `${service.cache?.errors} chyb cache hlášeno.`,
        detailEn: `${service.cache?.errors} cache error(s) reported.`,
        impactCs: `${serviceLabelCs(service)} může častěji dotazovat upstream nebo vracet méně stabilní data.`,
        impactEn: `${service.label} may call upstream more often or return less stable data.`,
        titleCs: `${serviceLabelCs(service)} hlásí chyby cache`,
        titleEn: `${service.label} cache reports errors`
      }),
      category: "technical",
      code: "cache_errors",
      serviceId: service.serviceId,
      severity: "warning"
    });
  }
  if ((service.dataFreshness?.degradedSourceCount ?? 0) > 0 && (service.dataFreshness?.oldestImportAgeSeconds ?? 0) > 7 * 24 * 60 * 60) {
    alerts.push({
      ...alertMessage({
        actionCs: "Ověřte plán importu a dostupnost zdroje. Pokud je zdroj historický z principu, měl by být uveden jako datové upozornění, ne technická porucha.",
        actionEn: "Verify import schedule and source availability. If the source is historical by design, it should be represented as a data-quality notice, not a technical failure.",
        detailCs: `Nejstarší import je starý ${service.dataFreshness?.oldestImportAgeSeconds} sekund.`,
        detailEn: `Oldest import age is ${service.dataFreshness?.oldestImportAgeSeconds} seconds.`,
        impactCs: `${serviceLabelCs(service)} může obsahovat zastaralá data ze zdrojů, které měly být obnoveny.`,
        impactEn: `${service.label} may contain stale data from sources that should have refreshed.`,
        titleCs: `${serviceLabelCs(service)} má zastaralá zdrojová data`,
        titleEn: `${service.label} has stale source data`
      }),
      category: "technical",
      code: "import_stale",
      serviceId: service.serviceId,
      severity: "warning"
    });
  }
  return alerts;
}

function scenarioAlerts(scenarios: Scenario[]): OperationsAlert[] {
  const errored = scenarios.filter((scenario) => scenario.status === "ERROR").length;
  return errored > 0
    ? [
        {
          ...alertMessage({
            actionCs: "Otevřete knihovnu scénářů, opravte validaci nebo scénáře vyřaďte ze spuštění.",
            actionEn: "Open the scenario library, fix validation or remove the scenarios from execution.",
            detailCs: `${errored} scénář(ů) je ve stavu ERROR.`,
            detailEn: `${errored} scenario(s) are in ERROR state.`,
            impactCs: "Operátor může omylem pracovat se scénářem, který nepůjde spustit.",
            impactEn: "The operator may work with a scenario that cannot be started.",
            titleCs: "Knihovna scénářů obsahuje chybové scénáře",
            titleEn: "Scenario library contains errored scenarios"
          }),
          category: "simulation",
          code: "scenario_error",
          severity: "warning"
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
      ...alertMessage({
        actionCs: "Otevřete poslední provozní test a opravte selhanou kontrolu před vystavením služby operátorům.",
        actionEn: "Open the latest operational test and fix the failed check before exposing the service to operators.",
        detailCs: check.summary ?? "Poslední provozní kontrola neprošla.",
        detailEn: check.summary ?? "Latest operational check did not pass.",
        impactCs: "Nelze potvrdit, že produkční cesta SIM funguje end-to-end.",
        impactEn: "SIM production path cannot be confirmed end-to-end.",
        titleCs: "Provozní kontrola selhala",
        titleEn: "Operational check failed"
      }),
      category: "operational_check",
      code: "operational_check_failed",
      severity: "critical"
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
  if (alerts.some((alert) => alert.severity === "warning") || services.some((service) => service.status === "degraded")) {
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

function alertMessage(input: {
  actionCs?: string;
  actionEn?: string;
  detailCs: string;
  detailEn: string;
  impactCs?: string;
  impactEn?: string;
  titleCs: string;
  titleEn: string;
}): Pick<OperationsAlert, "action" | "detail" | "impact" | "localized" | "title"> {
  return {
    action: input.actionEn,
    detail: input.detailEn,
    impact: input.impactEn,
    localized: localizedMessage(input.titleCs, input.titleEn, input.detailCs, input.detailEn, input.impactCs, input.impactEn, input.actionCs, input.actionEn),
    title: input.titleEn
  };
}

function localizedMessage(
  titleCs: string,
  titleEn: string,
  detailCs: string,
  detailEn: string,
  impactCs?: string,
  impactEn?: string,
  actionCs?: string,
  actionEn?: string
): LocalizedOperatorMessage {
  return {
    action: actionCs || actionEn ? { cs: actionCs ?? actionEn ?? "", en: actionEn ?? actionCs ?? "" } : undefined,
    detail: { cs: detailCs, en: detailEn },
    impact: impactCs || impactEn ? { cs: impactCs ?? impactEn ?? "", en: impactEn ?? impactCs ?? "" } : undefined,
    title: { cs: titleCs, en: titleEn }
  };
}

function serviceLabelCs(service: ServiceSummary): string {
  switch (service.serviceId) {
    case "flight-data-api":
      return "Letová data";
    case "situation-data-api":
      return "Situační data";
    case "safety-data-api":
      return "Bezpečnostní data";
    case "tak-gateway-api":
      return "TAK Gateway";
    default:
      return service.label;
  }
}

function serviceWarningsDetail(service: ServiceSummary, language: "cs" | "en"): string {
  if (service.warnings.length === 0) {
    return "";
  }
  return service.warnings.map((warning) => (language === "cs" ? localizeTechnicalWarningCs(warning) : warning)).join("; ");
}

function localizeTechnicalWarningCs(warning: string): string {
  if (warning === "The operation was aborted due to timeout") {
    return "operace byla ukončena kvůli timeoutu";
  }
  const healthStatus = warning.match(/^health status (.+)$/);
  if (healthStatus?.[1]) {
    return `health stav ${localizeStatusCs(healthStatus[1])}`;
  }
  const observabilityStatus = warning.match(/^observability status (.+)$/);
  if (observabilityStatus?.[1]) {
    return `observability stav ${localizeStatusCs(observabilityStatus[1])}`;
  }
  const sourceStatus = warning.match(/^(.+) status (.+)$/);
  if (sourceStatus?.[1] && sourceStatus[2]) {
    return `${sourceStatus[1]} stav ${localizeStatusCs(sourceStatus[2])}`;
  }
  const cacheState = warning.match(/^(.+) cache state (.+)$/);
  if (cacheState?.[1] && cacheState[2]) {
    return `${cacheState[1]} cache stav ${localizeStatusCs(cacheState[2])}`;
  }
  const cacheErrors = warning.match(/^(.+) cache has ([0-9]+) errors?$/);
  if (cacheErrors) {
    return `${cacheErrors[1]} cache hlásí ${cacheErrors[2]} chyb`;
  }
  const cachePressure = warning.match(/^(.+) cache pressure ([0-9.]+)$/);
  if (cachePressure) {
    return `${cachePressure[1]} cache tlak ${cachePressure[2]}`;
  }
  return warning;
}

function localizeStatusCs(status: string): string {
  switch (status) {
    case "critical":
      return "kritický";
    case "degraded":
      return "degradovaný";
    case "failed":
      return "selhal";
    case "ok":
      return "v pořádku";
    case "warm":
      return "zahřátý";
    default:
      return status;
  }
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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
